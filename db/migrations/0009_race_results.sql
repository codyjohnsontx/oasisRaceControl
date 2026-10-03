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
--   chequered flag or cool-down, so the place is iRacing's own at the flag.
--   The first place captured for a rig in the race is final: no later report,
--   however it arrives, moves it. Closing the round sweeps once more for any
--   car still missing, recording its last reported place. Staff review and
--   correct the order on /staff; once they save it, no capture touches that
--   round again. The driver is whoever was checked in on the rig when the
--   report arrived, the same rule that owns the rig's laps - read from the
--   assignment stored with the report, never from whoever sits there later.
--   lib/race-results.ts is the only writer.
--
-- league_race_starts - every rig heard in each iRacing race session while a
--   round was open, and when. Laps carry no session, so the session's first
--   report is what separates a qualifying lap from a race lap: the qualifying
--   bonus only looks at laps completed before the round's race began.
--
-- v_league_race_session / v_league_race_results - which race is the round's,
--   and which result rows count. A rig can run some other race while a round
--   is open (a walk-in's solo race on a spare rig), so the round's race is the
--   session the most rigs were heard in, and never one heard from a single
--   rig. The flag capture, the qualifying cut-off and the close sweep all read
--   it. Change that rule here, nowhere else.
--
-- rig_race_status.rig_assignment_id - the rig's open assignment when the
--   report was stored, or null when nobody was checked in. The close sweep
--   reads a rig's last report, which can be minutes old by then, and the seat
--   may have changed hands since; this is who that report was about.
--
-- Additive: two new tables, two views and one nullable column on
-- rig_race_status; nothing existing is rewritten. The foreign keys take a
-- brief SHARE ROW EXCLUSIVE on league_rounds, drivers, rigs and
-- rig_assignments, which only an update of those tables waits on, and adding
-- the column takes a brief ACCESS EXCLUSIVE on rig_race_status (one row per
-- rig), which a race report in flight waits behind for that moment. A database ahead of the code is harmless
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
  -- A captured row always says which rig and session it came from;
  -- v_league_race_results counts it only for the round's race.
  constraint race_result_capture_has_origin
    check (source = 'staff' or (rig_id is not null and session_unique_id is not null))
);

create table league_race_starts (
  round_id uuid not null references league_rounds (id),
  -- iRacing's SessionUniqueID and SessionNum, as rig_race_status carries them.
  session_unique_id int not null,
  session_num int not null,
  rig_id uuid not null references rigs (id),
  -- The server's clock when this rig first reported this race session.
  started_at timestamptz not null default now(),
  primary key (round_id, session_unique_id, session_num, rig_id)
);

alter table rig_race_status
  add column rig_assignment_id uuid references rig_assignments (id);

-- The round's race: the race session the most rigs were heard in, and at
-- least two - a solo race is never the round's. The latest to start wins a
-- tie. started_at is when its first rig reported it.
create view v_league_race_session as
select distinct on (round_id) round_id, session_unique_id, session_num,
       min(started_at) as started_at
from league_race_starts
group by round_id, session_unique_id, session_num
having count(*) >= 2
order by round_id, count(*) desc, min(started_at) desc,
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
