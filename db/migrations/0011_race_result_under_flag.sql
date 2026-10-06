-- Oasis Race Control - a captured race place settles once its car has crossed
-- the line, and the round's race stays the race that was captured.
--
-- Two things the first league-night rehearsal (2026-10-04, twenty simulated
-- rigs) showed 0009 getting wrong.
--
-- 1. A place captured at the chequered flag was final from the rig's first
--    flagged report. iRacing shows the flag to the whole field the moment the
--    leader crosses the line, and a car's PlayerCarPosition only changes when
--    that car crosses it, so every car still on its last lap was recorded at
--    the position it held a lap earlier - a last-lap pass was recorded the
--    wrong way round. league_race_results.final says whether a captured place
--    is settled: a flag capture is written unsettled, keeps following the
--    rig's reports while the session shows the flag, and settles once the car
--    has crossed the line since the flag (its LapCompleted went up) or the
--    session reaches cool-down. The default is true, so every row already
--    held, and every row a staff save or the close sweep writes, is settled -
--    and a deployment older than this column keeps capturing exactly as it
--    did. lib/race-results.ts is still the only writer.
--
-- 2. The round's race was the race session the most rigs were heard in,
--    latest to start on a tie. A second race session with the same rigs while
--    the round was still open - a second heat, a fun race after the league
--    race, a server that rolled into another race - tied on rig count, won
--    the tie, and silently stopped every captured place from counting: the
--    round fell back to scoring by fastest lap and the qualifying cut-off
--    moved to the second race. v_league_race_session now gives a tie to the
--    session that already has a place captured in it (a result row or an
--    empty-seat row), so a captured race stays the round's race, and its
--    qualifying cut-off stays put, unless a bigger race comes along - 0009's
--    rule for a small warm-up heat that the real race follows.
--
-- Additive: one column with a default, and one view redefined with the same
-- columns in the same order (which is what lets `create or replace` keep
-- v_league_race_results, which reads it, intact). Adding the column takes a
-- brief ACCESS EXCLUSIVE lock on league_race_results, a table of a few rows
-- per round, and Postgres fills the default without rewriting it; replacing
-- the view takes the same brief lock on the view. A database ahead of the
-- code is harmless: the previous code never names the column, and the view
-- answers the same question with one more tie-break. A database behind it:
-- the new code's flag capture names `final` and fails, so flagged race
-- reports still answer 200 but record no place (the server log shows "race
-- result capture failed") until this is applied, and the build gate refuses
-- that deploy anyway (docs/deploy.md).

alter table league_race_results
  add column final boolean not null default true;

-- The round's race: the race session the most rigs were heard in, and at
-- least two - a solo race is never the round's. A tie goes to the session a
-- place has already been captured in, then to the latest to start.
-- started_at is when its first rig reported it.
create or replace view v_league_race_session as
select distinct on (round_id) round_id, session_unique_id, session_num,
       min(started_at) as started_at
from league_race_starts s
group by round_id, session_unique_id, session_num
having count(*) >= 2
order by round_id, count(*) desc,
         (exists (select 1 from league_race_results r
                  where r.round_id = s.round_id
                    and r.session_unique_id = s.session_unique_id
                    and r.session_num = s.session_num)
          or exists (select 1 from league_race_unsigned_places u
                     where u.round_id = s.round_id
                       and u.session_unique_id = s.session_unique_id
                       and u.session_num = s.session_num)) desc,
         min(started_at) desc, session_unique_id desc, session_num desc;
