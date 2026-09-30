# Rig monitor

The rig monitor watches every sim rig from the heartbeat its agent sends once a
minute and posts to the venue's Discord channel when something is wrong: once
when a problem starts, once when it clears, and nothing in between. All the
judgement is on the server - the rig only reports what it already knows, so
iRacing keeps its frames. Every open `/tv` page heartbeats too, so the monitor
also sees the screen the room is watching, and an open event board puts it in
**event mode** (below).

The code is `apps/web/src/lib/monitor/`. The rules are one pure module,
`rules.ts`, which the staff Rig health page will call on the same snapshot the
alerts use, so a tile and the channel can never disagree.

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
(`monitor_state.last_evaluated_at`), and never two at once: an evaluation
claims, reads and applies its alert changes in one short transaction holding
that row's lock, so one that reads later always applies later. It commits
before posting anything, so a slow Discord never holds the others up.

## The rules so far

Numbers are the approved monitoring plan's. **Urgent** posts red and
@mentions the owner; **warning** posts yellow and quietly.

| # | Rule | Fires when | Clears when | Severity |
|---|---|---|---|---|
| 1 | Rig silent | no word from a rig for 2 min, and its agent did not say goodbye | the rig is heard again | urgent with a driver seated, or in event mode for a rig switched on for it: heard since event mode began, or since the venue came back from its last silence (while the venue is not silent again). Otherwise a warning after 7 min (below) |
| 1 | Every rig went quiet | two or more empty rigs went quiet within 5 min of each other and none is left running - in event mode, counting only rigs not switched on for it | 7 min after the first rig is heard again (by heartbeat or by laps), time enough for the rest's backed-off heartbeats. A rig not heard since before the first one came back stays dark without a warning of its own - still switched off after a close, or not yet back - until it is heard again (after which it alerts as usual) or 12 h pass; a seated one still alerts at once | warning, one note instead of one per rig. A rig switched on for the event is never in the note: it is urgent at once, because mid-event rigs going quiet together is an outage, not closing time. One that went dark with the venue - switched off last night, not switched on yet - stays dark and is judged as on any other day, so turning event mode on never pages about rigs nobody has turned on (owner's choice A) |
| 2 | iRacing not connected while a driver is signed in | a seated rig's agent has reported iRacing disconnected for 3 min (counted from when the driver sat down) | iRacing connects, or the stint ends | urgent |
| 3a | Laps queued but not reaching the site | a lap has waited over 2 min while at least two heartbeats got through | the queue drains | urgent |
| 3b | Laps refused by the site | the rig holds parked (refused) laps | a person un-parks them (count back to 0); every rise in the count posts again | urgent |
| 4 | No featured car and track today | no `featured_combos` row for the venue day, and event mode is on or a rig is in an iRacing session | today's row exists | urgent. The alert carries the `insert` to paste, built from that rig's own session strings - or, with no rig in a session, says to run `--diagnose` on one |
| 8a | TV board went dark | of today's event boards (each opened from its staff link), the one heard from most recently has not been heard from for 3 min and did not say goodbye. Judged whether or not event mode is on - the dark board has stopped holding it - and never for the shop wall | an event board is heard again, staff force event mode off, or the venue day ends | urgent: the board it reports was holding the event |
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

- **On while an event board is open and heard from.** Opening the event
  board is already part of setting up an event, so it needs no second step
  (R8). **Staff open the shop wall and the event board from their staff
  link**, under **TV boards** on `/staff` (the shop wall, and an event board
  per bundled host): each link carries a signature of its own for its mode,
  and only a page opened from one gets a ticket at all (`lib/board-ticket.ts`;
  an event link opens boards for 48 hours, so the laptop's board can be
  reloaded on day two, and the wall's for a year, so the kiosk's bookmark
  keeps working). The public `/tv` and `/tv?event=1` still show the board to
  anyone, but report nothing, so a stranger, `curl` or a stray phone opening
  either can never turn event mode on or page the owner. A board holds
  event mode only while it has been heard from within the last 3 minutes; it
  stops on its goodbye - closing the tab, or navigating away - on going dark,
  or at the end of the venue day. A goodbye followed by a new page within 2
  minutes (a reload) does not flip it.
- **Rule 8a does not wait on event mode.** A board that goes dark ends event
  mode at the same moment it becomes dark, so 8a is judged on its own: of
  today's event boards, the one heard from most recently went dark without a
  goodbye. The most recent, so a phone left locked on the board is not
  reported once the laptop's tab is closed properly, while a killed laptop
  browser is. Closing the tab alerts nothing; killing the browser alerts once,
  urgently, three minutes later, and posts "event mode off" beside it.
- **Staff can force it** on or off with `POST /api/staff/event-mode`
  (`{"mode":"on"|"off"|"auto","reason":"..."}`, staff session, same-origin JSON
  - the Rig health page's buttons). `on` and `off` last until venue midnight,
  never longer; `auto` hands it back to the boards. Every change writes an
  audit row. Use `off` when a board was left open by mistake: it also
  silences rule 8a for the rest of the day.

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
foreign ticket is refused. A ticket is minted only for a page opened from a
staff link for its mode, so the public `/tv` and `/tv?event=1` have none and
send nothing: every board rules 8a and 8b judge, the shop wall included, was
opened by staff. Each open page is one
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
