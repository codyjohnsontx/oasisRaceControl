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
| 5b | Unusually long stint | a driver has been signed in longer than `monitor_state.long_stint_minutes` (2 h unless staff change it), on a rig that is switched on and reporting | the stint ends | warning |
| 6 | Repeated sign-in failures | 3 walk-up sign-ins refused on one rig inside 5 min; the message names the kinds (wrong PIN or name, locked out, ...). Needs `rig-agent/0.5-monitor` (below) | 10 min without one | warning |
| 7 | Wrong car or track | today has a featured combo, and a seated rig's iRacing session is on another car or track, or the rig's last 3 laps inside 15 min were all refused for the combo | the session matches, or a valid lap lands - whichever of the two signals was heard last decides | warning; urgent in event mode |
| 10 | Rig agent restarting repeatedly | 3 agent starts within 15 min | the starts age out of the 15 min | urgent |
| 11 | Outdated rig agent | a rig that is switched on and reporting runs an agent build other than `CURRENT_AGENT_VERSION` | it reports the current build | warning, once per rig per version |
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
  `rules.ts` is the one place that reads it), so both stay warnings. An
  alert already open follows the mode: a warning that becomes urgent is
  announced once more, with the mention (held to the end of a flapping mute
  if it is muted), and an urgent one that becomes a warning changes quietly -
  a post that had not got through yet goes out as a warning, without the
  mention or a diagnosis. One function, `moveSeverity` in `store.ts`, makes
  that move for every rule.
- **Rules 5a, 5b, 7 (its laps half) and 14 need nothing new from the rig**:
  they read laps, stints and today's combo, so they work for an agent too old
  to send more than its version. Rule 7's session half and rule 13 (which
  needs the rig it left to report the sim in a session) need
  `rig-agent/0.4-monitor` or later; rule 6 needs `rig-agent/0.5-monitor`.
- **Rule 7 judges the combo exactly as ingestion does** (`comboMismatch` in
  `validity.ts`), so it never calls a session right whose laps will be
  refused. Its message names today's combo and which part is wrong, never the
  rig's own session strings. Its two inputs are signals at the moment each was
  heard - a wrong session at its heartbeat while a driver is seated, the
  last right session the rig reported (only when its current session, by
  send order, is not a wrong one), a run of 3 refused laps at the last
  of them, a valid lap at its arrival - and the newest decides, so putting
  the car right clears the alert at the next heartbeat even with the refused
  laps still in view, it stays clear when the driver then signs out or quits
  iRacing, and a wrong session heard after a valid lap opens it again. Like
  rule 5b it opens only on a live rig, so a switched-off rig's refused laps
  cannot reopen it when staff change today's combo; an open alert holds.
- **Rule 11's version is `CURRENT_AGENT_VERSION`** in
  `src/lib/monitor/agent-version.ts`, a copy of `AgentVersion` in
  `apps/rig-agent/OasisRigAgent.Core/AgentConfig.cs` that
  `agent-version.test.ts` keeps equal. Bump both in the agent's release
  commit: from its deploy on, every rig still on the old build shows a quiet
  warning until the new exe is installed. It fires once per rig per version:
  the alert's subject names `CURRENT_AGENT_VERSION`, so a new release opens a
  fresh alert naming it, while the one naming the earlier release stays open
  until the rig reports the current build.
- **Rules 5b and 11 open only on a rig that is switched on and reporting** -
  heard in the last 2 min, and not after a goodbye - so a rig that went dark
  with the venue stays quiet until it is switched on again: a stint left open
  at closing, or a release made after closing, posts nothing overnight. An
  alert already open holds through a goodbye or a silence.
- **Rule 6 counts each refusal once.** A heartbeat reports every refusal the
  site has not acknowledged, so after a lost answer the next one reports the
  same refusals again. `rig-agent/0.5-monitor` and later send each refusal's own
  sequence number (`signInFailureSeqs`), and the monitor counts each once per
  agent process. A heartbeat without them - `rig-agent/0.4-monitor` and older
  - is still stored but does not feed rule 6 at all, since a replayed count
  cannot be told from new refusals; rule 11 already asks for the upgrade.
- **Rule 13 is the move, not two stints at once.** A driver cannot hold two
  stints: `one_open_assignment_per_driver` in `0001_core_schema.sql` forbids
  it, and signing in on a second rig ends the first with `end_reason =
  'moved'`. What goes wrong is the rig left behind: whoever is still driving
  it is now signed in as nobody.
- **Rule 14 never changes a lap.** It flags the lap for staff to look at;
  validity is decided once, at ingestion, and a flagged lap ranks until staff
  invalidate it by hand. Each lap is its own alert (subject
  `rig:<id>|lap:<id>`), compared only with laps stored before it, so a later
  lap never changes the verdict on an earlier one. The laps of one rig flap
  together, so a run of them on a bad rig is muted like any flapping rule,
  and when that mute ends one quiet summary lists every lap flagged in it
  (see [Flapping](#flapping)).
- **A driver is named in an alert only while their account is active.** A
  name under review (or a banned driver) reads "a driver (name under review)",
  in Discord and in `monitor_alerts`, as the public leaderboard hides them.

## Flapping

An alert that opens for the fourth time on the same rule and rig within an
hour - three re-fires after the first - is flapping. "Rig" is the part of the
alert's subject before its first `|` (`flapScope` in `rules.ts`), so rule
14's per-lap alerts and rule 11's per-build ones count together for their
rig. Instead of itself it
posts one quiet line, `🔕 Flapping: <rule> - <rig> has fired 4 times in the
last hour; muted for 1 h`, and for the hour after that line nothing on that
rule and rig is posted: no openings, recoveries, rises or AI diagnosis. The
alerts are still stored (`monitor_alerts.refire_count` counts each one's
earlier openings in the hour, and is at least 3 for one opened inside a
mute) and still open while the problem lasts, so the
Rig health page shows them. When the hour is up, an alert of the mute that is
still open - the one that posted the line, or one opened since - posts its
opening once, with the problem as it stands then, and from then on rises and
recovers like any other; one that closed inside the hour is never posted. After
that the rule posts normally again; if it is still flapping, the next mute line
says so.

Rule 14 ends its mute differently, because each of its alerts is one lap that
staff should see. None of the muted laps is posted on its own. When the hour is
up, one quiet summary lists the laps flagged during the mute, including the
lap whose opening the mute line replaced and laps whose alerts have already
closed. Each line gives only the rig, the lap time and the driver, with a name
under review masked as it is everywhere else, so no line is ever cut. Where the
laps were driven is said once, in every message's first line. A lap's own car
and track strings come from the rig, so they are never shown: laps on today's
featured combo are counted under the combo's label, and any others as "another
car and track" (for example "2 on today's featured combo (...) and 1 on another
car and track"). A long list is split on whole lines, 25 laps to a
message, across at most three messages, each marked "part 1 of 3" and so on (a
summary that fits in one message carries no mark). If laps remain after three
messages, the last one ends with "and N more implausible laps on Rig X this
hour": a rig flagging that many laps has a broken detector, and the count is
what staff act on. The full list belongs on the planned Rig health page.

The summary posts once per mute. A part Discord refuses is retried like any
other post, starting from that part, so a part Discord already took is not
posted again. Which laps a part holds depends only on how many laps the mute
flagged, so a retry resumes at the same lap even if the featured combo or a
driver's name status changed in between. No column exists for the summary, so the mute-starting alert's
own columns record it: `recovery_attempted_at` claims it, `level` counts the
parts posted, and `recovery_notified_at` marks it done. Rule 14 never posts a
recovery and its level never moves, so nothing else uses those columns on its
alerts (`claimFastLapSummaries` in `store.ts`).

## Discord

| Variable | What it is |
|---|---|
| `DISCORD_WEBHOOK_URL` | the channel's webhook URL. Without it nothing is posted - messages are logged instead - so a preview or a laptop never posts to the venue |
| `DISCORD_ALERT_USER_ID` | the owner's Discord user id (User Settings > Advanced > Developer Mode, then right-click your name > Copy User ID). Urgent alerts @mention it; warnings never mention anyone |

Set both in Vercel for **Production only**. The webhook URL is a credential:
it lives there and nowhere in the repository.

A post that fails (Discord down, rate-limited) is retried by a later
evaluation, no sooner than a minute after the last attempt, until an hour
after the alert opened (or its count last rose, or the [flapping](#flapping)
mute it was held by ended) - however long the problem
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
diagnosed twice, and a post Discord refused is retried like an alert's, for
an hour after the diagnosis was made.

**Nothing a rig typed leaves.** A heartbeat's strings - session names,
agent notices, variable names - are whatever the rig, or anyone holding its
token, sent, and no filter can promise they hold no name, address, path or
instruction. So the prompt and the handoff carry only what the server can
vouch for (`diagnosis/context.ts`): the heartbeats' numbers, true/false
flags and enum values; the agent version only when it has a version's
shape; agent notices only as codes of the notices the agent is known to
raise, counted, with a fixed summary; and the alert's own words - the rule,
the rig's number ("Rig 7", never its display name; see the rig-alert issue
below) and the headline and numbers the rules wrote, with the seated
driver's name replaced by `driver-<4 hex>`. The alert message above still
names the rig and the driver, as it always has: that is the staff channel.

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

## The rig-alert GitHub issue

When software may be to blame, the handoff also becomes a GitHub issue on
this repository, labelled `rig-alert`, for the coding harness to pick up and
turn into a pull request; the owner still approves every merge. The Discord
handoff stays either way, as the fallback when the harness is offline.

- **Which alerts:** an urgent alert whose rule names software as a plausible
  cause (3a, 3b, 10, 15, 16, 17 and 18; `software` in `rules.ts`, though 16,
  17 and 18 are warnings today and so never file), or any urgent alert the
  diagnosis classes as `software`. An unplugged rig or a closed iRacing files
  nothing. The issue's body is the handoff, so it also needs what the handoff
  needs: `DISCORD_WEBHOOK_URL` and the diagnosis key (`GEMINI_API_KEY`, or
  `ANTHROPIC_API_KEY` with `DIAGNOSIS_PROVIDER=anthropic`). Without either, no
  issue is filed, even on a software rule.
- **The rig is named by its number** ("Rig 7", `rigs.rig_number`) in the
  issue and in the handoff, never by its display name: that is free text staff
  typed, and a plain sentence or a person's name there would otherwise be
  published. Only the Discord alert itself shows the display name.
- **One issue per fault, not per rig.** Every alert of the same rule within
  24 hours shares one issue, whichever rig it is on: a software fault shows on
  every rig at once, and one bug must start one fix, not twenty.
- **The issue:** titled `[rig-alert] <rule> - <rigs>`, it names each alert it
  was filed for and its rig, and its body is the first alert's handoff
  exactly as Discord got it, plus the heartbeat facts it was written from (the
  same allowlisted fields, as JSON, and only heartbeats received by the time
  the handoff was written, so a retry an hour later adds none from after) in
  a `<details>` block. Both sit in code blocks, so no rig string reaches the
  issue and nothing in it can @mention anyone or link anywhere; the rule and
  rig names outside them are made inert.
  The number is stored in `monitor_alerts.github_issue_number` of every alert
  it covers. Discord still gets each rig's own alert, diagnosis and handoff.
- **Further alerts** of that rule within 24 hours, on the same rig or another,
  join the issue with one comment per filing pass naming every rig that
  joined (and the first one's handoff) instead of opening another, and reopen
  it first if it was closed - a fix that did not hold goes back to the harness
  on the same thread.
- **A recovery** comments on the issue once every alert on it has recovered
  and no rig's alert of that rule is still waiting to join it (including one
  whose rig recovered before its filing went through, or while its diagnosis
  was still being written), not once per rig, and leaves it open: closing it
  would cancel a fix in progress. Close it yourself when the fix has merged.
- A call GitHub refuses is retried like a Discord post, and only its status
  code is logged - never GitHub's answer, which could quote the request.
- **No duplicates.** Filing is serialized per rule, so two alerts of one
  rule filed at once, on one rig or two, make one issue and one comment.
  Every issue and comment carries a hidden marker as its last line naming the
  rule and every alert it was written for; a write whose answer was lost (a
  timeout, a function that died) is found by that marker on the retry and
  recorded, not written again. A marker counts only on an issue or comment
  written by the token's own GitHub account (read once from `GET /user`), so
  nobody else can type one into this public repository to stop an issue
  being filed. The lookup pages through the issue and comment lists, not
  search, up to ten pages of 100; past that it retries later rather than
  guess. A re-fire comment that already landed is recorded as it is, without
  reopening an issue you closed since.

| Variable | What it is |
|---|---|
| `GITHUB_RIG_ALERT_TOKEN` | a fine-grained personal access token: github.com > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. Resource owner: you. Repository access: Only select repositories > `oasisRaceControl`. Permissions: Repository > Issues > Read and write, nothing else. Expiration: 1 year, with the renewal date in your calendar. Without it no issue is filed and the Discord handoff is the whole story. It files nothing on its own either: the webhook and the diagnosis key must be set too |

Production only, like the webhook. Create the label once, before the first
issue: `gh label create rig-alert --color B60205 --description "Opened by the
rig monitor; a fix worker picks it up"`. The monitor logs an error if GitHub
files an issue without it.

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
