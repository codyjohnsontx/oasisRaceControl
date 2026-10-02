-- Oasis Race Control - league night's race result, scored into the season.
--
-- League night is open qualifying and then a race in one hosted iRacing
-- session. A round used to score by best valid lap alone; a round that has a
-- race result now scores by its finishing order, plus a bonus for the fastest
-- valid qualifying lap (apps/web/src/lib/league-scoring.ts owns the points).
-- A round with no race result scores exactly as before.
--
-- Two tables:
--
-- league_race_results - one row per driver in a round's race. Captured from
--   each rig's own report (rig_race_status, 0008) while iRacing shows the
--   chequered flag or cool-down, so the position is iRacing's own at the flag,
--   refreshed as each car crosses the line. Closing a round sweeps once more,
--   and a race still running then is recorded as the running order at the
--   close. Staff review and correct the order on /staff; once they save it,
--   no capture touches that round again. The driver is whoever was checked in
--   on the rig when the report arrived (rig_assignments), the same rule that
--   owns the rig's laps.
--
-- league_race_starts - when each iRacing race session went green while a
--   round was open. Laps carry no session, so this is what separates a
--   qualifying lap from a race lap: the qualifying bonus only looks at laps
--   completed before the race the results came from went green.
--
-- Additive: two new tables, nothing existing altered. The foreign keys take a
-- brief SHARE ROW EXCLUSIVE on league_rounds, drivers and rigs, which only an
-- update of those tables waits on. A database ahead of the code is harmless
-- (the previous deployment never touches these tables); a database behind it
-- answers race reports and the league feeds with 500, and the build gate
-- refuses the deploy anyway (docs/deploy.md).

create table league_race_results (
  round_id uuid not null references league_rounds (id),
  driver_id uuid not null references drivers (id),
  -- The place as iRacing reported it (or staff entered it). Null: in the race
  -- but not classified - staff marked a DNF. A driver with no row at all simply
  -- has no race finish recorded. Either way they score the participation
  -- point. Not unique: two rigs can report the same place for one cadence, and
  -- the staff review shows that rather than the capture failing.
  finish_position int check (finish_position > 0),
  -- flag:  iRacing's position while the race showed the chequered flag or
  --        cool-down.
  -- close: the running order when staff closed the round before the flag.
  -- staff: entered or confirmed on /staff. Any staff row freezes the round's
  --        result against further capture.
  source text not null check (source in ('flag', 'close', 'staff')),
  -- Where a captured place came from; kept through a staff correction, null
  -- for a driver staff added by hand.
  rig_id uuid references rigs (id),
  session_unique_id int,
  session_num int,
  laps_completed int,
  recorded_at timestamptz not null default now(),
  primary key (round_id, driver_id),
  constraint race_result_session_whole check ((session_unique_id is null) = (session_num is null))
);

create table league_race_starts (
  round_id uuid not null references league_rounds (id),
  -- iRacing's SessionUniqueID and SessionNum, as rig_race_status carries them.
  session_unique_id int not null,
  session_num int not null,
  -- The server's clock when the first rig reported the session racing.
  green_at timestamptz not null default now(),
  primary key (round_id, session_unique_id, session_num)
);
