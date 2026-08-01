# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## The `/tv` board rotation

`/tv` is an unattended wall display that cycles board types on a timer. Adding a
new kind of board (league standings, rig status) means writing one
`defineTvBoard` in `apps/web/src/components/tv/board-types.tsx` and listing it in
`buildRotation` - do not modify the rotation engine (`tv-screen.tsx`) or write a
second ranking implementation. The contract and the rules the engine guarantees
are documented in `apps/web/src/lib/tv-rotation.ts`.

Board data comes from the same public APIs `/leaderboards` uses, so the wall and
the phone agree by construction.

## Verifying `/tv` failure behaviour needs a production build

Test feed outages against `npm run build && npm run start`, not `npm run dev`.
Next's dev HMR client force-reloads the page when the dev server dies, so the tab
lands on Chrome's own error page and you cannot tell whether the app recovered.
Under `next start` the page stays put and self-heals, which is what the kiosk does.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
