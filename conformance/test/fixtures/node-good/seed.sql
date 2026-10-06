-- Seed data for a mirror that starts empty: one demo person and three notes, so there's something to look at.
-- agc runs it once per mirror, after the migrations, when the mirror holds no production data (agc up, agc db reset).
-- It never runs in production. Every insert is ON CONFLICT DO NOTHING, so running it again changes nothing.
-- On a mirror, sign in as the user id below (the test sign-in page takes an id) to see the demo person's notes.
INSERT INTO users (id, email)
VALUES ('00000000-0000-4000-8000-000000000001', 'demo@example.test') -- Demo Person
ON CONFLICT DO NOTHING;

INSERT INTO notes (user_id, title)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Welcome to your notes'),
  ('00000000-0000-4000-8000-000000000001', 'This note came from seed.sql'),
  ('00000000-0000-4000-8000-000000000001', 'Change seed.sql when the app grows past notes')
ON CONFLICT DO NOTHING;
