# Rig monitor

The rig monitor watches every sim rig from the heartbeat its agent sends once a
minute and posts to the venue's Discord channel when something is wrong: once
when a problem starts, once when it clears, and nothing in between. All the
judgement is on the server - the rig only reports what it already knows, so
iRacing keeps its frames. Every open `/tv` page heartbeats too, so the monitor
also sees the screen the room is watching, and an open event board puts it in
**event mode** (below).

The code is `apps/web/src/lib/monitor/`. The rules are one pure module,
`rules.ts`, which the staff Rig health page calls on the same snapshot the
alerts use, so a tile and the channel can never disagree.

## The Rig health page

`/staff/rigs` (staff sign-in; linked from the staff dashboard's header)
refreshes every 15 s. It reads the monitor's snapshot and runs `evaluateRules`
on it without claiming an evaluation, so opening it posts nothing.

- **Data flow** (`lib/monitor/flow.ts`, drawn by `components/rig-flow.tsx`):
  each rig as the pipeline its laps travel - iRacing, rig agent, network,
  then the server, database, feed and TV board every rig shares. Each rule's
  finding is placed on its node or edge (`RULE_PLACE`), coloured as the tile
  is; the first red edge walking downstream (else the first yellow) is drawn
  thick with the finding's headline under it, and only a red one fades what
  lies past it, since nothing there can be judged. Heartbeats and laps from
  the last 10 minutes ride their routes, placed by age (fresh at the start,
  10 minutes old at the end) and moving between refreshes with CSS alone;
  laps carry their time and status, and laps queued on the rig or refused by
  the site sit where they stopped. Under reduced motion the dots stay still.
- **A tile per rig** (`lib/monitor/rig-health.ts`): red when a rule finds
  something urgent on the rig, yellow for a warning, and the finding's
  headline on the tile. With no finding it is green while the rig is running,
  grey when it is not (never seen, closed, or off for the day). Then who is
  seated and for how long, iRacing's session, the last lap today, the upload
  queue and parked laps, the agent build, its CPU and memory, clock skew and
  the last heartbeat. An agent older than `rig-agent/0.4` sends none of that
  and is badged **old agent** rather than shown as blanks.
- **Venue** problems (no featured combo, a dark board) above the tiles.
- **Event mode**: on or off and why, with Start event / Stop event / Auto
  (the override below) and today's TV boards.
- **Run checks now** runs one evaluation, throttled with every other one.
  **Send test message to Discord** posts one line naming who pressed it and
  says what happened: sent, no `DISCORD_WEBHOOK_URL` on this deployment, or
  Discord's refusal and its reason.
- **Alerts**: the last 50, open or recovered, with a link to the GitHub issue
  when one was filed.

## When it runs

Nothing runs on a timer inside Vercel: Hobby's cron runs at most once a day.
An evaluation runs

- **after every rig heartbeat**, once the rig has had its answer (Next's
  `after()`), so a healthy rig is what notices a silent one;
- **after every TV board heartbeat**, the same way, so during an event the
  board notices a silent rig; and
- **on every `GET /api/monitor/tick`**, which an outside clock calls once a
  minute (below), so a venue whose every rig went dark is still noticed.

However many of those arrive, at most one evaluation runs every 20 seconds
(`monitor_state.last_evaluated_at`, claimed in one statement).

## The rules so far

Numbers are the approved monitoring plan's. **Urgent** posts red and
@mentions the owner; **warning** posts yellow and quietly.

| # | Rule | Fires when | Clears when | Severity |
|---|---|---|---|---|
| 1 | Rig silent | no word from a rig for 2 min, and its agent did not say goodbye | the rig is heard again | urgent with a driver seated or in event mode; otherwise a warning after 7 min (below) |
| 1 | Every rig went quiet | outside event mode only: two or more empty rigs went quiet within 5 min of each other and none is left running | 7 min after the first rig is heard again (by heartbeat or by laps), time enough for the rest's backed-off heartbeats; rigs still quiet then are warned about one by one | warning, one note instead of one per rig. In event mode there is no such note: each silent rig is urgent at once, because mid-event rigs going quiet together is an outage, not closing time |
| 2 | iRacing not connected while a driver is signed in | a seated rig's agent has reported iRacing disconnected for 3 min (counted from when the driver sat down) | iRacing connects, or the stint ends | urgent |
| 3a | Laps queued but not reaching the site | a lap has waited over 2 min while at least two heartbeats got through | the queue drains | urgent |
| 3b | Laps refused by the site | the rig holds parked (refused) laps | a person un-parks them (count back to 0); every rise in the count posts again | urgent |
| 4 | No featured car and track today | no `featured_combos` row for the venue day, and event mode is on or a rig is in an iRacing session | today's row exists | urgent. The alert carries the `insert` to paste, built from that rig's own session strings - or, with no rig in a session, says to run `--diagnose` on one |
| 8a | TV board went dark | in event mode: the event's board (the event board, or the shop wall on a day with none) has not been heard from for 3 min, did not say goodbye, and no other board of its kind is live | a board is heard again, or event mode ends | urgent |
| 8b | TV board cannot load its numbers | a live board says its last 3 loads of the leaderboard failed (it shows "Reconnecting") | a load succeeds | urgent, in any mode: the board reached the site to say so, so the feed is what is broken |
| 9b | Monitor gap | more than 10 min of the time since the previous evaluation fell in venue hours (08:00-midnight) | - | a one-line note, not an alert: nothing to recover from, and only the evaluation that ends the gap sees it |
| 10 | Rig agent restarting repeatedly | 3 agent starts within 15 min | the starts age out of the 15 min | urgent |
| 12 | Rig clock is off | the rig's clock is over 5 min from the server's | under 2 min | urgent |
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
- **A driver is named in an alert only while their account is active.** A
  name under review (or a banned driver) reads "a driver (name under review)",
  in Discord and in `monitor_alerts`, as the public leaderboard hides them.

## Discord

| Variable | What it is |
|---|---|
| `DISCORD_WEBHOOK_URL` | the channel's webhook URL. Without it nothing is posted - messages are logged instead - so a preview or a laptop never posts to the venue |
| `DISCORD_ALERT_USER_ID` | the owner's Discord user id (User Settings > Advanced > Developer Mode, then right-click your name > Copy User ID). Urgent alerts @mention it; warnings never mention anyone |

Set both in Vercel for **Production only**. The webhook URL is a credential:
it lives there and nowhere in the repository.

A post that fails (Discord down, rate-limited) is retried by a later
evaluation, no sooner than a minute after the last attempt and for up to an
hour, and never twice. An alert that came and went while Discord was down
posts its opening late and then its recovery, never a lone "recovered".

## The outside clock

`GET /api/monitor/tick` evaluates and answers
`{"status":"ok","evaluated":true,"activeAlerts":0,"eventMode":false}`
(`eventMode` as the channel was last told), or 503 in about two
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

## Event mode and the 20-minute update

The owner wants a status update every 20 minutes during an event, and none on
an ordinary day, when it would only train people to ignore the channel (R1,
R7). Event mode is what tells the two apart. It is judged on every evaluation
by `eventMode()` in `event-mode.ts`, pure, from the same snapshot as the rules:

- **On while an event board is open.** Opening `/tv?event=1` is already part of
  setting up an event, so it needs no second step (R8). The board holds event
  mode until it says goodbye - closing the tab, or navigating away - or the
  venue day ends. A board that goes dark without a goodbye keeps it on: that
  is rule 8a's alert, and it could not fire if the dark board had ended the
  event. A goodbye followed by a new page within 2 minutes (a reload) does
  not flip it.
- **Staff can force it** on or off with `POST /api/staff/event-mode`
  (`{"mode":"on"|"off"|"auto","reason":"..."}`, staff session, same-origin JSON
  - the Rig health page's buttons). `on` and `off` last until venue midnight,
  never longer; `auto` hands it back to the boards. Every change writes an
  audit row. Use `off` when a board was left open by mistake.

Each change posts one grey line ("⚪ Event mode on: Event board (Cadillac)
opened at 2:31 PM"). While it is on, an evaluation posts the update when the
last one is 20 minutes old - so within a minute of its mark, and stamped with
the mark, so the cadence does not drift. The update is a fixed template (R4):
the board and today's combo, drivers and laps; one line per rig that has been
on today (online, iRacing, who is seated and for how long, last lap, queue,
agent build); the top three by initials, from the same view the event board
ranks; and the open alerts. Its colour is the worst open alert's. A post
Discord refuses is handed back and retried by the next evaluation, for the
line and the update alike.

### The board heartbeat

`components/tv/board-heartbeat.tsx` sits beside the rotation engine on `/tv`
and renders nothing; the engine (`tv-screen.tsx`) is unchanged. Every 30 s it
posts `POST /api/tv/heartbeat` with whether the page is the visible tab and
how many of its boards' loads have failed in a row (`lib/tv-feed-health.ts`,
which counts every registered board type's loads - the same failures the
footer shows as "Reconnecting"). As the page closes it sends a goodbye with
`navigator.sendBeacon`; a killed browser or a sleeping laptop sends nothing,
and that silence is rule 8a.

The route is public, like `/tv`, so it believes a heartbeat only as far as
its **ticket**: when the server renders `/tv` it mints a board id and signs
it, with the mode and host, into a ticket (`lib/board-ticket.ts`, HS256 with
`SESSION_SECRET`, 36 hours, renewed by every accepted heartbeat). A forged or
foreign ticket is refused, so a stranger cannot put the venue into event mode
or page the owner by posting to the route. Each open page is one
`board_heartbeats` row, kept 7 days. `npm run tv:heartbeat-check` proves the
cadence, the goodbye and the alert in a real browser (README).

## Alert state

`monitor_alerts` holds one row per alert, forever (they are small, and they
are the history). `monitor_alerts_one_open`, a partial unique index on
`(rule, subject) where resolved_at is null`, is what makes "fires once" hold
when two evaluations run at once. The migration and its hand-apply steps are
`db/migrations/0006_monitor.sql` and
[deploy.md](./deploy.md#applying-0006_monitorsql).

Heartbeats - the rigs' and the boards' - are kept seven days; an evaluation
prunes older ones at most once a day. `board_heartbeats` and the event-mode
columns are `db/migrations/0007_board_heartbeats.sql`
([deploy.md](./deploy.md#applying-0007_board_heartbeatssql)).
