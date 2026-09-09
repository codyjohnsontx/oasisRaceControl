# The twenty-rig soak

The venue has 20-25 simulators. The platform is built for all of them and, until
this run, had only ever been exercised by one rig at a time - the fake-rig
simulator drives one token, and `SimulatedTelemetrySource` drives one agent. So
"twenty stations" was a design intent with nothing measured behind it.

This is the measurement. Twenty concurrent rig processes against a local
production build, held long enough to matter, asserting the two things that
decide whether the venue works at that width: **every lap is stored exactly once
and credited to the right driver**, and **the write path stays inside the
timings the real .NET agent is built around**.

Run it with [`apps/web/scripts/soak.ts`](../apps/web/scripts/soak.ts). The
committed result of the run described here is
[`soak-20-rigs.json`](soak-20-rigs.json).

---

## The run

**2026-09-08, run `20260908T165259`. 20 rigs, 30.3 minutes, all seven checks passed.**
Full machine-readable result: [`soak-20-rigs.json`](soak-20-rigs.json).

> **The committed JSON has seven checks; the script now emits eight.** That file
> is the run exactly as measured and is never regenerated or edited - a number
> it did not measure would be a fabricated one. The eighth check (*every lap a
> rig announced has a recorded outcome*) and the `laps.indeterminate` and
> `requests.unusableAnswers` fields were added afterwards, so a reader comparing
> the two is looking at a change in the output's shape, not at a check that
> quietly disappeared. Nothing added since
> moved a measured value: the reconciliation was re-run against the raw
> per-worker metrics and the database, and the figures below still hold.

| | |
|---|---|
| Load | 20 rigs, one lap per 20 s each, against a local `next start` production build |
| Machine | Apple M1 Pro, 10 cores, 16 GB, Node v22.23.1, PostgreSQL 17.10 |
| Requests | **6,650** (3.65/s) - 1,800 lap posts, 1,220 heartbeats, 3,630 assignment polls |
| Laps | **1,800 sent** → 1,663 distinct + 137 deliberate resends → **1,663 stored** |
| Losses | **0** laps lost, **0** misattributed, **0** unattributed, **0** strays |
| Errors | **0** transport errors, **0** non-200 responses |

```
events   p50 8ms   p90 23ms   p95 29ms   p99 51ms   max 346ms
polls    p50 6ms   p90 17ms   p95 23ms   p99 42ms   max 337ms
```

### What the numbers say

**Nothing was lost and nothing was misfiled.** 1,663 distinct laps sent, 1,663 stored, every
one credited to the driver in that seat. The 137 deliberate resends produced exactly 137
`duplicate` verdicts and not one extra row, so the idempotency key holds under twenty
concurrent writers rather than merely usually holding.

**The write path is nowhere near the agent's tolerances.** p95 of 29 ms sits **172x** under
the agent's 5 s flush interval, and the single worst request of the run - 346 ms - is **43x**
under its 15 s HTTP timeout. At this width the backend is not the constraint.

**The 258 invalid laps are the simulator's doing, not a finding.** `fake-rig.ts` generates
roughly 15% dirty laps (`incidentDelta > 0`) and the seeded combo runs a 0-incident limit;
258 of 1,663 is 15.5%. They are stored invalid with a reason, which is the correct outcome.

### Two honest caveats about this particular run

**It ran for 30 minutes, not the hour originally planned.** This machine was running five
other agent workers at the time and had already lost workers to memory exhaustion earlier in
the day, so the run was deliberately shortened to halve the exposure. 1,800 lap posts is
still an ample sample for p95 and p99; it is a thinner one for `max`, which is a single
observation by definition. Free memory held between 35% and 60% throughout and swap did not
climb (1.34 GB, flat), so the soak itself was never the machine's problem.

**The machine was shared, and that makes these numbers conservative rather than flattering.**
System load average spiked to 34 on 10 cores around the 15-minute mark from unrelated work
while the rig worker count stayed constant at 20. The 346 ms maximum was measured under that
contention. A dedicated machine would report lower, not higher - so the ceiling recorded here
is a safe one to compare against.

---

## What it asserts, and why those numbers

Eight checks, and the script exits non-zero if any of them fails.

| Check | Why it is the one that matters |
|---|---|
| Every lap sent is stored | The outbox exists so a lap survives an outage. A lap that reaches the backend and then vanishes is the failure no retry can fix. |
| Every lap is credited to the driver in that seat | The project's stated core invariant. Twenty rigs writing concurrently is exactly where a shared-state mistake would show up as somebody else's lap time. This is also the check that catches cross-talk - one rig's lap landing on another rig's assignment - because the comparison is against the rig that ANNOUNCED each lap, taken from that rig's own metrics file, not against the rig the lap was stored under (`scripts/soak-attribution.ts`). |
| No lap appears that no rig sent | Catches a lap on a soak rig that no rig announced at all - a worker left over from another run, say, still posting with a token this run reused. A lap one of this run's rigs announced is NOT this check's business however badly it landed: it carries an announced event id, so it is excluded here by construction and answered for by the attribution check above or the outcome check below. |
| Every lap a rig announced has a recorded outcome | fake-rig writes a line naming each lap **before** it sends it, so a worker killed between the backend committing the row and the outcome line being written is still known to have sent it. Those laps are held out of the stray count above and counted here instead, with their ids: this run cannot say whether they were stored, so it says that rather than accusing the backend of inventing a lap. Non-zero fails the run - a measurement that could not account for something must not pass quietly. |
| Duplicate event ids were absorbed | fake-rig deliberately re-sends about one lap in fourteen. Under concurrency the idempotency key has to hold, not merely usually hold. Reported **indeterminate** (and not passed) if any lap post came back without a verdict, or with an `error` verdict saying the row was not stored: a failed original followed by a successful resend would otherwise read as the backend failing to absorb a duplicate, which is an accusation the evidence does not support. |
| Every request answered 200 | A 500 is survivable (the agent retries) but it is not "twenty stations working". Three failures, counted apart because they send whoever chases them to three different places: a **transport error** (no answer at all), a **non-200**, and an **answered but unusable** request - a 200 whose body would not parse, which is not a network fault and is not counted as one. |
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

# 4. The soak. `--minutes 30` is what produced the committed result above;
#    raise it on a machine that has the run to itself.
npx tsx scripts/soak.ts --rigs 20 --minutes 30 --base http://127.0.0.1:3111 \
  --out ../../docs/soak-20-rigs.json
```

`--rigs`, `--minutes`, `--interval`, `--base`, `--work` and `--out` are all
adjustable; `scripts/soak.ts`'s header documents them. A two-minute run is
enough to check the harness itself before spending real time on it.

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

A run that lost a worker part-way, or never heard from one at all, is refused
with an error instead of being summarised: its traffic stopped when the worker
did, so every check would still pass - over less load than the summary would
claim it was. A run holding a metrics line the reader cannot parse is refused
for the same reason from the other direction: that request drops out of the
reconciliation, and a lap already in the database would then be reported as a
stray nobody sent. A worker whose metrics line cannot be written at all - a
full disk, an unwritable `--work` - ends itself rather than carrying on
unrecorded, so it arrives here as a lost worker instead of as a file with
silent holes in it. There is no JSON from such a run, which is deliberate;
re-run it.

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
- **Thirty minutes, not a venue night.** Long enough to rule out per-request
  faults and to size p95 and p99; too short to say anything about connection-pool
  exhaustion, table bloat or anything else that only appears after hours.

What it does establish: at twenty stations and a realistic lap cadence, for half
an hour on one machine, the ingestion path loses nothing, misattributes nothing,
and answers far inside the agent's own tolerances.
