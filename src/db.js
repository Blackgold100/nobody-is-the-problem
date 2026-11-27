const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

// Vercel's Postgres (Neon) integration may name the variable POSTGRES_URL.
if (!process.env.DATABASE_URL && process.env.POSTGRES_URL) process.env.DATABASE_URL = process.env.POSTGRES_URL;
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres database (Vercel: Storage → Neon; Replit: Database tool).');
  if (!process.env.VERCEL) process.exit(1); // on Vercel the site shows a setup page instead
}
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: process.env.VERCEL ? 3 : 10, idleTimeoutMillis: 10000 });
// "Today" for chapter releases is worked out in the app, in SITE_TIMEZONE
// (default Africa/Lagos), and passed to queries; see helpers.today().
const TZ = process.env.SITE_TIMEZONE || 'Africa/Lagos';
const query = (text, params) => pool.query(text, params);

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

// Creates the author account on first start. With AUTHOR_PASSWORD unset, a one-time
// password is generated and printed in the console (it must be changed at first sign-in).
async function ensureAuthor() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='author'");
  // Recovery: with AUTHOR_RESET=yes, the author's email and password are set from
  // AUTHOR_EMAIL and AUTHOR_PASSWORD on the next start. Remove AUTHOR_RESET afterwards.
  if (rows[0].n > 0 && process.env.AUTHOR_RESET === 'yes') {
    const email = (process.env.AUTHOR_EMAIL || '').trim().toLowerCase();
    const pw = process.env.AUTHOR_PASSWORD || '';
    if (!email || pw.length < 10) { console.warn('AUTHOR_RESET needs AUTHOR_EMAIL and an AUTHOR_PASSWORD of at least 10 characters.'); return; }
    const { rows: [a] } = await pool.query("SELECT id FROM users WHERE role='author' ORDER BY id LIMIT 1");
    const { rows: [clash] } = await pool.query('SELECT id FROM users WHERE lower(email)=$1 AND id<>$2', [email, a.id]);
    if (clash) { console.warn(`AUTHOR_RESET: ${email} already belongs to a reader account; choose another email.`); return; }
    await pool.query('UPDATE users SET email=$1, password_hash=$2, must_change_password=FALSE, failed_logins=0, locked_until=NULL WHERE id=$3',
      [email, await bcrypt.hash(pw, 12), a.id]);
    console.log(`Author sign-in reset for ${email}. Remove AUTHOR_RESET now.`);
    return;
  }
  if (rows[0].n > 0) return;
  const email = (process.env.AUTHOR_EMAIL || 'author@example.com').trim().toLowerCase();
  const given = process.env.AUTHOR_PASSWORD;
  if (given && given.length < 10) { console.warn('AUTHOR_PASSWORD must be at least 10 characters.'); return; }
  const password = given || crypto.randomBytes(9).toString('base64url');
  await pool.query(
    "INSERT INTO users (role, email, password_hash, name, has_pass, must_change_password) VALUES ('author',$1,$2,$3,TRUE,$4)",
    [email, await bcrypt.hash(password, 12), 'Lincoln Matthew', !given]);
  if (given) console.log(`Author account created for ${email}`);
  else console.log(`\n=== Author account created ===\nEmail:    ${email}\nPassword: ${password}\nSign in at /login and set your own password. This is shown only once.\n`);
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value || '']));
}

module.exports = { pool, query, migrate, ensureAuthor, getSettings, TZ };
