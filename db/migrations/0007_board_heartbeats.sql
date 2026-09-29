-- Oasis Race Control - the TV board's own heartbeat, and event mode.
--
-- The rig monitor (apps/web/src/lib/monitor/) could see every rig but not the
-- screen the room watches. A /tv page now posts a heartbeat every 30 s
-- (POST /api/tv/heartbeat) and a goodbye when it is closed, so the monitor can
-- tell a board that went dark - laptop asleep, browser killed - from one that
-- was closed on purpose, and a board that is up but cannot load its numbers.
-- Each open page is one row, upserted: a page load mints its own board id.
--
-- The same heartbeat switches event mode: while an event board (/tv?event=1)
-- is open, the monitor treats the venue as mid-event - rig silence is urgent,
-- a missing featured combo is urgent, and the 20-minute update posts. Staff
-- can force it on or off until venue midnight (monitor_state's override
-- columns, created by 0006). event_mode and event_mode_changed_at below record
-- the mode the channel was last told about, so a flip is posted once.
--
-- Additive: one new table, one index, two new monitor_state columns with
-- defaults. ADD COLUMN with a constant default is a catalog-only change on
-- Postgres 11+, and monitor_state holds one row, so the ACCESS EXCLUSIVE lock
-- it takes is momentary. A database ahead of the code is harmless (the previous
-- deployment never reads any of it); a database behind it fails every
-- evaluation and every board heartbeat, which only logs - the wall keeps
-- showing laps - and the build gate refuses the deploy anyway
-- (docs/deploy.md).

create table board_heartbeats (
  -- Minted by the server when it renders /tv, one per page load, and signed
  -- into the page's ticket together with mode and host, so a heartbeat cannot
  -- claim a board or a mode the server did not hand out.
  board_id uuid primary key,
  -- 'event' for /tv?event=1, 'rotation' for the shop wall.
  mode text not null check (mode in ('rotation', 'event')),
  -- The event host's key from &host= (lib/tv-host-logo.ts), when it has one.
  host text,
  first_seen_at timestamptz not null default now(),
  -- The server's clock, and the only time a board's freshness is judged by.
  last_seen_at timestamptz not null default now(),
  -- Whether the page was the visible tab when it last reported.
  visible boolean,
  -- Whether the board's last load of its numbers succeeded; null before the
  -- first load finished.
  feed_ok boolean,
  -- Loads that failed in a row, as the board counts them.
  feed_failures int not null default 0 check (feed_failures >= 0),
  -- Set by the goodbye the page sends as it closes; cleared if the same page
  -- reports again (restored from the browser's back-forward cache).
  closed_at timestamptz
);

-- The monitor reads the boards seen since the venue day began.
create index board_heartbeats_recent on board_heartbeats (last_seen_at desc);

alter table monitor_state
  add column event_mode boolean not null default false,
  add column event_mode_changed_at timestamptz;
