-- Dev/demo seed — NOT for production. Tokens and passwords below are
-- deliberately guessable so the fake-rig simulator and local phones can use
-- them; production rigs get random tokens at enrollment and staff set real
-- passwords.

-- All inserts are conflict-ignore so db:seed can be re-run safely.
insert into rigs (rig_number, display_name, agent_token_hash) values
  (1, 'Rig 01', encode(digest('dev-rig-1-secret', 'sha256'), 'hex')),
  (2, 'Rig 02', encode(digest('dev-rig-2-secret', 'sha256'), 'hex')),
  (3, 'Rig 03', encode(digest('dev-rig-3-secret', 'sha256'), 'hex'))
on conflict (rig_number) do nothing;

insert into rig_qr_tokens (token, rig_id)
select 'demo-rig-' || rig_number, id from rigs
on conflict (token) do nothing;

-- Tonight's featured combo (Fastest Tonight ranks only matching laps).
insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
values (venue_today(), 'Spa-Francorchamps', 'Grand Prix Pits', 'Porsche 911 GT3 R', 0)
on conflict (combo_date) do nothing;

-- Sample registered drivers, PIN 1234 (bcrypt via pgcrypto; compatible with bcryptjs).
insert into drivers (display_name, pin_hash, is_guest) values
  ('Cody J.', crypt('1234', gen_salt('bf')), false),
  ('Jordan R.', crypt('1234', gen_salt('bf')), false),
  ('Alexis M.', crypt('1234', gen_salt('bf')), false)
on conflict (display_name) do nothing;

-- Demo staff login: staff@oasis.test / oasis-staff-demo
insert into staff_users (email, password_hash, display_name)
values ('staff@oasis.test', crypt('oasis-staff-demo', gen_salt('bf')), 'Cody')
on conflict (email) do nothing;
