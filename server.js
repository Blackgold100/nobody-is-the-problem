require('./src/env');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { pool, migrate, ensureAuthor, getSettings } = require('./src/db');
const h = require('./src/helpers');

const app = express();
const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (PROD) { console.error('SESSION_SECRET must be set (32+ random characters) in Secrets.'); process.exit(1); }
  console.warn('SESSION_SECRET not set: using an insecure development secret.');
}

try { new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SITE_TIMEZONE || 'Africa/Lagos' }); } catch (e) {
  console.error('SITE_TIMEZONE is not a valid timezone name (e.g. Africa/Lagos).'); process.exit(1);
}
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
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
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '7d' : 0 }));
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

const PORT = process.env.PORT || 5000;
(async () => {
  await migrate();
  await ensureAuthor();
  await require('./src/seed').seedBook();
  app.listen(PORT, '0.0.0.0', () => console.log(`Book site running on port ${PORT}`));
})().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
