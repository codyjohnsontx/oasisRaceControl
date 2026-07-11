# Oasis Race Control — web app

The Next.js app behind Oasis Race Control: mobile QR check-in (`/r/[token]`),
driver portal (`/me`), staff dashboard (`/staff`), the TV leaderboard (`/tv`),
and all API routes (driver auth, check-in, agent event ingestion, staff
actions).

Setup (Supabase project, env vars, schema + seed, staff user) and the demo
loop live in the [root README](../../README.md).

Quick reference once set up:

```bash
npm run dev        # http://localhost:3000
npm run fake-rig   # simulate a rig agent sending laps
npm test           # vitest unit tests
npm run build      # production build
```

Environment variables are documented in `.env.example` (copy to `.env.local`).
