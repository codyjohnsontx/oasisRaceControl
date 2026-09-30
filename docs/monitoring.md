# Rig monitor

The rig monitor watches every sim rig from the heartbeat its agent sends once a
minute and posts to the venue's Discord channel when something is wrong: once
when a problem starts, once when it clears, and nothing in between. All the
judgement is on the server - the rig only reports what it already knows, so
iRacing keeps its frames.

The code is `apps/web/src/lib/monitor/`. The rules are one pure module,
`rules.ts`, which the staff Rig health page will call on the same snapshot the
alerts use, so a tile and the channel can never disagree.

## When it runs

Nothing runs on a timer inside Vercel: Hobby's cron runs at most once a day.
An evaluation runs

- **after every rig heartbeat**, once the rig has had its answer (Next's
  `after()`), so a healthy rig is what notices a silent one; and
- **on every `GET /api/monitor/tick`**, which an outside clock calls once a
  minute (below), so a venue whose every rig went dark is still noticed.

However many of those arrive, at most one evaluation runs every 20 seconds
(`monitor_state.last_evaluated_at`), and never two at once: an evaluation
claims, reads and applies its alert changes in one short transaction holding
that row's lock, so one that reads later always applies later. It commits
before posting anything, so a slow Discord never holds the others up.

## The rules so far

Numbers are the approved monitoring plan's. **Urgent** posts red and
@mentions the owner; **warning** posts yellow and quietly.

| # | Rule | Fires when | Clears when | Severity |
|---|---|---|---|---|
| 1 | Rig silent | no word from a rig for 2 min, and its agent did not say goodbye | the rig is heard again | urgent with a driver seated; otherwise a warning after 7 min (below) |
| 1 | Every rig went quiet | two or more empty rigs went quiet within 5 min of each other and none is left running | 7 min after the first rig is heard again (by heartbeat or by laps), time enough for the rest's backed-off heartbeats. A rig not heard since before the first one came back stays dark without a warning of its own - still switched off after a close, or not yet back - until it is heard again (after which it alerts as usual) or 12 h pass; a seated one still alerts at once | warning, one note instead of one per rig. The plan's "outside event mode" qualifier arrives with event mode in PR 4; until then the note applies in every mode |
| 2 | iRacing not connected while a driver is signed in | a seated rig's agent has reported iRacing disconnected for 3 min (counted from when the driver sat down) | iRacing connects, or the stint ends | urgent |
| 3a | Laps queued but not reaching the site | a lap has waited over 2 min while at least two heartbeats got through | the queue drains | urgent |
| 3b | Laps refused by the site | the rig holds parked (refused) laps | a person un-parks them (count back to 0); every rise in the count posts again | urgent |
| 5a | Laps with nobody signed in | 2 laps inside 10 min that the agent said nobody was signed in for, since the rig's last lap that reached a driver | a lap reaches a driver, or 15 min pass without another | warning; urgent in event mode |
| 5b | Unusually long stint | a driver has been signed in longer than `monitor_state.long_stint_minutes` (2 h unless staff change it) | the stint ends | warning |
| 6 | Repeated sign-in failures | 3 walk-up sign-ins refused on one rig inside 5 min; the message names the kinds (wrong PIN or name, locked out, ...) | 10 min without one | warning |
| 7 | Wrong car or track | today has a featured combo, and a seated rig's iRacing session is on another car or track, or the rig's last 3 laps inside 15 min were all refused for the combo | the session matches, or a valid lap lands | warning; urgent in event mode |
| 10 | Rig agent restarting repeatedly | 3 agent starts within 15 min | the starts age out of the 15 min | urgent |
| 11 | Outdated rig agent | the rig reports an agent build other than `CURRENT_AGENT_VERSION` | it reports the current build | warning |
| 12 | Rig clock is off | the rig's clock is over 5 min from the server's | under 2 min | urgent |
| 13 | Driver moved rigs mid-session | a driver signed in on another rig, and within 10 min the rig they left, with nobody signed in, is still in an iRacing session | 10 min after the move | warning |
| 14 | Implausibly fast lap | a valid lap over 3% under the best any other driver had on that car and track before it, once 5 other drivers have one | never announced: the alert closes quietly once the lap is 15 min old | warning |
| 15 | Lap reading stopped | the agent says its iRacing reader faulted | the agent restarts without the fault | urgent |
| 16 | Sign-out not saved | the agent could not save a sign-out | it is saved | warning |
| 17 | iRacing build missing variables | iRacing does not publish a variable the agent reads | an attached iRacing publishes them all | warning |
| 18 | Rig agent footprint high | over 150 MB, or over 2% of a core for 5 min | back under both (once open, any CPU over 2% holds it) | warning |

Details worth knowing:

- **One blip is not silence.** The agent heartbeats every 60 s and retries a
  failed one 10 s later under a 15 s timeout, so one lost heartbeat leaves a
  gap of about 90 s. Two in a row cross the 2 minutes.
- **A goodbye is final for that process.** Every clean exit sends a goodbye,
  and a rig that said goodbye is never "silent". An ordinary heartbeat that
  was already on the wire can land after the goodbye; the monitor orders a
  process's heartbeats by the agent's own sequence number (and when it was
  sent), not by when they arrived, so that late heartbeat cannot undo the
  goodbye (`rigState` in `rig-state.ts`).
- **An empty rig going quiet waits 5 more minutes** before warning, because
  that is usually the first rig of a closing. If the rest follow, one note
  replaces the per-rig warnings. A rig with a driver in it never waits.
- **Recovery needs two evaluations in a row** without the problem, so one
  evaluation that misses a condition does not post "recovered".
- **Rules 3a, 3b and 10 hold through a goodbye** - closing the agent does not
  deliver its laps, and a restart loop says goodbye on every cycle.
- **Rules 12, 17 and 18 describe the rig, not the agent process**, so an alert
  already open stays open through a goodbye and clears only on a heartbeat
  from a running agent that no longer shows the problem; a goodbye never opens
  one. A rig with a dead clock battery is not re-announced on every reboot.
  Rule 17 is judged only on heartbeats sent while iRacing was attached, since
  the agent forgets what iRacing publishes whenever iRacing goes; with none in
  view an open alert holds. The rest are about a running agent and stop at
  goodbye.
- **Event mode raises rules 5a and 7 to urgent.** Event mode itself arrives
  with plan PR 4; until then it is off everywhere (`inEventMode` in
  `rules.ts` is the one place that reads it), so both stay warnings.
- **Rules 5a, 5b, 7 (its laps half) and 14 need nothing new from the rig**:
  they read laps, stints and today's combo, so they work for an agent too old
  to send more than its version. Rule 7's session half, rule 6 and rule 13
  (which needs the rig it left to report the sim in a session) need
  `rig-agent/0.4-monitor`.
- **Rule 7 judges the combo exactly as ingestion does** (`comboMismatch` in
  `validity.ts`), so it never calls a session right whose laps will be
  refused. Its message names today's combo and which part is wrong, never the
  rig's own session strings.
- **Rule 11's version is `CURRENT_AGENT_VERSION`** in
  `src/lib/monitor/agent-version.ts`, a copy of `AgentVersion` in
  `apps/rig-agent/OasisRigAgent.Core/AgentConfig.cs` that
  `agent-version.test.ts` keeps equal. Bump both in the agent's release
  commit: from its deploy on, every rig still on the old build shows a quiet
  warning until the new exe is installed. A rig not heard from in 12 h is
  off, not outdated, and is not warned about. It fires once per rig, not per
  version: a rig moved from one old build to another keeps its open alert.
- **Rule 13 is the move, not two stints at once.** A driver cannot hold two
  stints: `one_open_assignment_per_driver` in `0001_core_schema.sql` forbids
  it, and signing in on a second rig ends the first with `end_reason =
  'moved'`. What goes wrong is the rig left behind: whoever is still driving
  it is now signed in as nobody.
- **Rule 14 never changes a lap.** It flags the lap for staff to look at;
  validity is decided once, at ingestion, and a flagged lap ranks until staff
  invalidate it by hand. Each lap is its own alert, compared only with laps
  stored before it, so a later lap never changes the verdict on an earlier
  one.
- **A driver is named in an alert only while their account is active.** A
  name under review (or a banned driver) reads "a driver (name under review)",
  in Discord and in `monitor_alerts`, as the public leaderboard hides them.

## Flapping

An alert that opens for the fourth time on the same rule and rig within an
hour - three re-fires after the first - is flapping. Instead of itself it
posts one quiet line, `🔕 Flapping: <rule> - <rig> has fired 4 times in the
last hour; muted for 1 h`, and for the hour after that line nothing on that
rule and rig is posted: no openings, recoveries, rises or AI diagnosis. The
alerts are still stored (`monitor_alerts.refire_count` counts each one's
earlier openings in the hour) and still open while the problem lasts, so the
Rig health page shows them. Once the hour has passed the rule posts normally
again; if it is still flapping, the next mute line says so.

## Discord

| Variable | What it is |
|---|---|
| `DISCORD_WEBHOOK_URL` | the channel's webhook URL. Without it nothing is posted - messages are logged instead - so a preview or a laptop never posts to the venue |
| `DISCORD_ALERT_USER_ID` | the owner's Discord user id (User Settings > Advanced > Developer Mode, then right-click your name > Copy User ID). Urgent alerts @mention it; warnings never mention anyone |

Set both in Vercel for **Production only**. The webhook URL is a credential:
it lives there and nowhere in the repository.

A post that fails (Discord down, rate-limited) is retried by a later
evaluation, no sooner than a minute after the last attempt, until an hour
after the alert opened (or its count last rose) - however long the problem
itself lasts - and never by two evaluations at once. An alert that came and
went while Discord was down posts its opening late and then its recovery,
never a lone "recovered".

One tradeoff cannot be designed away: a post that times out may still have
reached Discord, and Discord gives the monitor no way to ask. The monitor
treats it as failed and retries, so on a slow Discord the same alert can
appear more than once - at most once a minute, and never after that hour.
Counting a timeout as delivered instead would risk an alert nobody ever saw.

## AI diagnosis and the copy-paste handoff

An **urgent** alert is followed by two more messages, both quiet:

1. **Likely cause** - a purple embed with the model's summary and the change
   it suggests, titled with the provider and its confidence.
2. **The handoff** - one fenced block to copy and paste into the coding
   harness: the rule, the rig, when it opened, the deployed commit, the last
   three heartbeats, the agent's recent notices, and the model's likely cause,
   suggested change and where to look. The frame is fixed text the monitor
   fills in (`handoff.ts`); the model only writes those three lines.

The alert itself always goes first and never waits for the model, and the
tick answers its clock before the model is called: the diagnosis runs in
`after()` once the evaluation has answered (`runDiagnoses` in `run.ts`). A call
that fails or takes over 20 s leaves a retry marker, and an evaluation at
least a minute later tries once more; if that fails too, the handoff is
posted anyway with "no diagnosis" in place of the model's lines. Nothing is
diagnosed twice, and a post Discord refused is retried like an alert's.

**Nothing a rig typed leaves.** A heartbeat's strings - session names,
agent notices, variable names - are whatever the rig, or anyone holding its
token, sent, and no filter can promise they hold no name, address, path or
instruction. So the prompt and the handoff carry only what the server can
vouch for (`diagnosis/context.ts`): the heartbeats' numbers, true/false
flags and enum values; the agent version only when it has a version's
shape; agent notices only as codes of the notices the agent is known to
raise, counted, with a fixed summary; and the alert's own words - the rule,
the rig's name and the headline and numbers the rules wrote, with the seated
driver's name replaced by `driver-<4 hex>`. The alert message above still
names the driver, as it always has: that is the staff channel.

**The handoff keeps its shape.** The model read rig data, so its answer is
treated as untrusted too: the prompt marks the incident as data, never
instructions; every field of the answer is flattened to one line with links,
mentions, code fences and the handoff's own labels (such as `Rules:`)
neutralized; and `whereToLook` can only name the repository paths listed in
the prompt. The handoff ends with its one `Rules:` line, which
the length clip never cuts, and labels the model's three lines AI.

| Variable | What it is |
|---|---|
| `GEMINI_API_KEY` | a free key from [AI Studio](https://aistudio.google.com) > Get API key. Without it there is no diagnosis and no handoff; alerts post as before |
| `DIAGNOSIS_PROVIDER` | `gemini` (default), `anthropic`, or `off` |
| `ANTHROPIC_API_KEY` | only with `DIAGNOSIS_PROVIDER=anthropic` |
| `DIAGNOSIS_MODEL` | optional; defaults to `gemini-2.5-flash`, or `claude-haiku-4-5-20251001` for `anthropic`. It names a model of the chosen provider, so clear it when switching |

Production only, like the webhook. Google may use free-tier prompts to
improve its products, which is why the allowlist above is not optional.

## The outside clock

`GET /api/monitor/tick` evaluates and answers
`{"status":"ok","evaluated":true,"activeAlerts":0}`, or 503 in about two
seconds when the database is down. It needs the header
`Authorization: Bearer <CRON_SECRET>`; without `CRON_SECRET` set it refuses
everything.

1. Generate a secret: `openssl rand -base64 32`. Add it in Vercel as
   `CRON_SECRET` (Production) and redeploy.
2. On [cron-job.org](https://cron-job.org) (free), create two jobs on
   `https://oasis-race-control.vercel.app/api/monitor/tick`, timezone
   America/Chicago, each with the header `Authorization: Bearer <the secret>`:
   one every minute from 08:00 to 23:59, one every 30 minutes from 00:00 to
   07:59. Overnight is sparse on purpose: a tick every minute all night keeps
   Neon Free awake and spends its monthly compute hours.
3. Check: `curl -H "Authorization: Bearer <the secret>" https://oasis-race-control.vercel.app/api/monitor/tick`.

`CRON_SECRET` is the name Vercel's own cron sends, so moving the clock to a
Vercel cron on Pro needs no code change.

An uptime check that cannot send a header (UptimeRobot's free plan) should
watch `/api/ready` instead: it is public and answers 503 when the database is
down, which is what that check is for.

## Alert state

`monitor_alerts` holds one row per alert, forever (they are small, and they
are the history). `monitor_alerts_one_open`, a partial unique index on
`(rule, subject) where resolved_at is null`, is what makes "fires once" hold
when two evaluations run at once. The migration and its hand-apply steps are
`db/migrations/0006_monitor.sql` and
[deploy.md](./deploy.md#applying-0006_monitorsql).

Heartbeats are kept seven days; an evaluation prunes older ones at most once
a day.
