-- Sex never leaves the phone: drop the column (and any stored answers);
-- keep the phone's maintenance figure next to the profile.
ALTER TABLE profiles DROP COLUMN IF EXISTS sex;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS maintenance_kcal INT;
