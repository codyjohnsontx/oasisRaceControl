-- Oasis Race Control - the rig monitor's alert state.
--
-- The monitor (apps/web/src/lib/monitor/) judges every rig from its stored
-- heartbeats (0005) and posts to the venue's Discord channel when something is
-- wrong. The owner's rule is that an alert fires once and recovers once - no
-- repeats while a problem persists - so the state that decides "already told
-- them" has to survive concurrent evaluations on different Vercel instances.
-- It lives here, as rows, and a partial unique index is what makes it hold:
-- two evaluations that both see a rig go silent can both try to open the
-- alert, and exactly one insert wins. No advisory lock, no application lock -
-- the same discipline the schema already uses for one open assignment per rig.
--
-- Additive: two new tables, one index, one seed row. Nothing existing is
-- touched and no lock is taken on any existing table beyond the brief SHARE
-- ROW EXCLUSIVE the staff_users foreign key takes, which only a staff_users
-- write waits on. A database ahead of the code is harmless (the previous
-- deployment never reads these tables); a database behind it fails every
-- evaluation, which only logs - heartbeats and laps are still stored - and the
-- build gate refuses the deploy anyway (docs/deploy.md).
--
-- Some columns are read by later monitor work in the approved plan rather than
-- by the first evaluator, and are created now so that work needs no hand-applied
-- migration of its own: refire_count (flapping mute), diagnosis and handoff
-- (the AI diagnosis and copy-paste handoff), github_issue_number (the
-- rig-alert issue), and the event-mode override and long-stint threshold in
-- monitor_state. They are nullable or defaulted, so nothing writes them yet.

create table monitor_alerts (
  id bigint generated always as identity primary key,
  -- The rule's key in apps/web/src/lib/monitor/rules.ts, e.g. 'rig_silent'.
  rule text not null,
  -- What the alert is about: 'rig:<uuid>', or 'venue' for a venue-wide one.
  subject text not null,
  severity text not null check (severity in ('urgent', 'warning')),
  -- How bad, for a rule whose problem can get worse while it is open (laps
  -- refused by the site: how many are parked). A rise re-notifies once per
  -- rise; zero for every rule that has no scale.
  level int not null default 0,
  opened_at timestamptz not null default now(),
  -- The last evaluation that still saw the problem.
  last_seen_at timestamptz not null default now(),
  -- Evaluations in a row that no longer saw it. Two resolve the alert, so one
  -- evaluation that happens to miss a condition does not post "recovered".
  absent_evaluations int not null default 0,
  resolved_at timestamptz,
  refire_count int not null default 0,
  -- What the monitor saw, as the message renders it: the headline, the fields
  -- and the numbers behind them. Rewritten on every evaluation that still
  -- sees the problem.
  detail jsonb not null,
  diagnosis jsonb,
  handoff text,
  -- Posting is separate from the transition: the row commits first, then the
  -- message goes, then notified_at is set. A post that fails leaves it null
  -- and a later evaluation retries, so a Discord outage delays an alert
  -- rather than losing it. *_attempted_at is the claim on a (re)try, so two
  -- evaluations retrying at once cannot both post.
  notified_at timestamptz,
  notify_attempted_at timestamptz,
  -- The last moment an unannounced opening, or a rise in level, may still be
  -- retried. Set when the alert opens and again only when its level rises;
  -- neither the problem persisting nor a retry moves it, so a post Discord
  -- keeps refusing is given up on an hour later instead of being retried for
  -- as long as the problem lasts.
  notify_until timestamptz,
  recovery_notified_at timestamptz,
  recovery_attempted_at timestamptz,
  github_issue_number int
);

-- The fire-once guarantee: at most one open alert per rule and subject. An
-- evaluation opens with INSERT ... ON CONFLICT against this index, and only the
-- one whose row was actually inserted posts.
create unique index monitor_alerts_one_open
  on monitor_alerts (rule, subject) where resolved_at is null;

-- One row, always id 1: the monitor's own clock and settings.
create table monitor_state (
  id int primary key check (id = 1),
  -- The throttle: an evaluation claims this only if the last one was more
  -- than a few seconds ago, so a burst of heartbeats costs one evaluation.
  last_evaluated_at timestamptz,
  last_routine_update_at timestamptz,
  -- Heartbeats older than seven days are pruned at most once a day.
  last_pruned_at timestamptz,
  event_mode_override text check (event_mode_override in ('on', 'off')),
  override_set_by uuid references staff_users (id),
  override_expires_at timestamptz,
  long_stint_minutes int not null default 120 check (long_stint_minutes > 0)
);

insert into monitor_state (id) values (1);
