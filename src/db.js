const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. On Replit, add a PostgreSQL database from the Database tool.');
  process.exit(1);
}
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 10 });
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
