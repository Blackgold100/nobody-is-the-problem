-- "Nobody Is the Problem" companion site. Safe to run on every start.

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  role                 TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('author','reader')),
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  name                 TEXT NOT NULL,
  has_pass             BOOLEAN NOT NULL DEFAULT FALSE,
  pass_granted_at      TIMESTAMPTZ,
  pass_source          TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO settings (key, value) VALUES
  ('book_title', 'Nobody Is the Problem'),
  ('author_name', 'Lincoln Matthew'),
  ('tagline', 'A monthly, chapter-by-chapter companion to the book.'),
  ('blurb', 'Each month, the author walks through one chapter of Nobody Is the Problem: what it means, why it was written, and how to apply it. Read along, reflect, and share what stayed with you.'),
  ('author_bio', ''),
  ('pass_price_ngn', '5000'),
  ('pass_name', 'Reader''s Pass'),
  ('amazon_url', ''),
  ('selar_url', ''),
  ('contact_email', '')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS images (
  id         SERIAL PRIMARY KEY,
  purpose    TEXT NOT NULL,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chapters (
  id            SERIAL PRIMARY KEY,
  number        INTEGER NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  teaser        TEXT,               -- shown to everyone
  commentary    TEXT,               -- markdown; behind the paywall unless free
  key_ideas     TEXT,               -- one per line
  excerpt       TEXT,
  questions     TEXT,               -- reflection questions, one per line
  quotes        TEXT,               -- shareable quotes, one per line
  is_free       BOOLEAN NOT NULL DEFAULT FALSE,
  publish_on    DATE,               -- NULL = draft
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id          SERIAL PRIMARY KEY,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  featured    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chapter_id, user_id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id          SERIAL PRIMARY KEY,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chapter_id, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reference   TEXT NOT NULL UNIQUE,
  amount_kobo INTEGER NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'NGN',
  status      TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN ('initialized','success','failed','abandoned')),
  channel     TEXT,
  paid_at     TIMESTAMPTZ,
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Donation model (the book is readable; donations unlock chapters) ----------
INSERT INTO settings (key, value) VALUES
  ('donation_min_ngn', '1000'),
  ('donation_suggested', '1000,2500,5000')
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value='Supporter access' WHERE key='pass_name' AND value='Reader''s Pass';
UPDATE settings SET value='Read the book online, chapter by chapter.' WHERE key='tagline' AND value='A monthly, chapter-by-chapter companion to the book.';
UPDATE settings SET value='Read Nobody Is the Problem here, one chapter at a time. The first chapter is free. Make a donation of any amount to unlock the rest of the book and support the author.' WHERE key='blurb' AND value LIKE 'Each month, the author walks through one chapter%';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS message TEXT;

-- ---------- Full book + bank transfer donations ----------
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS label TEXT;   -- "Preface", "Chapter 3", "Epilogue"; NULL = "Chapter N"
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS part  TEXT;   -- "Part I — Seeing Differently"
ALTER TABLE chapters ADD COLUMN IF NOT EXISTS notes JSONB;  -- endnotes {"1": "markdown", ...}

ALTER TABLE payments ADD COLUMN IF NOT EXISTS method      TEXT NOT NULL DEFAULT 'paystack';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_on     DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_id    INTEGER REFERENCES images(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('initialized','pending','success','failed','abandoned','rejected'));
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status);

INSERT INTO settings (key, value) VALUES
  ('bank_name', ''),
  ('bank_account_name', ''),
  ('bank_account_number', ''),
  ('bank_instructions', 'Use your reference as the transfer narration/description so we can match your donation quickly.'),
  ('bank_instant_unlock', 'no'),
  ('whatsapp_number', '')
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value='Read the whole book online. The Preface, Prologue and Chapter One are free.' WHERE key='tagline' AND value='Read the book online, chapter by chapter.';
