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
--   chequered flag or cool-down, so the place is iRacing's own at the flag,
--   refreshed as each car crosses the line. Closing the round sweeps once more
--   for any car still missing, recording its last reported place. Staff review
--   and correct the order on /staff; once they save it, no capture touches
--   that round again. The driver is whoever was checked in on the rig when the
--   report arrived (rig_assignments), the same rule that owns the rig's laps.
--   lib/race-results.ts is the only writer.
--
-- v_league_race_session / v_league_race_results - which of those rows are the
--   round's race. A rig can finish some other race while a round is open (a
--   walk-in's solo race on a spare rig), so a capture never deletes another
--   session's rows; the round's race is the session the most cars were
--   captured in, and only its rows count. Change that rule here, nowhere else.
--
-- league_race_starts - when each iRacing race session was first heard while a
--   round was open. Laps carry no session, so this is what separates a
--   qualifying lap from a race lap: the qualifying bonus only looks at laps
--   completed before the race the results came from began.
--
-- Additive: two new tables and two views, nothing existing altered. The
-- foreign keys take a brief SHARE ROW EXCLUSIVE on league_rounds, drivers and
-- rigs, which only an update of those tables waits on. A database ahead of the code is harmless
-- (the previous deployment never touches these tables); a database behind it
-- answers the league feeds and the staff page with 500, and the build gate
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
  -- flag:  iRacing's place while the race showed the chequered flag or
  --        cool-down.
  -- close: the car's last reported place when staff closed the round, for a
  --        car the flag capture never recorded.
  -- staff: saved on /staff. A staff row freezes the round's result against
  --        any further capture.
  source text not null check (source in ('flag', 'close', 'staff')),
  -- A captured place has no DNF: only staff mark one.
  constraint race_result_dnf_is_staff check (finish_position is not null or source = 'staff'),
  -- Where a captured place came from; kept through a staff correction, null
  -- for a driver staff added by hand.
  rig_id uuid references rigs (id),
  session_unique_id int,
  session_num int,
  laps_completed int,
  recorded_at timestamptz not null default now(),
  primary key (round_id, driver_id),
  constraint race_result_session_whole check ((session_unique_id is null) = (session_num is null)),
  -- A captured row always says which rig and session it came from; the views
  -- below choose the round's race by it.
  constraint race_result_capture_has_origin
    check (source = 'staff' or (rig_id is not null and session_unique_id is not null))
);

create table league_race_starts (
  round_id uuid not null references league_rounds (id),
  -- iRacing's SessionUniqueID and SessionNum, as rig_race_status carries them.
  session_unique_id int not null,
  session_num int not null,
  -- The server's clock when the first rig reported this race session.
  started_at timestamptz not null default now(),
  primary key (round_id, session_unique_id, session_num)
);

-- The round's race: the session the most of its result rows came from, the
-- latest recorded winning a tie. Staff rows keep the session they were
-- captured in, so a corrected result still names its race.
create view v_league_race_session as
select distinct on (round_id) round_id, session_unique_id, session_num
from league_race_results
where session_unique_id is not null
group by round_id, session_unique_id, session_num
order by round_id, count(*) desc, max(recorded_at) desc,
         session_unique_id desc, session_num desc;

-- The rows that are the round's race result. Saving on /staff replaces every
-- row of the round with staff rows, so a round holds either staff rows - all
-- of which count - or captured ones, of which only the race session's count.
create view v_league_race_results as
select rr.*
from league_race_results rr
left join v_league_race_session s on s.round_id = rr.round_id
where rr.source = 'staff'
   or (rr.session_unique_id = s.session_unique_id and rr.session_num = s.session_num);
