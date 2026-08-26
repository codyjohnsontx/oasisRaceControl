# Running Oasis Race Control on local Kubernetes

A `kind` cluster on your laptop that runs the venue's web tier the way a real
cluster would: two replicas behind a Service, real liveness and readiness
probes, a rolling-update strategy that never drops capacity, and a simulated
rig feeding it laps.

From nothing to a URL:

```bash
./deploy/local/oasis-kind.sh up
```

Then open **http://localhost:8080**.

This is a **development and demonstration environment**. Production is still
Vercel plus Neon and nothing here changes that - see
[deploy.md](../deploy.md).

---

## What actually runs, and what deliberately does not

```mermaid
flowchart TB
    browser["Browser / phone<br/>localhost:8080"]

    subgraph kind["kind cluster · oasis-race-control-dev"]
        direction TB
        subgraph ns["namespace: oasis-race-control"]
            direction TB
            svc["Service web<br/>NodePort 30080 → 3000"]
            web1["Pod web<br/>oasis-race-control/web"]
            web2["Pod web<br/>oasis-race-control/web"]
            pg[("StatefulSet postgres<br/>+ 1Gi PVC<br/>DEV ONLY")]
            job["Job db-migrate<br/>db/migrations + seed<br/>DEV ONLY"]
            rig["Deployment fake-rig<br/>scripts/fake-rig.ts<br/>DEV ONLY"]
        end
    end

    browser -->|"host 8080 → node 30080"| svc
    svc --> web1
    svc --> web2
    web1 -->|"pooled SQL"| pg
    web2 -->|"pooled SQL"| pg
    job -->|"applies db/migrations"| pg
    rig -->|"POST /api/agent/events<br/>GET /api/agent/assignment"| svc

    classDef dev fill:#3a2f0b,stroke:#c99b1e,color:#f6e6b8;
    classDef app fill:#0d3b45,stroke:#5ce1e6,color:#e6fbfd;
    class pg,job,rig dev;
    class web1,web2,svc app;
```

**In the cluster:** the Next.js app (`apps/web`), and nothing else in the base
manifests.

**Not in the cluster, on purpose:**

| Piece | Why not |
|---|---|
| **`apps/rig-agent`** | .NET 8 **win-x64**. It reads iRacing's shared memory on the simulator's own Windows machine and buffers laps in a local SQLite outbox. It cannot run in a Linux container, and containerizing it would describe an architecture the venue does not have: the agent is *installed on a sim PC*, not deployed. |
| **`spike/`** | The telemetry recorder is Windows-only and gated behind [venue-safety.md](../venue-safety.md). |
| **Postgres, in the base** | Production is **Neon**, a managed service. A database in the base manifests would be a lie about where the venue's data lives. The **local overlay** adds one so a laptop cluster is self-contained; it is labelled `oasis.dev/tier: development-only` and is not tuned, backed up, or replicated. |

---

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| Docker | builds the images and hosts kind's nodes | Docker Desktop |
| `kubectl` ≥ 1.29 | talks to the cluster, and **already contains kustomize** | `brew install kubectl` |
| `kind` ≥ 0.20 | the cluster itself | `brew install kind` |
| `openssl` | generates the local secrets | ships with macOS |

There is nothing else. In particular **you do not need to install kustomize** -
`kubectl kustomize` is the same tool, built in.

```bash
./deploy/local/oasis-kind.sh check
```

---

## The images

One Dockerfile, `apps/web/Dockerfile`, with two targets. **The build context is
the repository root**, not `apps/web`, because `db/migrations` lives outside the
app and the migrator target needs it.

| Target | Tag | Size | What it is |
|---|---|---|---|
| `runner` | `oasis-race-control/web:dev` | ~216 MB | What Kubernetes serves. Next's standalone output only: no source, no dev dependencies, no SQL, no TypeScript toolchain. |
| `migrator` | `oasis-race-control/migrate:dev` | ~177 MB | Development and operations only. `db/migrations` plus the repository's own `migrate.ts`, `check-migrations.ts` and `fake-rig.ts`. It never serves traffic. |

```bash
docker build -f apps/web/Dockerfile --target runner   -t oasis-race-control/web:dev     .
docker build -f apps/web/Dockerfile --target migrator -t oasis-race-control/migrate:dev .
# or: ./deploy/local/oasis-kind.sh build
```

Both run as the unprivileged `node` user (uid 1000), pin the base image to a
patch release (`node:22.23.2-alpine`), and carry OCI labels. No credential is
baked into either: the only two the app reads are injected as a Secret at run
time.

### Three build decisions worth knowing

**1. The image build does not run `npm run build`.** That script runs
`scripts/check-migrations.ts` first, which needs a reachable database to say
anything - and there is no database at `docker build` time. The gate belongs to
the *deploy*, not to the image, so the Dockerfile calls `next build` directly.
Vercel keeps running the gated `build` script exactly as before
([deploy.md](../deploy.md#migration-order-and-the-gate-that-enforces-it)). The
gate is not lost in Kubernetes either - it moved into the rollout, see
[the migration Job](#migrations-run-before-the-web-pods-do) below.

**2. `output: "standalone"` is opt-in, not always-on.** `apps/web/next.config.ts`
turns it on only when `NEXT_OUTPUT_STANDALONE=1`, which only the Dockerfile
sets. Turning it on unconditionally would have changed two paths that have
nothing to do with containers: `next start` warns `"next start" does not work
with "output: standalone"`, and `AGENTS.md` documents `npm run build && npm run
start` as the only way to verify `/tv`'s failure behaviour - and Vercel builds
its own output format, which is not this milestone's thing to experiment with.
Opt-in leaves both untouched.

**3. The migrator does not use `npm ci`.** That tree is 788 MB, and 410 MB of it
is `next` plus its swc binaries, which no script in that image imports.
`npm ci --omit=dev` does not help either - `next` is a runtime dependency of the
app, and `tsx` is exactly what runs a `.ts` script. So the migrator installs
only `pg`, `dotenv`, `zod` and `tsx`, at versions **read out of
`package-lock.json`** rather than written into the Dockerfile, so the lockfile
stays the single source of truth.

---

## How the manifests are organised

```
deploy/
├── k8s/
│   ├── base/                     # any cluster: the web tier and nothing else
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── configmap.yaml        # non-secret env
│   │   ├── deployment.yaml       # 2 replicas, probes, limits, securityContext
│   │   ├── service.yaml          # ClusterIP
│   │   └── secret.template.yaml  # NOT applied by any kustomization
│   └── overlays/
│       └── local/                # everything a laptop has to stand in for
│           ├── kustomization.yaml
│           ├── postgres.yaml                    # StatefulSet + PVC  (dev only)
│           ├── migrate-job.yaml                 # db/migrations + seed (dev only)
│           ├── fake-rig.yaml                    # lap simulator      (dev only)
│           ├── web-await-migrations-patch.yaml  # ordering, enforced
│           └── web-nodeport-patch.yaml          # host access
└── local/
    ├── oasis-kind.sh             # the whole workflow
    ├── kind-cluster.yaml         # 3 nodes, host 8080 → node 30080
    └── cluster.env               # generated, gitignored
```

Render either without a cluster:

```bash
kubectl kustomize deploy/k8s/base
kubectl kustomize deploy/k8s/overlays/local
```

Everything the overlay adds carries `oasis.dev/tier: development-only`, so one
selector finds all of it:

```bash
kubectl -n oasis-race-control get all -l oasis.dev/tier=development-only
```

### Two replicas - checked, not assumed

The brief for this milestone was to start at one replica unless more was
provably safe. Two is, and here is the check:

| Concern | Finding |
|---|---|
| Sessions | Stateless **HS256 JWT cookies** (`src/lib/driver-session.ts`, `src/lib/staff.ts`). No server-side session store, so any pod can verify a cookie any other pod signed. Verified live: a check-in signed by one replica was accepted by the other. |
| WebSockets / SSE | None. Every surface polls on a timer (`docs/architecture.md`). Nothing has to stay pinned to one instance. |
| Scheduled jobs | None. Opening a round and rolling a season are human actions from `/staff`. |
| Migrations | Never run by the app. |
| Check-in races | Enforced by Postgres - `checkin_driver()` plus the `one_open_assignment_per_rig` partial unique index - not by a single process holding a lock. |
| Rate limiting | **Does** become per-pod. See [Known limitations](#known-limitations). |

### The probes, and why a database outage is not a restart loop

Three probes answering three different questions is the whole design:

| Probe | Endpoint | Question | What failing it does |
|---|---|---|---|
| `startupProbe` | `/api/health` | has the process finished booting? | holds the other two off (up to 60s) |
| `livenessProbe` | `/api/health` | is the process alive? | **restarts the container** |
| `readinessProbe` | `/api/ready` | can this pod serve? | **removes it from the Service** |

`/api/health` touches nothing outside the process, so only a wedged Node process
gets restarted. `/api/ready` runs one `select 1` through the app's own pool
under a 2-second deadline - and the probe's `timeoutSeconds` is set to 5,
deliberately above it, so the route's plain-English 503 reason arrives instead
of the probe failing on its own clock (`src/app/api/ready/route.ts` says the
same thing from the other side).

Demonstrated on this cluster by scaling the dev database to zero:

```
/api/ready   503  {"status":"unavailable","reason":"database connection or query failed (ENOTFOUND)"}
/api/health  200
pods         Running, 0/1 Ready, RESTARTS = 0
```

and on scaling it back, readiness recovered on its own with the restart count
still `0`. If liveness had been wired to the database instead, every pod would
have been killed and rescheduled repeatedly for the length of the outage,
turning a database problem into an app problem.

### Migrations run before the web pods do

Production's rule is "migrate the database first, then deploy the code", and it
is enforced by a build gate rather than automation: nothing applies DDL to the
venue's database unattended ([deploy.md](../deploy.md)).

A throwaway cluster has no human in that loop, so the local overlay does two
things:

1. A one-shot **Job `db-migrate`** runs the same `scripts/migrate.ts` the runbook
   does (with `--seed`, which is the other reason it is development-only - it
   inserts the demo rigs, demo staff login and demo driver PINs published in
   `db/seed.sql`).
2. The web pods carry an **initContainer that will not let them start** until
   that work is visible, by running the repository's own
   `scripts/check-migrations.ts` in a retry loop. It exits 0 only once every
   migration file is recorded in `schema_migrations`.

So the ordering is a property of the rollout, not an instruction someone has to
remember. Until the Job finishes, pods sit in `Init` and say so.

---

## Environment variables and secrets

The application's entire configuration surface is two variables, and **both are
secrets**:

| Variable | What it is | Where it comes from locally |
|---|---|---|
| `DATABASE_URL` | Postgres connection string. Neon's **pooled** endpoint in production. | built by the script from the generated dev password |
| `SESSION_SECRET` | signs driver and staff session cookies (HS256) | generated, `openssl rand -base64 48` |

What is left is placement rather than configuration, and lives in the ConfigMap
`web-env`: `NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_TELEMETRY_DISABLED`.

`./deploy/local/oasis-kind.sh secrets` generates both into
`deploy/local/cluster.env` (**gitignored**, `umask 077`, first run only) and
creates two Secrets from it - `web-secrets` and `postgres-dev`. **It never
prints a value**, and no generated value is ever written anywhere else.

For a cluster that is not this one, `deploy/k8s/base/secret.template.yaml` shows
the shape. It is deliberately **not listed in any kustomization**, so
`kubectl apply -k` cannot create a Secret and no real value can ride into git
behind one. Prefer the imperative form, which never touches disk:

```bash
kubectl create secret generic web-secrets \
  --namespace oasis-race-control \
  --from-literal=DATABASE_URL='postgres://user:pass@host:5432/oasis?sslmode=require' \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)"
```

Rotating means replacing the Secret and restarting the pods - `envFrom` is read
once, at container start:

```bash
kubectl -n oasis-race-control rollout restart deployment/web
```

---

## The exact commands

`./deploy/local/oasis-kind.sh up` runs all of these in order. Each is also a
subcommand you can run on its own, and every one is safe to re-run.

| Step | Command | What it does |
|---|---|---|
| 1 | `oasis-kind.sh check` | tools present, Docker running, manifests render |
| 2 | `oasis-kind.sh cluster-up` | creates kind cluster `oasis-race-control-dev` (1 control-plane + 2 workers) |
| 3 | `oasis-kind.sh build` | builds both images |
| 4 | `oasis-kind.sh load` | loads them into the nodes - kind has its own image store, a local `docker build` is not enough |
| 5 | `oasis-kind.sh secrets` | generates and creates the Secrets |
| 6 | `oasis-kind.sh apply` | `kubectl apply -k deploy/k8s/overlays/local` |
| 7 | `oasis-kind.sh wait` | Postgres, then the migration Job, then the web rollout |
| 8 | `oasis-kind.sh access` | prints the URL and probes both health endpoints |

From nothing to a probed URL, `up` takes about **3m40s** on an M-series laptop,
most of it the first image build and `kind load`. Re-running it after that is
much faster: every step is idempotent, and the image layers are cached.

Every `kubectl` call in that script is pinned to
`--context kind-oasis-race-control-dev`. There is no path through it that
touches your current context, and the only cluster it will ever delete is that
one, by exact name.

---

## Reaching it

**http://localhost:8080**

| Path | What you get |
|---|---|
| `/` | driver landing page |
| `/tv` | the wall board - the fake rig's laps land here |
| `/r/demo-rig-1` | check in as Rig 01 |
| `/staff` | `staff@oasis.test` / `oasis-staff-demo` (seeded demo login) |
| `/api/health` | liveness - the process is up |
| `/api/ready` | readiness - `{"status":"ok","appliedMigrations":3}` |

That works because `deploy/local/kind-cluster.yaml` maps host port 8080 to node
port 30080, and the local overlay makes the Service a NodePort listening there.
kind's nodes sit on Docker's network, so a ClusterIP alone is not reachable from
a browser. NodePort is the right tool for a laptop and the wrong one for a real
cluster, which is why it is a patch in the overlay and not in the base.

If port 8080 is taken, skip the NodePort entirely:

```bash
kubectl --context kind-oasis-race-control-dev -n oasis-race-control \
  port-forward svc/web 9090:80
```

### Seeing laps arrive

The `fake-rig` Deployment runs `apps/web/scripts/fake-rig.ts` against the
in-cluster Service. It speaks the real wire contract - heartbeats, an assignment
poll, `LAP_COMPLETED` events stamped with the assignment that was open when the
lap was captured, and a deliberate duplicate `eventId` to prove idempotency.

Until somebody checks in, its laps arrive with nobody in the seat and are stored
**unattributed** - kept, unrankable, listed on `/staff` under *Unclaimed laps*.
That is the designed behaviour (`AGENTS.md`, "Lap attribution"), not a
misconfiguration. Open `/r/demo-rig-1`, check in as a guest, and the next lap is
yours on `/me`, `/leaderboards` and `/tv`.

---

## Inspecting it

```bash
./deploy/local/oasis-kind.sh status      # nodes, workloads, pods, services, events
./deploy/local/oasis-kind.sh logs web    # or: fake-rig · migrate · database
```

By hand:

```bash
K="kubectl --context kind-oasis-race-control-dev -n oasis-race-control"

$K get pods -o wide
$K describe pod <name>                       # events are at the bottom - read them first
$K get events --sort-by=.lastTimestamp | tail -20
$K logs deployment/web --all-containers --tail=100
$K logs job/db-migrate                       # what the migration actually did
$K get endpoints web                         # which pods the Service is sending traffic to
$K exec -it deployment/web -- sh             # read-only root filesystem, so look, don't write
```

---

## Demonstrating self-healing

```bash
./deploy/local/oasis-kind.sh demo-self-heal
```

It deletes one web pod and waits. Nobody asks for a replacement - the
ReplicaSet notices the shortfall and creates one, and the pod anti-affinity puts
it on whichever node is not already running one. Observed on this cluster: the
replacement was `Ready` **8 seconds** later, and the Service kept serving from
the surviving replica throughout.

By hand:

```bash
$K delete pod "$($K get pods -l app.kubernetes.io/component=web -o jsonpath='{.items[0].metadata.name}')"
$K get pods -w
```

## Demonstrating a rolling update

```bash
./deploy/local/oasis-kind.sh demo-rollout
```

The strategy is `RollingUpdate` with **`maxUnavailable: 0`** and
`maxSurge: 1`: bring a new pod up, wait for it to pass `/api/ready`, and only
then take an old one away. Full capacity through a deploy, at the cost of room
for one extra pod.

The script samples `availableReplicas` once a second while it rolls and reports
the lowest it saw, because "never drops capacity" is a claim and that is the
measurement behind it. Observed: **2 of 2 throughout**. Measured separately with
real traffic - one request per moment for the length of a roll - **526 requests,
0 failures**.

Two things do that, and the second is the one people forget. `maxUnavailable: 0`
keeps a replacement Ready before an old pod goes away. The **`preStop` sleep of
5 seconds** covers the race after that: endpoint removal and the `TERM` signal
are not ordered, so kube-proxy can still be sending a pod connections for a
moment after the kubelet has told it to stop. Sleeping first lets the Service
forget the pod before the server starts refusing.

A dying pod briefly shows `STATUS Error` with exit code 143. That is Next's own
deliberate exit code for a signal termination, not a failed shutdown - see
[Troubleshooting](#troubleshooting).

`rollout restart` rolls the same image; a new tag rolls exactly the same way:

```bash
$K set image deployment/web web=oasis-race-control/web:v2
$K rollout status deployment/web
$K rollout history deployment/web
$K rollout undo deployment/web        # back one revision
```

## Cleaning up

```bash
./deploy/local/oasis-kind.sh cluster-down
```

Deletes the kind cluster by exact name, and with it the PersistentVolumeClaim
and everything in the namespace. The images stay in your local Docker:

```bash
docker rmi oasis-race-control/web:dev oasis-race-control/migrate:dev
```

`deploy/local/cluster.env` is kept, so the next cluster comes up with the same
local secrets. Delete it to rotate them.

---

## Known limitations

These are real and are not fixed in this milestone.

- **The rate limiter becomes per-pod.** `src/lib/rate-limit.ts` is an in-memory
  sliding window, so two replicas means roughly twice the effective allowance
  for unauthenticated routes. It was already per-instance on Vercel serverless,
  so this is not a regression - but two pods make it concrete. A shared store
  (a Postgres counter, or Redis) is the fix, and it is out of scope here.
- **The local Postgres is not the venue's Postgres.** One replica, no backups,
  no tuning, no TLS, a 1 Gi PVC, and a password that lives on your laptop. It
  exists so `kind` is self-contained.
- **No Ingress and no TLS.** Access is a NodePort mapped to a host port.
- **No autoscaling, no metrics, no tracing, no alerting.** `kubectl top` will
  not work: metrics-server is not installed.
- **Images are local-only.** Nothing is pushed to a registry; `kind load` copies
  them into the nodes. A real cluster needs a registry and an
  `imagePullSecret`.
- **The migration Job seeds demo data.** Demo rigs, a demo staff login, demo
  driver PINs - all published in `db/seed.sql`. Development only, always.
- **`kubectl top`, HPA, PodDisruptionBudgets and NetworkPolicies are absent.**
  A single-node-per-workload laptop cluster cannot demonstrate them honestly.
- **This is not a load test.** Nothing here says anything about how the app
  behaves under venue traffic, and no number in this document should be read
  that way.

---

## Not in this milestone

Named explicitly so nobody has to guess what "first working version" excluded:

**Terraform · Argo CD or any GitOps controller · cloud Kubernetes (EKS/AKS/GKE) ·
Horizontal Pod Autoscaling · Prometheus · Grafana · OpenTelemetry · Kafka or any
queue · Ingress controller · cert-manager or TLS · a container registry ·
NetworkPolicy · PodDisruptionBudget · canary or blue/green deployments ·
policy-as-code (OPA/Gatekeeper) · a load-test harness · image signing or SBOMs ·
running the .NET rig agent anywhere but a Windows sim PC.**

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Pods stuck in `Init:0/1` | The `db-migrate` Job has not finished. `oasis-kind.sh logs migrate`. The initContainer gives it 3 minutes, then fails loudly on purpose. |
| Pods stuck in `CreateContainerConfigError` | Secret `web-secrets` is missing. `oasis-kind.sh secrets`. The Deployment references it non-optionally so a pod without it fails to start rather than serving 500s while passing liveness. |
| `ErrImageNeverPull` / `ImagePullBackOff` | The image was built but not loaded into the nodes. `oasis-kind.sh load`. kind nodes have their own image store. |
| `0/1 Ready`, `/api/ready` returns 503 | Read the `reason` in the body. `DATABASE_URL is not set` means the Secret is wrong; anything else means the database is unreachable. Check `postgres-0`. |
| `http://localhost:8080` refuses the connection | Something else has port 8080, or the cluster predates `kind-cluster.yaml`'s port mapping. Port mappings are fixed at cluster creation - `cluster-down` then `up`, or use `port-forward`. |
| `The connection to the server ... was refused` | The cluster is gone or Docker restarted. `kind get clusters`, then `cluster-up`. |
| `db-migrate` fails with `42703 undefined_column` | A database that applied an older copy of a migration. Locally: delete the cluster and start again. Never on a real database - see [deploy.md](../deploy.md#recovering-a-database-that-is-behind-the-code). |
| Rollout hangs at `1 out of 2 new replicas` | The new pod is not passing readiness. `kubectl describe pod` on it and read the events. `progressDeadlineSeconds` is 300, so it will fail rather than hang forever. |
| `fake-rig` logs `fetch failed` | Normal while `web` is still coming up; it retries. Persistent means DNS or the Service - `kubectl get endpoints web`. |
| A pod being replaced shows `STATUS Error`, exit code 143 | Not a failure. Next installs its own SIGTERM handler, runs its cleanup, then exits `143` deliberately - "a signal-based exit code so Node treats this as a signal termination". Kubernetes calls any non-zero exit `Error`, and the pod is garbage-collected moments later. |

---

## The roadmap after this

Each of these is a separate milestone. The point of listing them is that each
solves a problem this milestone leaves open, rather than adding a technology for
its own sake.

| # | Milestone | The engineering problem it solves | What it demonstrates |
|---|---|---|---|
| 1 | **Terraform for a small EKS or AKS environment** | The cluster here is created by a script that only works on a laptop. Nothing describes the network, the node pools, or the IAM a real cluster needs, and nothing can recreate them. | Infrastructure as code, provider IAM, remote state and locking, plan/apply review as a change-control step. |
| 2 | **Argo CD (GitOps)** | Deploying is currently "somebody ran `kubectl apply`". There is no record of what is deployed, no drift detection, and no rollback that is not another manual command. | Declarative delivery, git as the source of truth, sync/health status, drift detection, and a rollback that is a git revert. |
| 3 | **Prometheus-compatible metrics and alerts** | Right now the only signal is a probe answering 200 or 503. Nothing records lap ingestion rate, ingestion errors, or how long `/api/agent/events` takes, so a slow degradation is invisible until someone at the venue notices. | Instrumenting an app with meaningful domain SLIs, not just CPU; alert rules with thresholds you can defend. |
| 4 | **OpenTelemetry traces on the ingestion path** | A lap crosses the agent's outbox, `/api/agent/events`, attribution, and several SQL statements. When one is slow, there is no way to tell which. | Distributed tracing across an async boundary, and context propagation from a client that may be hours behind. |
| 5 | **Horizontal Pod Autoscaling on a meaningful signal** | Two replicas is a guess. League night is the venue's busiest hour by far and nothing responds to it. | Choosing a scaling signal that matches the workload (in-flight requests or ingestion queue depth beat CPU for an I/O-bound app), and knowing why. |
| 6 | **A queue in front of ingestion - only if it earns its place** | The agent's SQLite outbox already absorbs backpressure, so a broker would currently add an operational component with no failure it fixes. It becomes justified if ingestion grows fan-out consumers. | Judgement: being able to say why a queue is *not* needed yet is a stronger signal than adding Kafka. |
| 7 | **A documented canary or blue/green deploy** | `maxUnavailable: 0` protects capacity during a rollout but not correctness - a bad build reaches 100% of traffic as fast as it can pass a readiness probe. | Progressive delivery, traffic splitting, and automated rollback on a metric rather than on someone watching. |
| 8 | **Failure testing and a small load-test harness** | Every number in this document came from one laptop, by hand. Nothing reproduces them, and nothing tests pod eviction, node loss, or a database failover. | Reproducible experiments and honest performance claims - including saying what was *not* measured. |
| 9 | **Policy-as-code (OPA/Gatekeeper)** | The security contexts here hold because the manifests happen to be written that way. Nothing stops the next manifest from running as root. | Enforcing platform invariants at admission, so guarantees do not depend on review. |

---

## See also

- [deploy.md](../deploy.md) - the real deploy: Vercel, Neon, and the rig agents
- [architecture.md](../architecture.md) - how the tiers talk to each other
- [../../README.md](../../README.md) - the app itself, and local development without Kubernetes
