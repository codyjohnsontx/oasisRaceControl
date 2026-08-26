#!/usr/bin/env bash
#
# Oasis Race Control - local Kubernetes workflow.
#
#   ./deploy/local/oasis-kind.sh up        # everything, from nothing to a URL
#   ./deploy/local/oasis-kind.sh help      # every subcommand
#
# Full walkthrough: docs/platform/local-kubernetes.md
#
# Two rules this script keeps, because it runs against whatever cluster your
# kubeconfig happens to be pointed at otherwise:
#
#   1. Every kubectl call names --context kind-oasis-race-control-dev. There is
#      no path through this file that touches the current context.
#   2. The only thing it ever deletes is inside that cluster, and the only
#      cluster it deletes is that one, by exact name.
set -euo pipefail

CLUSTER="oasis-race-control-dev"
CONTEXT="kind-${CLUSTER}"
NAMESPACE="oasis-race-control"

WEB_IMAGE="oasis-race-control/web:dev"
MIGRATE_IMAGE="oasis-race-control/migrate:dev"

# Everything is addressed from the repository root so the script works from any
# directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY="${REPO_ROOT}/deploy/k8s/overlays/local"
CLUSTER_CONFIG="${REPO_ROOT}/deploy/local/kind-cluster.yaml"
# Gitignored (deploy/local/.gitignore). Holds this cluster's generated
# SESSION_SECRET and development database password.
SECRETS_FILE="${REPO_ROOT}/deploy/local/cluster.env"

HOST_URL="http://localhost:8080"

# ---------------------------------------------------------------- output ----

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
die()  { printf '\n%sERROR%s %s\n\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- helpers ---

# Every cluster call goes through here. Nothing in this file calls kubectl
# without the context, which is what makes a stray `kubectl config
# use-context` on your machine irrelevant to what this script does.
kc() { kubectl --context "$CONTEXT" --namespace "$NAMESPACE" "$@"; }
kc_cluster() { kubectl --context "$CONTEXT" "$@"; }

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; }

require_cluster() {
  cluster_exists || die "cluster '${CLUSTER}' does not exist. Run: $0 cluster-up"
}

image_exists() { docker image inspect "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ check ---

cmd_check() {
  step "Checking prerequisites"
  local missing=0

  for tool in docker kubectl kind; do
    if command -v "$tool" >/dev/null 2>&1; then
      info "$(printf '%-9s %s' "$tool" "ok")"
    else
      printf '    %s%-9s missing%s\n' "$RED" "$tool" "$RESET"
      missing=1
    fi
  done

  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      info "$(printf '%-9s %s' "daemon" "Docker is running")"
    else
      printf '    %s%-9s Docker is installed but not running%s\n' "$RED" "daemon" "$RESET"
      missing=1
    fi
  fi

  if [ "$missing" -ne 0 ]; then
    printf '\n'
    note "macOS: brew install kind kubectl, and start Docker Desktop."
    note "kustomize is not needed - kubectl has it built in (kubectl kustomize)."
    die "prerequisites missing"
  fi

  # Renders the manifests without a cluster, so a YAML mistake surfaces here
  # rather than three minutes into a cluster build.
  if kubectl kustomize "$OVERLAY" >/dev/null; then
    info "$(printf '%-9s %s' "manifests" "deploy/k8s/overlays/local renders")"
  else
    die "deploy/k8s/overlays/local does not render"
  fi

  if cluster_exists; then
    note "cluster '${CLUSTER}' already exists"
  else
    note "cluster '${CLUSTER}' does not exist yet"
  fi
  printf '\n'
  info "All prerequisites present."
}

# ------------------------------------------------------------- cluster-up ---

cmd_cluster_up() {
  step "Creating the kind cluster '${CLUSTER}'"
  if cluster_exists; then
    info "Already exists - nothing to do."
  else
    kind create cluster --name "$CLUSTER" --config "$CLUSTER_CONFIG" --wait 120s
  fi
  kc_cluster get nodes
}

# ------------------------------------------------------------------ build ---

cmd_build() {
  step "Building images"
  note "context is the repository root: db/migrations lives outside apps/web"

  info "${WEB_IMAGE} (the app Kubernetes serves)"
  docker build --file "${REPO_ROOT}/apps/web/Dockerfile" --target runner \
    --tag "$WEB_IMAGE" "$REPO_ROOT"

  info "${MIGRATE_IMAGE} (migrations + fake-rig; development only)"
  docker build --file "${REPO_ROOT}/apps/web/Dockerfile" --target migrator \
    --tag "$MIGRATE_IMAGE" "$REPO_ROOT"

  docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}' \
    | grep '^    oasis-race-control/' || true
}

# ------------------------------------------------------------------- load ---

cmd_load() {
  require_cluster
  step "Loading images into the cluster"
  note "kind nodes have their own image store; a local docker build is not enough"

  for image in "$WEB_IMAGE" "$MIGRATE_IMAGE"; do
    image_exists "$image" || die "$image is not built. Run: $0 build"
    info "$image"
    kind load docker-image "$image" --name "$CLUSTER"
  done
}

# ---------------------------------------------------------------- secrets ---

cmd_secrets() {
  require_cluster
  step "Creating local secrets"

  if [ ! -f "$SECRETS_FILE" ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate local secrets"
    info "Generating ${SECRETS_FILE#"${REPO_ROOT}/"} (gitignored, first run only)"
    umask 077
    cat > "$SECRETS_FILE" <<EOF
# Generated by deploy/local/oasis-kind.sh - local kind cluster only.
# Gitignored. Nothing here is used by, or valid for, any real environment.
#
# SESSION_SECRET rotates in place: delete this file, re-run \`secrets\`, then
# \`kubectl rollout restart deployment/web\` to pick the new value up.
#
# POSTGRES_PASSWORD does not. The postgres image reads it only while initdb
# creates the data directory, and the PersistentVolumeClaim outlives every pod
# restart, so a regenerated password leaves web authenticating against a
# database that still has the old one. Changing it means \`cluster-down\` first -
# that is what discards the claim, and the next \`up\` initdbs from scratch.
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
# Hex, so it needs no escaping inside the connection string below.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF
  else
    info "Reusing ${SECRETS_FILE#"${REPO_ROOT}/"}"
  fi

  set -a
  # shellcheck source=/dev/null
  . "$SECRETS_FILE"
  set +a
  [ -n "${SESSION_SECRET:-}" ] || die "SESSION_SECRET is empty in ${SECRETS_FILE}"
  [ -n "${POSTGRES_PASSWORD:-}" ] || die "POSTGRES_PASSWORD is empty in ${SECRETS_FILE}"

  # The namespace has to exist before anything can go in it, and `apply -k`
  # has not run yet.
  kc_cluster apply -f "${REPO_ROOT}/deploy/k8s/base/namespace.yaml" >/dev/null

  # In-cluster Postgres, reached by its headless Service name. No sslmode: this
  # is one Docker network on one laptop. Production is Neon over TLS with the
  # pooled endpoint (docs/deploy.md).
  local database_url="postgres://oasis:${POSTGRES_PASSWORD}@postgres:5432/oasis"

  # --dry-run | apply, so re-running updates rather than failing on "already
  # exists". Both sides are piped; no value is ever printed.
  kc create secret generic postgres-dev \
    --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    --dry-run=client -o yaml | kc apply -f - >/dev/null
  kc create secret generic web-secrets \
    --from-literal=DATABASE_URL="$database_url" \
    --from-literal=SESSION_SECRET="$SESSION_SECRET" \
    --dry-run=client -o yaml | kc apply -f - >/dev/null

  info "Secrets postgres-dev and web-secrets are in place."
  note "values are never printed; read them with kubectl if you need them"
}

# ------------------------------------------------------------------ apply ---

cmd_apply() {
  require_cluster
  step "Applying deploy/k8s/overlays/local"

  kc get secret web-secrets >/dev/null 2>&1 \
    || die "secret 'web-secrets' is missing. Run: $0 secrets"

  # A Job's pod template is immutable, so a re-apply after any change to it
  # fails outright. Deleting first also makes re-running mean something:
  # migrations re-run (already-applied ones are skipped) and the seed re-runs
  # (every insert is conflict-ignore).
  if kc get job db-migrate >/dev/null 2>&1; then
    note "removing the previous db-migrate Job so it runs again"
    kc delete job db-migrate --wait=true >/dev/null
  fi

  kc_cluster apply -k "$OVERLAY"
}

# ------------------------------------------------------------------- wait ---

cmd_wait() {
  require_cluster
  step "Waiting for the deployment to come up"

  info "Postgres (development only)"
  kc rollout status statefulset/postgres --timeout=180s

  info "Migrations"
  # kubectl cannot wait on two conditions at once, so wait for 'complete' up to
  # the timeout and then classify however it ended: a Failed condition means the
  # Job gave up, anything else means it ran out of time. Either way, print the
  # Job's logs, because that is where the reason is. Failed arrives late by
  # design here - backoffLimit is 10 with restartPolicy OnFailure, so the Job is
  # still legitimately retrying a database that has not finished starting.
  if ! kc wait --for=condition=complete job/db-migrate --timeout=240s 2>/dev/null; then
    if kc get job db-migrate -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null | grep -q True; then
      kc logs job/db-migrate --tail=40 || true
      die "the db-migrate Job failed. Logs above; see also: $0 logs migrate"
    fi
    kc logs job/db-migrate --tail=40 || true
    die "the db-migrate Job did not finish in time. See: $0 logs migrate"
  fi
  kc logs job/db-migrate --tail=10 || true

  info "Web"
  kc rollout status deployment/web --timeout=240s
}

# ----------------------------------------------------------------- access ---

cmd_access() {
  require_cluster
  step "How to reach it"
  printf '\n'
  printf '    %s%s%s\n\n' "$BOLD" "$HOST_URL" "$RESET"
  info "  /                 driver landing page"
  info "  /tv               the wall board (laps from the fake rig land here)"
  info "  /r/demo-rig-1     check in as Rig 01, then the fake rig's laps are yours"
  info "  /staff            staff@oasis.test / oasis-staff-demo (seeded demo login)"
  info "  /api/health       liveness  - the process is up"
  info "  /api/ready        readiness - the database answered"
  printf '\n'
  note "host 8080 -> node 30080 comes from deploy/local/kind-cluster.yaml;"
  note "recreate the cluster if you change it."
  note "No NodePort? kubectl --context ${CONTEXT} -n ${NAMESPACE} port-forward svc/web 8080:80"
  printf '\n'

  step "Probing it"
  local code
  for path in /api/health /api/ready; do
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${HOST_URL}${path}" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      printf '    %s200%s  %s\n' "$GREEN" "$RESET" "$path"
    else
      printf '    %s%s%s  %s\n' "$RED" "${code:-no answer}" "$RESET" "$path"
    fi
  done
  printf '\n'
}

# ----------------------------------------------------------------- status ---

cmd_status() {
  require_cluster
  step "Nodes"
  kc_cluster get nodes -o wide
  step "Workloads"
  kc get deployments,statefulsets,jobs
  step "Pods"
  kc get pods -o wide
  step "Services and endpoints"
  kc get services
  kc get endpoints web
  step "Recent events"
  kc get events --sort-by=.lastTimestamp | tail -20
}

# ------------------------------------------------------------------- logs ---

cmd_logs() {
  require_cluster
  local component="${1:-web}"
  case "$component" in
    web|fake-rig|migrate|database) ;;
    postgres) component="database" ;;
    *) die "unknown component '${component}'. One of: web, fake-rig, migrate, database" ;;
  esac
  step "Logs: ${component} (Ctrl+C to stop)"
  # --all-containers so `logs web` also shows the await-migrations
  # initContainer, which is the one you want when pods are stuck in Init - and
  # so kubectl stops printing a "Defaulted container" warning per pod.
  kc logs --follow --tail=50 --prefix --all-containers \
    --selector "app.kubernetes.io/component=${component}"
}

# -------------------------------------------------------- demo-self-heal ---

cmd_demo_self_heal() {
  require_cluster
  step "Self-healing: delete a web pod and watch Kubernetes replace it"

  local victim
  victim="$(kc get pods -l app.kubernetes.io/component=web \
    -o jsonpath='{.items[0].metadata.name}')"
  [ -n "$victim" ] || die "no web pods are running"

  info "Before:"
  kc get pods -l app.kubernetes.io/component=web -o wide | sed 's/^/      /'

  step "Deleting ${victim}"
  kc delete pod "$victim" --wait=false
  note "nobody asked for a replacement - the ReplicaSet notices the shortfall"

  step "Waiting for the replacement to become Ready"
  kc rollout status deployment/web --timeout=180s

  info "After:"
  kc get pods -l app.kubernetes.io/component=web -o wide | sed 's/^/      /'
  printf '\n'
  info "${victim} is gone; a new pod took its place, on whichever node had room."
}

# ---------------------------------------------------------- demo-rollout ---

cmd_demo_rollout() {
  require_cluster
  step "Rolling update: replace every pod without losing capacity"

  info "Strategy:"
  kc get deployment web \
    -o jsonpath='      {.spec.strategy.type}, maxUnavailable={.spec.strategy.rollingUpdate.maxUnavailable}, maxSurge={.spec.strategy.rollingUpdate.maxSurge}{"\n"}'
  info "Before:"
  kc get pods -l app.kubernetes.io/component=web -o wide | sed 's/^/      /'

  step "Rolling"
  note "rollout restart rolls the same image; a new tag rolls exactly the same way"
  kc rollout restart deployment/web

  # Sample availability while it rolls. maxUnavailable: 0 is a claim, and this
  # is the measurement that backs it up.
  local desired min sample
  desired="$(kc get deployment web -o jsonpath='{.spec.replicas}')"
  min="$desired"
  ( kc rollout status deployment/web --timeout=240s ) &
  local status_pid=$!
  while kill -0 "$status_pid" 2>/dev/null; do
    sample="$(kc get deployment web -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"
    sample="${sample:-0}"
    if [ "$sample" -lt "$min" ]; then min="$sample"; fi
    sleep 1
  done
  wait "$status_pid"

  info "After:"
  kc get pods -l app.kubernetes.io/component=web -o wide | sed 's/^/      /'
  printf '\n'
  info "Lowest available replica count observed during the roll: ${min} of ${desired}."
  if [ "$min" -ge "$desired" ]; then
    info "maxUnavailable: 0 held - capacity never dropped."
  else
    note "Sampled once a second, so a brief dip can be real or can be the sampler"
    note "catching a status update mid-write. Watch it live with:"
    note "  kubectl --context ${CONTEXT} -n ${NAMESPACE} get pods -w"
  fi
  printf '\n'
  step "Revision history"
  kc rollout history deployment/web
  note "roll back with: kubectl --context ${CONTEXT} -n ${NAMESPACE} rollout undo deployment/web"
}

# ----------------------------------------------------------- cluster-down ---

cmd_cluster_down() {
  step "Deleting the kind cluster '${CLUSTER}'"
  if ! cluster_exists; then
    info "It does not exist - nothing to do."
    return 0
  fi
  # By exact name. This is the only delete in this file that reaches outside
  # the namespace, and it can only ever name this cluster.
  kind delete cluster --name "$CLUSTER"
  info "Gone, along with its PersistentVolumeClaim and everything in it."
  note "The images stay in your local Docker. Remove them with:"
  note "  docker rmi ${WEB_IMAGE} ${MIGRATE_IMAGE}"
  note "${SECRETS_FILE#"${REPO_ROOT}/"} is kept, so the next cluster comes up with"
  note "the same local secrets. Delete it to rotate them - and note that now, with"
  note "no PersistentVolumeClaim left, is the only time the database password can"
  note "change: the postgres image only reads it while initdb builds the data"
  note "directory."
}

# --------------------------------------------------------------------- up ---

cmd_up() {
  cmd_check
  cmd_cluster_up
  cmd_build
  cmd_load
  cmd_secrets
  cmd_apply
  cmd_wait
  cmd_access
}

# ------------------------------------------------------------------- help ---

cmd_help() {
  cat <<EOF
${BOLD}Oasis Race Control - local Kubernetes${RESET}

  $0 <command>

${BOLD}Everything at once${RESET}
  up               check, create, build, load, secrets, apply, wait, access

${BOLD}One step at a time${RESET}
  check            docker / kubectl / kind present, and the manifests render
  cluster-up       create the kind cluster '${CLUSTER}'
  build            build the web and migrator images
  load             load those images into the cluster's nodes
  secrets          generate and create the local Secrets (values never printed)
  apply            kubectl apply -k deploy/k8s/overlays/local
  wait             wait for Postgres, the migration Job, then the web rollout
  access           print the URL and probe /api/health and /api/ready

${BOLD}Looking at it${RESET}
  status           nodes, workloads, pods, services, recent events
  logs [component] follow logs: web (default), fake-rig, migrate, database

${BOLD}Demonstrations${RESET}
  demo-self-heal   delete a web pod, watch the ReplicaSet replace it
  demo-rollout     roll every pod and measure that capacity never dropped

${BOLD}Cleaning up${RESET}
  cluster-down     delete the kind cluster '${CLUSTER}' and everything in it

Every kubectl call is pinned to context ${CONTEXT}.
Walkthrough: docs/platform/local-kubernetes.md
EOF
}

# ------------------------------------------------------------------- main ---

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    check|check-prereqs)   cmd_check ;;
    cluster-up)            cmd_cluster_up ;;
    build)                 cmd_build ;;
    load)                  cmd_load ;;
    secrets)               cmd_secrets ;;
    apply)                 cmd_apply ;;
    wait)                  cmd_wait ;;
    access)                cmd_access ;;
    status)                cmd_status ;;
    logs)                  cmd_logs "$@" ;;
    demo-self-heal)        cmd_demo_self_heal ;;
    demo-rollout)          cmd_demo_rollout ;;
    cluster-down)          cmd_cluster_down ;;
    up)                    cmd_up ;;
    help|-h|--help)        cmd_help ;;
    *)                     printf '%sUnknown command: %s%s\n\n' "$RED" "$command" "$RESET" >&2; cmd_help >&2; exit 1 ;;
  esac
}

main "$@"
