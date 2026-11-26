require('./src/env');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { pool, migrate, ensureAuthor, getSettings } = require('./src/db');
const h = require('./src/helpers');

const app = express();
const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT || !!process.env.VERCEL;
const ON_VERCEL = !!process.env.VERCEL;

// Settings the site cannot run without. On Vercel a missing one shows a setup page
// instead of crashing, so the problem is visible in the browser and the logs.
const missing = [];
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) missing.push('DATABASE_URL (add a Postgres database: Vercel → Storage → Neon)');
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (PROD) missing.push('SESSION_SECRET (32 or more random characters)');
  else console.warn('SESSION_SECRET not set: using an insecure development secret.');
}
if (missing.length && !ON_VERCEL) { console.error('Missing settings: ' + missing.join('; ')); process.exit(1); }

try { new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SITE_TIMEZONE || 'Africa/Lagos' }); } catch (e) {
  console.error('SITE_TIMEZONE is not a valid timezone name (e.g. Africa/Lagos).'); process.exit(1);
}
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
require('./src/views-manifest'); // makes Vercel bundle the templates
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      scriptSrc: ["'self'"],
      formAction: ["'self'", 'https://checkout.paystack.com'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
}));
// Static files live in public/static so they are served at /static/... both here and
// by Vercel's CDN (which serves public/** directly and ignores express.static).
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { maxAge: PROD ? '7d' : 0 }));

// Database setup runs once per server start (each cold start on Vercel) before any request.
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await migrate();
      await ensureAuthor();
      await require('./src/seed').seedBook();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
app.use(async (req, res, next) => {
  if (missing.length) {
    console.error('Missing settings: ' + missing.join('; '));
    return res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>Setup needed</title><body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.5"><h1>Almost there</h1><p>The site needs these settings before it can start. Add them under <strong>Vercel → Project → Settings → Environment Variables</strong>, then redeploy:</p><ul>${missing.map((m) => `<li>${m}</li>`).join('')}</ul></body>`);
  }
  try { await init(); next(); } catch (e) {
    console.error('Startup failed:', e);
    res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Starting up</title><body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px"><h1>The site could not connect to its database</h1><p>Check DATABASE_URL in the project settings, then reload. Details are in the deployment logs.</p></body>');
  }
});
// Paystack webhooks need the raw body to check their signature
app.use('/pay/webhook', express.raw({ type: '*/*', limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  name: 'nitp.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me-please',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 14 * 24 * 60 * 60 * 1000 },
}));
// Save the session before redirecting, so the next page always sees the login and flash message
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => (req.session && req.session.save ? req.session.save(() => redirect(...args)) : redirect(...args));
  next();
});

Object.assign(app.locals, {
  naira: h.naira, longDate: h.longDate, monthYear: h.monthYear, lines: h.lines, chLabel: h.chLabel, inlineMd: h.inlineMd,
  paystackOn: () => !!process.env.PAYSTACK_SECRET_KEY,
});

app.use((req, res, next) => {
  res.locals.user = null; res.locals.flash = null; res.locals.csrf = ''; res.locals.path = req.path;
  res.locals.baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  next();
});
app.use((req, res, next) => h.loadUser(req, res, next).catch(next));
// Site settings are loaded before the CSRF check so even its error page can render
app.use(async (req, res, next) => {
  try { res.locals.site = await getSettings(); next(); } catch (e) { next(e); }
});
app.use(h.csrf);
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(require('./src/routes/auth'));
app.use('/pay', require('./src/routes/pay'));
app.use('/admin', require('./src/routes/admin'));
app.use(require('./src/routes/public'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

module.exports = app;

// Run as a normal server (locally, Replit, Render...). On Vercel the exported app is used.
if (require.main === module && !ON_VERCEL) {
  const PORT = process.env.PORT || 5000;
  init().then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Book site running on port ${PORT}`));
  }).catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
