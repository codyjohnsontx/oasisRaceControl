-- Dev/demo seed — NOT for production. Tokens below are deliberately guessable
-- so the fake-rig simulator and local phones can use them; production rigs get
-- random tokens at enrollment.

insert into rigs (rig_number, display_name, agent_token_hash) values
  (1, 'Rig 01', encode(digest('dev-rig-1-secret', 'sha256'), 'hex')),
  (2, 'Rig 02', encode(digest('dev-rig-2-secret', 'sha256'), 'hex')),
  (3, 'Rig 03', encode(digest('dev-rig-3-secret', 'sha256'), 'hex'));

insert into rig_qr_tokens (token, rig_id)
select 'demo-rig-' || rig_number, id from rigs;

-- Tonight's featured combo (Fastest Tonight ranks only matching laps).
insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
values (venue_today(), 'Spa-Francorchamps', 'Grand Prix Pits', 'Porsche 911 GT3 R', 0);

-- Sample registered drivers, PIN 1234 (bcrypt via pgcrypto; compatible with bcryptjs).
insert into drivers (display_name, pin_hash, is_guest) values
  ('Cody J.', crypt('1234', gen_salt('bf')), false),
  ('Jordan R.', crypt('1234', gen_salt('bf')), false),
  ('Alexis M.', crypt('1234', gen_salt('bf')), false);

-- First staff user: create the auth user in the Supabase dashboard
-- (Authentication → Add user), then run:
--   insert into staff_users (user_id, display_name)
--   values ('<auth-user-uuid>', 'Cody');
