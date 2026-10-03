-- Oasis Race Control - a rig that takes the round's race flag with nobody
-- signed in keeps its place empty.
--
-- 0009 records a rig's place at the chequered flag for the driver signed in
-- when the report arrived, and once a rig's place is recorded, nothing more
-- from that rig counts for the race - so somebody signing in during cool-down
-- does not inherit it. A rig that took the flag with nobody signed in
-- recorded nothing, so the first person to sign in on it during cool-down
-- was credited with a place they never drove, and the close sweep did the
-- same from the rig's last report.
--
-- league_race_unsigned_places - one row per rig that reported the round's
--   race at the flag with nobody signed in: the no-driver capture. The flag
--   capture and the close sweep both treat it as the rig's place already
--   taken. A driver signed in at the flag is recorded exactly as before.
--   lib/race-results.ts is the only writer.
--
-- Additive: one new table, nothing existing is rewritten. Its foreign keys
-- take a brief SHARE ROW EXCLUSIVE on league_rounds and rigs, which only an
-- update of those tables waits on. A database ahead of the code is harmless
-- (the previous deployment never touches the table). On a database behind
-- it, flagged race reports still answer 200 but record no place, signed-in
-- rigs included (the server log shows "race result capture failed"), and
-- closing a round fails with 500; the build gate refuses that deploy anyway
-- (docs/deploy.md).

create table league_race_unsigned_places (
  round_id uuid not null references league_rounds (id),
  rig_id uuid not null references rigs (id),
  -- iRacing's SessionUniqueID and SessionNum of the race it flagged in.
  session_unique_id int not null,
  session_num int not null,
  recorded_at timestamptz not null default now(),
  primary key (round_id, session_unique_id, session_num, rig_id)
);
