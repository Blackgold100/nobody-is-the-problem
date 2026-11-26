const crypto = require('crypto');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { query } = require('./db');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function naira(n) {
  return '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
}
function longDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const [y, m, day] = s.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}
function monthYear(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString();
  const [y, m] = s.slice(0, 7).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
function today() {
  // YYYY-MM-DD in the site's timezone (en-CA formats dates that way)
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.SITE_TIMEZONE || 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function lines(text) { return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chapter';
}
// Author-written markdown → safe HTML. Book figures (/static/...), captions and
// footnote markers (<sup>3</sup>) are allowed; markers link to the chapter's notes.
function markdown(md) {
  const html = marked.parse(String(md || ''), { breaks: true });
  const clean = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'blockquote', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'a', 'hr', 'img', 'sup'],
    allowedAttributes: { a: ['href', 'rel', 'target'], img: ['src', 'alt', 'loading'], p: ['class'] },
    allowedClasses: { p: ['caption'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: [] },
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^\/static\/[\w./-]+$/.test(frame.attribs.src || ''),
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener', target: '_blank' }),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
    },
  });
  return clean.replace(/<sup>(\d{1,3})<\/sup>/g, '<sup class="fn"><a href="#note-$1" id="ref-$1" aria-label="Note $1">$1</a></sup>');
}
// One line of markdown (endnotes): italics/bold only
function inlineMd(md) {
  const html = marked.parseInline(String(md || ''));
  return sanitizeHtml(html, { allowedTags: ['em', 'strong', 'i', 'b'], allowedAttributes: {} });
}
// "Chapter 3", or the section's own label ("Preface", "Epilogue")
function chLabel(c) { return (c && c.label) || `Chapter ${c ? c.number : ''}`; }

// ---------- CSRF ----------
const MULTIPART_ROUTES = ['/admin/settings/cover', '/pass/transfer'];
function tokenOk(req, token) {
  return !!(token && req.session.csrf && token.length === req.session.csrf.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf)));
}
function csrfFail(res) {
  return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Go back, refresh the page and try again.' });
}
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST' && !req.path.startsWith('/pay/webhook')) {
    if (req.is('multipart/form-data')) return MULTIPART_ROUTES.includes(req.path) ? next() : csrfFail(res);
    if (!tokenOk(req, (req.body && req.body._csrf) || req.get('x-csrf-token'))) return csrfFail(res);
  }
  next();
}
function checkCsrf(req, res, next) {
  if (!tokenOk(req, req.body && req.body._csrf)) return csrfFail(res);
  next();
}

// ---------- Auth ----------
async function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    const { rows: [u] } = await query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    if (u) { req.user = u; res.locals.user = u; } else req.session.userId = null;
  }
  next();
}
function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.must_change_password && !req.path.startsWith('/account/password')) return res.redirect('/account/password');
  next();
}
function requireAuthor(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'author') return res.status(403).render('error', { title: 'Not allowed', message: 'This area is for the author only.' });
  if (req.user.must_change_password) return res.redirect('/account/password');
  next();
}
function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : null;
}

// ---------- Validation ----------
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const optStr = (v, max = 500) => { const s = str(v, max); return s === '' ? null : s; };
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function isoDate(v) {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}
function safeUrl(v) {
  const s = str(v, 500);
  if (!s) return '';
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}
function flash(req, type, text) { req.session.flash = { type, text }; }

module.exports = {
  naira, longDate, monthYear, today, lines, slugify, markdown, inlineMd, chLabel,
  csrf, checkCsrf, loadUser, requireLogin, requireAuthor, safeNext,
  str, optStr, isEmail, isoDate, safeUrl, flash,
};
