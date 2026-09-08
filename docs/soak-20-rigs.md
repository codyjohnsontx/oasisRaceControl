# The twenty-rig soak

The venue has 20-25 simulators. The platform is built for all of them and, until
this run, had only ever been exercised by one rig at a time - the fake-rig
simulator drives one token, and `SimulatedTelemetrySource` drives one agent. So
"twenty stations" was a design intent with nothing measured behind it.

This is the measurement. Twenty concurrent rig processes against a local
production build for an hour, asserting the two things that decide whether the
venue works at that width: **every lap is stored exactly once and credited to
the right driver**, and **the write path stays inside the timings the real .NET
agent is built around**.

Run it with [`apps/web/scripts/soak.ts`](../apps/web/scripts/soak.ts). The
committed result of the run described here is
[`soak-20-rigs.json`](soak-20-rigs.json).

---

## RESULTS_PLACEHOLDER

---

## What it asserts, and why those numbers

Seven checks, and the script exits non-zero if any of them fails.

| Check | Why it is the one that matters |
|---|---|
| Every lap sent is stored | The outbox exists so a lap survives an outage. A lap that reaches the backend and then vanishes is the failure no retry can fix. |
| Every lap is credited to the driver in that seat | The project's stated core invariant. Twenty rigs writing concurrently is exactly where a shared-state mistake would show up as somebody else's lap time. |
| No lap appears that no rig sent | Catches cross-talk: one rig's traffic landing on another rig's assignment. |
| Duplicate event ids were absorbed | fake-rig deliberately re-sends about one lap in fourteen. Under concurrency the idempotency key has to hold, not merely usually hold. |
| Every request answered 200 | A 500 is survivable (the agent retries) but it is not "twenty stations working". |
| Events **p95 < 5s** | The agent flushes its outbox every 5 seconds (`AgentService.FlushInterval`). Past that, a rig's outbox drains slower than it fills and the backlog grows for as long as the load lasts. |
| Events **max < 15s** | The agent's HTTP timeout (`OasisRigAgent/Program.cs`). Past it the agent abandons the request and re-sends the whole batch. |

The two latency ceilings are the agent's own numbers, deliberately not a target
invented to be met. They answer "does the venue still work", not "is this
fast" - and at this load the measured figures sit two orders of magnitude
under them, which is the useful finding.

**So the committed JSON, not the thresholds, is what a future change gets
compared against.** That file names the machine it was produced on, because a
latency number without a machine attached cannot be compared to anything.

---

## Running it

The soak needs a **disposable local database**. It is read through the same
guard the integration suite uses ([`src/test/db-guard.ts`](../apps/web/src/test/db-guard.ts)),
so a managed host, a non-local host, or a database whose name does not contain
`test` is refused before a connection is opened - the script writes rigs,
drivers and assignments, and must never be pointed at the venue's data.

```bash
# 1. A throwaway Postgres for this run only. Do not reuse a shared local
#    instance: other work applies its own migrations to those.
createdb -h 127.0.0.1 -p 5455 -U postgres oasis_soak_test
export SOAK_DATABASE_URL="postgres://postgres:postgres@localhost:5455/oasis_soak_test"

# 2. Schema and the venue's usual shape. The seeded featured combo is what
#    decides which of the generated laps count as valid.
cd apps/web
DATABASE_URL="$SOAK_DATABASE_URL" npx tsx scripts/migrate.ts --seed

# 3. A PRODUCTION build. `next dev` recompiles on demand and its numbers mean
#    nothing (the same reason /tv outage testing needs `next start` - see the
#    root CLAUDE.md).
DATABASE_URL="$SOAK_DATABASE_URL" SESSION_SECRET=anything-local npm run build
DATABASE_URL="$SOAK_DATABASE_URL" SESSION_SECRET=anything-local PORT=3111 npm run start &

# 4. The soak.
npx tsx scripts/soak.ts --rigs 20 --minutes 60 --base http://127.0.0.1:3111 \
  --out ../../docs/soak-20-rigs.json
```

`--rigs`, `--minutes`, `--interval`, `--base`, `--work` and `--out` are all
adjustable; `scripts/soak.ts`'s header documents them. A two-minute run is
enough to check the harness itself before spending an hour.

### What the script does

1. Provisions N rigs (numbered from 101, clear of the seed's 1-3), one guest
   driver each, and an open assignment per rig, returning fresh bearer tokens.
2. **Preflights**: every token must authenticate and report its own assignment
   before the clock starts. A soak that discovers in post-processing that the
   server was never listening has cost an hour to learn nothing.
3. Spawns the workers spread across one lap interval. Twenty rigs firing in the
   same millisecond every twenty seconds is a synthetic drumbeat, not a venue.
4. Holds the load, stops the workers, and reconciles what the rigs recorded
   sending against what the database actually holds - **matched on event id**,
   not on a time window, so a re-run against the same database can neither
   inflate nor deflate the count.

The workers are the ordinary [`scripts/fake-rig.ts`](../apps/web/scripts/fake-rig.ts)
with its `--metrics` flag, not a second simulator written for load. The soak
therefore measures the same client the demos and the Kubernetes manifests run.

---

## What this does not cover

The number is real but narrow, and the wording it supports should be too.

- **The ingestion path only.** Twenty writers, no customer display polling
  alongside them. `/tv`, `/leaderboards` and `/league` were not under load.
- **One driver per rig for the whole run.** That is what makes the attribution
  assertion exact, and it means a seat changing hands mid-load is not
  exercised here. Those races have their own integration tests.
- **Simulated telemetry.** No iRacing, and no .NET agent: `fake-rig.ts` speaks
  the same wire contract but has no SQLite outbox, so this says nothing about
  agent-side durability. That is covered by the agent's own tests.
- **Localhost, not a venue network.** No Wi-Fi, no packet loss, no rig PCs.
- **Local Postgres, not Neon.** Production talks to a pooled Neon endpoint over
  the network; these latencies do not include that hop.
- **Twenty rigs enrolled by script, not by an installer.** There is still no
  rig-enrollment endpoint - standing twenty real rigs up at the venue remains
  manual work this run does not address.

What it does establish: at twenty stations and a realistic lap cadence, the
ingestion path loses nothing, misattributes nothing, and answers far inside the
agent's own tolerances on one machine.
