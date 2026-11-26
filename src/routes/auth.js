const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const h = require('../helpers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const DUMMY = bcrypt.hashSync('not-a-real-password', 10);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { error: 'Too many attempts. Please wait 15 minutes and try again.', email: '', next: '' }),
});

function signIn(req, res, u, dest) {
  req.session.regenerate((err) => {
    if (err) return res.redirect('/login');
    req.session.userId = u.id;
    if (u.must_change_password) return res.redirect('/account/password');
    res.redirect(h.safeNext(dest) || (u.role === 'author' ? '/admin' : '/chapters'));
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'author' ? '/admin' : '/chapters');
  res.render('login', { title: 'Sign in', error: null, email: '', next: h.safeNext(req.query.next) || '' });
});

router.post('/login', authLimiter, wrap(async (req, res) => {
  const email = h.str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const nextUrl = h.safeNext(req.body.next) || '';
  const fail = (error, code = 401) => res.status(code).render('login', { title: 'Sign in', error, email, next: nextUrl });
  const { rows: [u] } = await query('SELECT * FROM users WHERE email=$1', [email]);
  if (!u) { await bcrypt.compare(password, DUMMY); return fail('Incorrect email or password.'); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return fail('Too many failed attempts. Try again in 15 minutes.', 423);
  if (!(await bcrypt.compare(password, u.password_hash))) {
    const n = u.failed_logins + 1;
    await query('UPDATE users SET failed_logins=$1, locked_until=$2 WHERE id=$3', [n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null, u.id]);
    return fail('Incorrect email or password.');
  }
  await query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=NOW() WHERE id=$1', [u.id]);
  signIn(req, res, u, nextUrl);
}));

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/chapters');
  res.render('signup', { title: 'Create your account', error: null, form: {}, next: h.safeNext(req.query.next) || '' });
});

router.post('/signup', authLimiter, wrap(async (req, res) => {
  const form = { name: h.str(req.body.name, 80), email: h.str(req.body.email, 200).toLowerCase() };
  const pw = String(req.body.password || '');
  const nextUrl = h.safeNext(req.body.next) || '';
  const fail = (error) => res.status(400).render('signup', { title: 'Create your account', error, form, next: nextUrl });
  if (!form.name) return fail('Please enter your name.');
  if (!h.isEmail(form.email)) return fail('Please enter a valid email address.');
  if (pw.length < 8) return fail('Your password needs at least 8 characters.');
  const { rows: dupe } = await query('SELECT 1 FROM users WHERE email=$1', [form.email]);
  if (dupe.length) return fail('An account with that email already exists. Sign in instead.');
  const { rows: [u] } = await query(
    "INSERT INTO users (role, email, password_hash, name) VALUES ('reader',$1,$2,$3) RETURNING *",
    [form.email, await bcrypt.hash(pw, 12), form.name]);
  if (req.body.subscribe === 'on') {
    await query('INSERT INTO subscribers (email, name) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [form.email, form.name]);
  }
  h.flash(req, 'success', `Welcome, ${form.name.split(' ')[0]}. Your account is ready.`);
  signIn(req, res, u, nextUrl);
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('nitp.sid'); res.redirect('/'); });
});

router.get('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('change-password', { title: 'Change password', error: null, forced: req.user.must_change_password });
});

router.post('/account/password', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const forced = req.user.must_change_password;
  const fail = (error) => res.status(400).render('change-password', { title: 'Change password', error, forced });
  if (!(await bcrypt.compare(String(req.body.current || ''), req.user.password_hash))) return fail('Your current password is incorrect.');
  const pw = String(req.body.next || '');
  const min = req.user.role === 'author' ? 10 : 8;
  if (pw.length < min) return fail(`Your new password needs at least ${min} characters.`);
  if (pw !== String(req.body.confirm || '')) return fail('The new passwords do not match.');
  await query('UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2', [await bcrypt.hash(pw, 12), req.user.id]);
  h.flash(req, 'success', 'Your password has been updated.');
  res.redirect(req.user.role === 'author' ? '/admin' : '/account');
}));

module.exports = router;
