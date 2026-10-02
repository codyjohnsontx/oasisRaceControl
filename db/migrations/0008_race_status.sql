-- Oasis Race Control - each rig's live race status, for the league-night race board.
--
-- In a hosted iRacing session every rig's agent reports its own car's row -
-- position, lap, gap to the leader, session state - every few seconds
-- (POST /api/agent/race-status, contract `raceStatusEvent` in
-- apps/web/src/lib/events.ts). This table keeps exactly one row per rig, the
-- latest the rig sampled (POST /api/agent/race-status says which report wins).
-- GET /api/race/live reads the rows received in the last minute, groups them
-- by iRacing session and joins each to the rig's signed-in driver through
-- v_rig_status (docs/live-race.md).
--
-- Latest-only on purpose: a race position is worth something for seconds, and
-- history or a replay is a different table with a different retention, not
-- this one grown. A rig that leaves the session simply stops reporting, and its
-- row ages out of the feed; nothing deletes it.
--
-- Additive: one new table, nothing existing altered. The foreign key takes a
-- brief SHARE ROW EXCLUSIVE on rigs, which only a rigs update waits on. A
-- database ahead of the code is harmless (the previous deployment never
-- touches this table); a database behind it answers every race report with
-- 500 and the live feed with 500, which only empties the race board - laps,
-- heartbeats and the wall are untouched - and the build gate refuses the
-- deploy anyway (docs/deploy.md).

create table rig_race_status (
  rig_id uuid primary key references rigs (id),
  -- The server's clock, and the only time a row's freshness is judged by.
  received_at timestamptz not null default now(),
  -- The rig's clock when it read the sim. Orders one rig's reports, so a late
  -- request cannot rewind its row, and never judges staleness: a rig's clock
  -- can be anywhere, so a row stale by received_at is replaced by any report.
  sampled_at timestamptz not null,
  -- iRacing's SessionUniqueID and SessionNum: which server session, and which
  -- session of its weekend (practice, qualifying, race). Rigs in the same
  -- hosted race report the same pair.
  session_unique_id int not null,
  session_num int not null,
  -- SessionInfo.Sessions[SessionNum].SessionType as iRacing spells it
  -- ("Practice", "Open Qualify", "Race"); null until the agent has read it.
  session_type text,
  -- iRacing's SessionState (0 invalid .. 6 cool down) and SessionFlags bitfield.
  -- The flags are unsigned 32-bit, so bigint.
  session_state int not null,
  session_flags bigint not null,
  -- Null when iRacing reports the session as unlimited.
  session_time_remain_s double precision,
  session_laps_remain int,
  -- PlayerCarIdx: the car's slot in this session.
  car_idx int not null,
  -- Null while iRacing has not classified the car (it reports 0).
  position int,
  class_position int,
  lap int,
  laps_completed int,
  lap_dist_pct double precision,
  -- CarIdxF2Time[PlayerCarIdx]: seconds behind the leader in a race. Outside a
  -- race iRacing fills the same variable with a lap time, so it is only a gap
  -- while session_type says Race.
  gap_to_leader_s double precision,
  last_lap_ms int,
  best_lap_ms int,
  on_pit_road boolean not null,
  incidents int not null
);
