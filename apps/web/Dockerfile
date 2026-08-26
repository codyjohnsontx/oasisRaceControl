# syntax=docker/dockerfile:1
#
# Oasis Race Control - web app container image.
#
# Build context is the REPOSITORY ROOT, not apps/web, because db/migrations
# lives outside the app and the `migrator` target needs it:
#
#   docker build -f apps/web/Dockerfile --target runner  -t oasis-race-control/web:dev     .
#   docker build -f apps/web/Dockerfile --target migrator -t oasis-race-control/migrate:dev .
#
# Two targets, one Dockerfile:
#
#   runner   - what serves the venue. Next standalone output only: no source,
#              no dev dependencies, no SQL, no TypeScript toolchain.
#   migrator - dev/ops only. Carries db/migrations and the repo's own
#              migrate/check scripts so the local overlay can run them as a
#              one-shot Job. It deliberately never serves traffic.
#
# The image build does NOT run `npm run build`. That script runs
# scripts/check-migrations.ts first, which needs a reachable database to say
# anything - and there is no database at `docker build` time. The gate belongs
# to the deploy, not to the image, so this calls `next build` directly and
# Vercel keeps running the gated `build` script unchanged (docs/deploy.md).

# Node 22 LTS, pinned to a patch release. Alpine keeps the runtime small; the
# app is pure JS with no native addons (pg is JS, bcryptjs is JS), so musl is
# not a risk here.
FROM node:22.23.2-alpine AS base
WORKDIR /app


# ---- deps: every dependency, dev included (the build and the migrator need them)
FROM base AS deps
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci


# ---- build: compile the app into .next/standalone
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Opt in to standalone output for this build only; see apps/web/next.config.ts
# for why it is not on by default.
ENV NEXT_OUTPUT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY apps/web/ ./
RUN npx next build


# ---- runner: the image Kubernetes runs
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `node` (uid/gid 1000) ships with the base image. Own the tree as that user so
# the container never needs root, and the Deployment can pin runAsNonRoot.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Next writes its fetch/ISR cache here at runtime. The pod mounts an emptyDir
# over it so the root filesystem can stay read-only; this line is what makes
# the image work when it does not.
RUN mkdir -p .next/cache && chown -R node:node .next/cache

USER node
EXPOSE 3000
# server.js is what `output: "standalone"` emits. `next start` is not used and
# is not even installed here.
CMD ["node", "server.js"]

LABEL org.opencontainers.image.title="Oasis Race Control web" \
      org.opencontainers.image.description="Driver check-in, live timing, league night, and TV leaderboard for Oasis Sim Racing" \
      org.opencontainers.image.source="https://github.com/codyjohnsontx/oasisRaceControl" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="docker.io/library/node:22.23.2-alpine"


# ---- tools-deps: only what the migrate / check / fake-rig scripts import
#
# Not `npm ci`: that tree is 788MB, and 410MB of it is `next` plus its swc
# binaries, which no script here imports. Not `npm ci --omit=dev` either -
# `next` is a runtime dependency of the app, so that still drags it in, and it
# drops `tsx`, which is exactly what runs a .ts script.
#
# The versions are read out of package-lock.json rather than written here, so
# the lockfile stays the single source of truth and this cannot quietly drift
# to a different `pg` than the app runs.
FROM base AS tools-deps
# package-lock.json only, deliberately. `npm install <pkg>` in a directory that
# has a package.json installs that manifest's dependencies too, which is how
# `next` gets back in through the side door.
COPY apps/web/package-lock.json ./
RUN npm install --no-save --no-audit --no-fund \
      $(node -e 'const l=require("./package-lock.json"); \
        process.stdout.write(["pg","dotenv","zod","tsx"] \
          .map((n)=>{const p=l.packages["node_modules/"+n]; \
            if(!p) throw new Error(n+" is not in package-lock.json"); \
            return n+"@"+p.version;}).join(" "));')


# ---- migrator: db/migrations + the repo's own migrate and check scripts
#
# This one mirrors the repository layout instead of flattening it, because the
# scripts resolve the SQL as ../../../db relative to themselves - the same walk
# they do in a checkout. Flatten the tree and that walk silently lands
# somewhere else.
FROM base AS migrator
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo/apps/web
COPY --from=tools-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node apps/web/package.json apps/web/tsconfig.json ./
COPY --chown=node:node apps/web/scripts ./scripts
# fake-rig.ts imports the shared event schemas from ../src/lib/events.
COPY --chown=node:node apps/web/src ./src
COPY --chown=node:node db /repo/db

USER node
# No default command: the migrate Job and the fake-rig Deployment each name
# their own, and an image that runs something by accident is worse than one
# that runs nothing.
CMD ["node", "--version"]

LABEL org.opencontainers.image.title="Oasis Race Control migrator" \
      org.opencontainers.image.description="Applies db/migrations and runs the fake-rig simulator; development and operations only, never serves traffic" \
      org.opencontainers.image.source="https://github.com/codyjohnsontx/oasisRaceControl" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="docker.io/library/node:22.23.2-alpine"
