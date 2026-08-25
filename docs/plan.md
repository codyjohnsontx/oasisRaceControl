# Oasis Race Control — MVP Plan

## Context

Oasis Sim Racing is a physical venue with ~20–25 Windows iRacing simulators. Customers pay, pick any open rig, and drive — but their lap times vanish into the sim. Oasis Race Control connects walk-in customers to their laps with near-zero friction (scan rig QR → check in on phone → drive) and surfaces the results on a mobile driver portal, a staff dashboard, and a front-of-store TV leaderboard. The core invariant: **every lap is attributed to the correct driver, exactly once, and never reassigned.**

This plan follows a completed product-discovery round with the owner. It covers the MVP only; payment/booking integration, native apps, ratings, and multi-venue SaaS are explicitly deferred.

**Venue-safety gate:** no executable from this project may run on an Oasis computer until Phase 0 is complete. A build, passing unit tests, or a valid signature is not venue authorization. The exact signed artifact must pass the off-site Windows 11 evidence gate and project-owner safety sign-off first.

## Confirmed decisions (from discovery)

| Area | Decision |
|---|---|
| Content control | Staff pre-configure rigs with the track/car combo (per night/event) |
| iRacing accounts | One dedicated account per rig |
| Paid-time signal | None exists — staff track time manually; system relies on idle heuristics + takeover flow |
| Launch leaderboard | **Fastest Tonight** (best lap per driver on tonight's combo, resets daily) |
| Network | Solid wired ethernet for rigs, good customer Wi-Fi — cloud backend is safe |
| TV hardware | Undecided → recommend a mini-PC running a browser in kiosk mode (open purchase item) |
| Rig-side display | Visible desktop agent window shows driver name when iRacing isn't running; **no in-sim overlay** |
| Check-in posture | **Guest-first**: scan → type display name → drive (<15s); prompt to claim results after the session |
| Lap validity | **Clean laps only (0x)** — any incident/off-track invalidates the lap |
| Driver identity | Display name + 4-digit PIN, no contact info required |
| Events today | Both drop-in hot-lapping and scheduled events → Fastest Tonight at launch, official challenges in MVP |
| Spike environment | Venue rig access (no home iRacing) — spike work happens in focused on-site sessions |

## Flagged risks & open items

1. **Venue-computer safety (blocking all Oasis execution).** The recorder must be demonstrably read-only, non-elevated, dependency-bounded, offline, resource-capped, signed, hash-verified, VM-rehearsed twice, and signed off by the project owner. Unknowns and warnings block execution; they are not waived at the venue. See `docs/venue-safety.md`.
2. **iRacing telemetry ground truth (blocking schema freeze).** Lap validity is derived, not given: iRacing exposes a running incident count and track-surface state, not a per-lap valid flag. Phase 1B must prove per-lap incident attribution, session identity across restarts, and reset-to-pits behavior **before the schema is final**.
3. **No account recovery.** Display-name+PIN means forgotten PIN = staff reset. Mitigate: staff PIN-reset tool in MVP, optional email post-MVP.
4. **Wrong-driver attribution.** No paid-time signal, so auto-checkout is heuristic (idle timeout + takeover flow + agent's iRacing-closed detection). Tune values during the 3-rig pilot; measure staff-corrections-per-night.
5. **iRacing commercial licensing.** Confirm Oasis's commercial/arcade license terms permit third-party telemetry tooling. Owner action item before the full spike.
6. **Fleet updates.** No auto-update infra in MVP, but ship version reporting + a documented one-command update script or the pilot stalls on sneakernet.
7. **TV hardware purchase** — open decision; mini-PC recommended.

## MVP scope

**In:** driver profile creation (name+PIN), guest check-in, permanent per-rig QR, mobile check-in/confirm/move/takeover flows, active rig assignments, real-time driver display on the agent, iRacing detection, automatic lap capture with validity + reason, lap storage with track/car association, Fastest Tonight TV leaderboard + personal-best interstitials, official hot-lap challenge leaderboards, personal lap history/PBs with track & car filters, staff dashboard (rig status, clear rig, invalidate/restore lap with reason, PIN reset, name moderation, challenge CRUD, TV mode selection), agent health/version reporting, idempotent event submission, local offline queue, inactivity session-end safeguards, audit log for staff actions.

**Out (deferred):** payments/booking, native apps, ratings/badges/teams, telemetry analysis, multi-venue, auto-update infra, animated TV graphics.

Points/championships and driver-vs-driver comparison were deferred here, then pulled forward as league night on confirmed customer and owner demand — see the League night section of the [root README](../README.md).

## User journeys (condensed)

- **Guest first-timer:** scan QR at Rig 12 → page shows "YOU ARE CHECKING INTO RIG 12" → taps *Drive as guest* → types display name → confirms → agent window shows their name → drives → laps appear on phone + TV → post-session: "You placed 3rd tonight — set a PIN to keep your results" (guest→profile conversion keeps the same driver row, just upgrades it).
- **Returning driver:** scan QR → already signed in on phone → confirm rig → drive. (Cold device: enter display name + PIN.)
- **Rig move:** driver checked into Rig 7 scans Rig 12 → "Move your session to Rig 12?" → old assignment closes, laps stay owned.
- **Takeover:** new customer scans a rig still assigned to someone → "Rig 12 is assigned to Cody J. Is the previous driver finished?" → confirm closes the old assignment (never touches its laps) and opens theirs.
- **Staff:** dashboard shows all rigs (driver, agent status, iRacing status, best lap) → clear a rig, invalidate a lap with reason, reset a PIN, flip the TV mode. Every mutation writes an audit row.
- **Spectator:** TV cycles Fastest Tonight; on a new PB it cuts to a "NEW PERSONAL BEST — Cody J. 2:18.103 (−0.842)" card, then returns.

## Architecture

```
25× Rig: iRacing → Rig Agent (C#/.NET 8, WinForms tray+window)
                     │  HTTPS POST /api/agent/events (idempotent)
                     │  HTTPS GET /api/agent/assignment (polled every 10s)
                     ▼
        Next.js API routes on Vercel → Postgres (Neon)
                     ▼ polled reads
   Mobile driver portal │ Staff dashboard │ TV kiosk (/tv)
        (one Next.js app on Vercel, three surfaces)
```

- **Web:** Next.js (App Router) + TypeScript on Vercel. Routes: `/r/[qrToken]` (check-in), `/me` (driver portal), `/staff` (dashboard), `/tv` (kiosk leaderboard). Mobile-first, dark motorsport theme, TV route uses huge type + FLIP position animations only.
- **Backend:** Postgres - Neon in production, any local Postgres in dev. Two server-side paths reach the database: Next.js API routes, and server components reading for their own first paint (`/tv`, `/leaderboards`, `/league`, `/league/[roundId]`, `/me`, `/staff`, `/r/[qrToken]`). Every write goes through an API route, which is where server-side validation, idempotency, and audit live; server components only read. Both run on the server, so no client ever touches the database directly and there is no row-level-security surface to configure. No realtime service: agents poll `GET /api/agent/assignment` for their rig's assignment, and the TV/portal poll the leaderboard endpoints every few seconds. Scoping is enforced in the API routes - agents are restricted to their own rig by their bearer token, drivers to their own rows by session cookie, and mutations to authenticated staff.
- **Auth:** three planes. *Drivers:* custom name+PIN → server issues a long-lived signed session cookie/JWT (stay signed in on the phone); PINs hashed (argon2/bcrypt); rate-limit + lockout on attempts. *Staff:* app-owned email+password in `staff_users` (bcrypt-hashed); `POST /api/staff/login` issues a signed staff session cookie. *Agents:* per-rig secret token issued at enrollment, sent as a bearer header, revocable/rotatable from the staff dashboard.
- **Rig Agent:** .NET 8 Windows app (auto-start, tray icon + status window). Reads iRacing via the memory-mapped-file SDK (evaluate `IRSDKSharper` / `irsdkSharp` in the spike — pick whichever proves reliable; field names below are to-verify, not assumed). Local SQLite event queue → POST with `eventId` idempotency key → delete on 2xx. Displays current driver + connection status; "Switch driver" button ends the assignment. Heartbeat every 30s with version + iRacing status.

## Data model (Postgres)

- `drivers` — id, display_name (citext unique), pin_hash (null for guests), is_guest, status (active/banned/name_flagged), created_at. Guest→profile conversion sets pin_hash and clears is_guest on the **same row**.
- `rigs` — id, rig_number, display_name, agent_token_hash, agent_version, last_seen_at, connection_status.
- `rig_qr_tokens` — rig_id, token (random slug, not the rig number), active — replaceable if a QR leaks/breaks.
- `rig_assignments` — id, rig_id, driver_id, started_at, ended_at, end_reason (driver_ended/switched/takeover/staff_cleared/idle_timeout/moved). Partial unique index: one open assignment per rig, one per driver.
- `sim_sessions` — id, rig_id, iracing_session_key (from spike), track_id, track_config, car_id, started_at, ended_at.
- `laps` — id, event_id (unique — idempotency), rig_assignment_id, driver_id (both null together on an unattributable lap; see the event model),  sim_session_id, track/config/car denormalized, challenge_id (nullable, resolved server-side), lap_number, lap_time_ms (int), incident_delta, is_valid, invalid_reason (enum from spec), completed_at. **Immutable except is_valid/invalid_reason via staff action.**
- `tracks`, `track_configs`, `cars`, `car_classes` — normalized from iRacing IDs, upserted lazily as laps arrive.
- `challenges` — name, track_config_id, car_id, setup_mode, incident_limit, start/end dates, status. `nightly combos` are just a lightweight "tonight's featured combo" setting keyed by date.
- `staff_users`, `audit_log` — actor, action, target, before/after JSON, reason, at.

Lap times stored as integer ms; formatting (`2:18.103`, `+0.621`) is display-only. Leaderboards are SQL views (best valid lap per driver per combo per date-range) — no denormalized standings tables in MVP.

## Event model (agent → API)

`RIG_HEARTBEAT`, `IRACING_SESSION_STARTED`, `LAP_COMPLETED`, `IRACING_SESSION_ENDED`, `DRIVER_SIGNED_OUT` (from agent UI), `RIG_IDLE_WARNING/RIG_IDLE_TIMEOUT`. Every event carries rig identity, which comes from the bearer token rather than the payload. `LAP_COMPLETED` additionally carries `eventId` (the idempotency key the agent mints when it queues the lap - any string of 8 to 128 characters, not necessarily a UUID; see `lapCompletedEvent` in `apps/web/src/lib/events.ts`) and the active `rigAssignmentId` **as known by the agent at capture time**. `RIG_HEARTBEAT` carries neither: it is not a lap, so there is nothing to deduplicate and nobody to attribute it to - the server attributes from that stamp and never from whatever assignment happens to be open when the batch arrives.

The stamp has three states. A **uuid** is attributed to that assignment, scoped to the calling rig; whether the assignment has since closed is deliberately irrelevant, because a lap that waited out a network outage still belongs to the driver who drove it and refusing it there would destroy the backlog the durable outbox exists to protect (`accepted` / `accepted_invalid`). An **explicit null** means the agent knew nobody was checked in. An **absent key** means the agent predates the field and cannot say - not the same thing, and never treated as one, so an older agent degrades to recording nothing *rankable* rather than quietly inheriting the next driver. A uuid this rig has never owned is a fourth, abnormal case, and a uuid whose assignment window does not contain the lap's `completedAt` is a fifth: `completedAt` comes from the rig, so without that bound a rig's own token could name any assignment it has ever held and pick that lap's driver. A 15-minute clock-skew grace at each end of the window absorbs genuine drift between the rig PC's clock and the server's; it is a tolerance, not a policy knob, and it is named in `apps/web/src/app/api/agent/events/route.ts` rather than written into the SQL.

The agent never stamps a guess either. A lap captured before it has ever reached the backend - a rig PC that rebooted during an outage while the driver was checked in from their phone - has no answer to stamp, and an explicit null would assert the rig was empty. Such a lap is held **unresolved** in the outbox: durable across a SIGKILL, deliberately unsendable, and stamped by the first assignment poll that succeeds. That poll resolves each held lap against its **own** `completedAt` rather than the backlog as a whole: a lap driven before the reported assignment started belongs to nobody and resolves to an explicit null. Both sides of that comparison are in server time - the lap's `completedAt` is stamped by the rig and the assignment's `started_at` by the server, so the poll also reads the offset between the two clocks from its response's HTTP `Date` header and shifts the rig's timestamp by it before comparing. Comparing them raw would let a rig clock running a few minutes fast date a warm-up lap after the check-in it actually preceded, which is this defect again on the cold-start path, while a slow one would send laps a driver really drove to the unclaimed pile. Resolving the whole backlog to one id would credit a walk-up guest's warm-up laps to the first customer who checks in afterwards, which is the misattribution this entire stamp exists to remove.

That leaves four *unattributable* outcomes, all stored the same way: `accepted_unattributed` - a real lap row with no `driver_id` and no `rig_assignment_id`, invalid with reason `UNATTRIBUTED`. They are an explicit null, an absent key, an id this rig has never owned, and an id whose assignment window does not contain the lap's `completedAt`. The last three are abnormal and each is logged once per batch, because each names something to go fix: a rig left on an old agent build, a stale outbox or a crossed token, and a rig PC whose clock has drifted or that was offline while the seat changed hands (the known limitation below). The explicit null is not logged - a rig nobody has checked into is ordinary venue life. `accepted_unattributed` is a settling status, so the agent drops the lap from its outbox: the venue keeps the lap, and a rig nobody ever checks into cannot fill its own disk. `LAP_COMPLETED` payload mirrors the spec's illustrative JSON; exact iRacing fields are finalized after the spike. Server-side validity check re-runs independently (combo match vs tonight's/challenge config, incident_delta > 0 → `INCIDENT_LIMIT_EXCEEDED`, duplicate `event_id` → dropped).

Check-in direction: web → API creates assignment → the agent picks it up from its next `GET /api/agent/assignment` poll (every 10s) → agent displays the name. Polling is the only cloud-to-rig path; nothing is pushed into the venue.

## Security model

Per-rig bearer tokens (hashed at rest, staff-rotatable); agents can only write to their own rig. PIN brute-force: 5 attempts → exponential lockout per driver+IP. QR tokens are random slugs, replaceable per rig; photographed-QR remote check-in is a documented accepted risk for MVP (it grants no sim control and creates no laps). Driver sessions are signed JWTs, long-lived by design. Staff mutations require the staff role and write audit rows. Public surfaces expose display names only. Rate limiting on check-in and login endpoints (Vercel middleware / upstash-style counter in Postgres).

## Failure & edge cases (design targets)

- Network out at rig → laps queue in SQLite, sync on reconnect with original timestamps; agent shows offline badge; staff dashboard shows agent offline.
- Agent restart mid-session → re-reads assignment from API, resumes; queued events survive (disk).
- Same lap event retried → unique `event_id` swallows it.
- Driver walks away → iRacing closed + configurable idle period → agent shows "Still driving? Signing out in 60s" → `RIG_IDLE_TIMEOUT` closes assignment.
- Lap completes just before iRacing closes → event already queued; flushes on next connect.
- Reset to pits / session restart / track change → spike determines detection; laps mid-reset marked `INCOMPLETE_LAP` or `SESSION_RESET`.
- New driver checks in while old assignment open → takeover flow; old laps never move.
- **Unattributable laps** (driven with nobody checked in, or sent by an agent too old to stamp them) are **stored unattributed and invalid**: kept, never credited to the next driver to check in, and never dropped. Unrankability is enforced by the database, not by a query convention - `laps_unattributed_is_invalid` (`db/migrations/0003_unattributed_laps.sql`) makes a valid ownerless lap unrepresentable, so no leaderboard query, staff "restore", or future consumer can surface one. `/staff` lists the last seven days of them under *Unclaimed laps* so the common cause (a customer who drove before scanning the QR) is diagnosable at the counter. **Attributing one to a driver is not built** - that needs an assignment row to point at or a deliberate relaxation of `laps_attribution_all_or_none`, and the SAFETY NOTE at the top of that migration records the decision for whoever builds it.
- **Known limitation, bounded by design:** once the agent has polled successfully it keeps stamping from its last known assignment across failed polls, and nothing tells it when an assignment closes - every closure happens server-side and the agent only learns of it by polling. That is three paths, not one: the driver ending their session from their phone (`POST /api/session/end`), staff clearing the rig from the dashboard (`POST /api/staff/clear-rig`), and the next customer taking it over or moving to it (`checkin_driver`). Until the next poll lands - longer if the rig is offline - the next laps carry the departed driver's assignment. The server's window check bounds this rather than preventing it: such a lap stops being credited to the departed driver, and is stored unattributed instead, once it is more than 15 minutes past that assignment's `ended_at`. Closing it would need a cloud-to-rig push, which the polling-only design does not have. The same staleness cuts the other way, and that direction fails safe: a driver who checks in and finishes a lap before the agent's next poll (10s) has it stamped an explicit null and stored unattributed, so it reaches the *Unclaimed laps* list on `/staff` rather than another driver's name.
- Two phones check into one rig simultaneously → DB partial-unique constraint arbitrates; loser gets the takeover prompt.
- Display-name collision at guest check-in → suggest `Name (2)`-style variant inline.

## Roadmap

**Phase 0 — off-site venue safety gate (in progress; blocks all Oasis execution).** Replace broad third-party telemetry access with repository-owned read-only shared-memory code; enforce non-elevated execution, no application network capability, fixed run modes, hard duration/output limits, bounded parsing, fixed output paths, and safe failure behavior. Test valid and hostile synthetic shared-memory data. Build a traceable candidate, Authenticode-sign and timestamp it, verify its SHA-256, scan it, run it twice from clean Windows 11 VM snapshots, and require project-owner safety sign-off on the exact artifact and evidence. Deliverable: a completed `SAFETY-REPORT.md` with no warnings, unknowns, or waivers. Optional peer review is encouraged but not blocking. A signed candidate alone is not approved.

**Phase 1A — supervised Oasis canary (blocked by Phase 0).** Run the exact approved artifact from a controlled USB on one idle rig for 5–10 minutes: two minutes before iRacing starts and five minutes connected. Require no UAC/security prompt, configuration change, performance effect, iRacing disruption, unexpected output, child process, or instability. Stop and inspect before authorizing any telemetry scenarios. Any artifact change returns to Phase 0.

**Phase 1B — controlled iRacing telemetry spike (blocked by Phase 1A).** Using the same executable and SHA-256, prove iRacing detect/close, session identity + restarts, track/config/car IDs, lap number + time, per-lap incident delta, off-track/surface signals, reset-to-pits, recorder-restart recovery, duplicate handling, and a lap landing right before exit. Deliverable: findings mapping every desired field to a real SDK field or an explicit unavailable verdict. **Schema is not final until this lands.**

**Phase 2 — one rig, end to end (simulated web/API slice substantially built in parallel).** Check-in, guest + name/PIN auth, driver portal, TV/track leaderboards, staff dashboard v1, database migrations, lap ingestion, fake-rig simulator, and the agent's authentication/heartbeat/assignment/durable-outbox infrastructure exist. Real iRacing lap detection, validity behavior, the Windows tray/status shell, and the real-rig verification remain blocked by Phase 1B.

**Phase 3 — three-rig pilot.** Simultaneous submissions, takeover/move flows under real customers, QR print quality, mobile-browser matrix, unplug-the-ethernet tests, staff corrections in anger, TV readability from the door, idle-timeout tuning. Add challenge CRUD + challenge leaderboard. Measure: % sessions attributed, scan→check-in completion, median check-in time, duplicate rate, staff corrections/night.

**Phase 4 — full rollout (20–25 rigs).** Agent enrollment script + update script (scheduled task), rig health page, offline alerts, version reporting, production logging (structured, aggregated), Postgres backups (Neon point-in-time restore), ops runbook (new rig, QR replacement, agent update, common failures).

## Repository structure

```
oasisRaceControl/
  apps/web/            # Next.js — portal, staff, tv, api routes
  apps/rig-agent/      # .NET 8 solution — Agent app + Agent.Core lib
  packages/shared/     # event schemas (zod) + generated TS types
  db/                  # SQL migrations + dev seed
  docs/                # spike findings, ops runbook, PRD/TDD
  spike/               # Phase 1 throwaway console app (kept for reference)
```

## Testing strategy

- **Safety gate:** dependency/capability checks; parser fuzz and corrupt-range tests; read-only shared-memory integration; duration/disk/path limits; clean Windows 11 VM behavior; signature/hash/Defender verification; Process Monitor evidence; project-owner artifact sign-off.
- **Spike checklist** doubles as the integration truth table for the agent.
- **Agent:** unit tests around the telemetry-parsing/lap-boundary state machine using recorded telemetry fixtures from the spike (so iRacing isn't needed in CI); queue tests (kill process mid-flush, assert no loss/dupes).
- **API:** integration tests against a local Postgres — idempotency (same event twice), assignment races (two check-ins), validity rules, takeover semantics, staff audit writes.
- **Web:** Playwright smoke for check-in flow (guest + returning) and staff invalidate/restore; visual check of `/tv` at the venue wall's measured 1272x601 first, then 1080p/4K (the sizing contract is in AGENTS.md, "The `/tv` board rotation").
- **Pilot metrics as tests:** the Phase 3 measurements above are the acceptance criteria for rollout.

## Deployment strategy

- **Web/API:** Vercel (preview deploys per PR, prod on main). **DB:** Neon, migrations via `npm run db:migrate` from `apps/web`, point-in-time restore enabled before pilot.
- **Agent:** GitHub Release with a versioned zip + install script (creates auto-start scheduled task, writes rig token to DPAPI-protected config); update = script pulls latest release. Enrollment: staff runs installer, pastes a one-time enrollment code from the dashboard, backend issues the rig token.
- **TV:** mini-PC, Chrome kiosk mode pointed at `/tv`, auto-login + auto-restart on boot.

## Technical risks to prove in the spike (gate for Phase 2)

0. Venue artifact safety — Phase 0 and the supervised canary must pass before telemetry questions are tested on Oasis equipment.
1. Per-lap incident attribution (incident-count delta at lap boundaries) — the 0x rule depends on it.
2. Stable session identity for idempotency keys across agent restarts and session restarts.
3. Reliable track/config/car identification from session info.
4. Off-track detection distinct from incidents (if 1x off-tracks are already counted, surface flags are redundant).
5. Lap-boundary edge behavior: reset-to-pits, tow, session restart, exit-during-lap.

## Verification (end of Phase 2)

Before this verification is permitted, the exact recorder must complete the Phase 0 evidence report, project-owner sign-off, Phase 1A canary, and Phase 1B findings. None of those gates may be replaced by simulated laps.

Run the full loop on one rig: check in as a guest from a phone via the printed QR → agent window shows the name within 2s → drive 3 laps in iRacing (one clean, one with an off-track, one reset mid-lap) → phone shows the clean lap valid, the off-track lap invalid (`INCIDENT_LIMIT_EXCEEDED`), the reset lap absent/`INCOMPLETE_LAP` → `/tv` shows the driver on Fastest Tonight → pull the ethernet, drive 2 laps, replug → both laps appear once with original timestamps → staff invalidates a lap with a reason → it drops off the TV and an audit row exists → idle at the rig past the timeout → assignment closes with `idle_timeout`.
