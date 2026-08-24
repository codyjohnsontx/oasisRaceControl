# Oasis Race Control — web app

The Next.js app behind Oasis Race Control: every customer, staff, and venue
screen, plus all API routes. The surface-by-surface inventory of pages,
endpoints, and who calls what lives in
[docs/architecture.md](../../docs/architecture.md).

Setup (Postgres database, env vars, migrations + dev seed) and the demo loop
live in [Web app development](../../README.md#web-app-development) in the root
README.

Quick reference once set up:

```bash
npm run dev        # http://localhost:3000
npm run fake-rig   # simulate a rig agent sending laps
npm test           # vitest suites (see Integration tests in the root README)
npm run build      # production build - refuses to build against a database
                   # that is behind db/migrations
```

`npm run db:check` runs that migration check on its own, read-only, and names
the database it read. What the check does in each environment - production,
preview, local - is in
[Migration order](../../docs/deploy.md#migration-order-and-the-gate-that-enforces-it).

Environment variables are documented in `.env.example` (copy to `.env.local`).
