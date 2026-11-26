const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { pool, query } = require('../db');
const h = require('../helpers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { h.flash(req, 'error', 'Too many requests. Please wait a few minutes.'); res.redirect('/'); },
});

const canRead = (user, ch) => ch.is_free || !!(user && (user.has_pass || user.role === 'author'));
const isAuthor = (user) => !!(user && user.role === 'author');

// Opening paragraphs shown above the paywall on locked chapters
function previewOf(md, words = 170) {
  const out = []; let n = 0;
  for (const b of String(md || '').split(/\n{2,}/)) {
    if (/^(!\[|<p class="caption"|---|> )/.test(b)) continue;
    out.push(b.replace(/<sup>\d+<\/sup>/g, '')); n += b.split(/\s+/).length;
    if (n >= words) break;
  }
  return out.join('\n\n');
}

async function chapterList() {
  const { rows } = await query(
    `SELECT c.*, (c.publish_on IS NOT NULL AND c.publish_on <= $1::date) AS published,
       array_length(regexp_split_to_array(COALESCE(c.commentary,''), '\\s+'), 1) AS words,
       COALESCE(ROUND(AVG(r.rating) FILTER (WHERE r.status='approved'), 1), 0) AS avg_rating,
       COUNT(r.id) FILTER (WHERE r.status='approved')::int AS review_count
     FROM chapters c LEFT JOIN reviews r ON r.chapter_id=c.id
     WHERE c.publish_on IS NOT NULL
     GROUP BY c.id ORDER BY c.number, c.id`, [h.today()]);
  return rows;
}

router.get('/', wrap(async (req, res) => {
  const chapters = await chapterList(req.user);
  const { rows: testimonials } = await query(
    `SELECT r.*, u.name, c.number, c.label, c.title AS chapter_title FROM reviews r JOIN users u ON u.id=r.user_id JOIN chapters c ON c.id=r.chapter_id
     WHERE r.status='approved' ORDER BY r.featured DESC, r.rating DESC, r.created_at DESC LIMIT 3`);
  let lastRead = null;
  if (req.user && req.user.last_chapter_id) lastRead = chapters.find((c) => c.id === req.user.last_chapter_id && c.published) || null;
  const { rows: [sup] } = await query("SELECT COUNT(DISTINCT user_id)::int AS n FROM payments WHERE status='success'");
  res.render('home', { title: null, chapters, testimonials, lastRead, supporters: sup.n });
}));

router.get('/chapters', wrap(async (req, res) => {
  const chapters = await chapterList(req.user);
  res.render('chapters', { title: 'Contents', chapters });
}));

router.get('/chapters/:slug', wrap(async (req, res) => {
  const { rows: [ch] } = await query(
    'SELECT c.*, (c.publish_on IS NOT NULL AND c.publish_on <= $2::date) AS published FROM chapters c WHERE slug=$1', [req.params.slug, h.today()]);
  if (!ch || (!ch.published && !isAuthor(req.user))) return res.status(404).render('error', { title: 'Not available yet', message: 'This chapter has not been released yet.' });
  const access = canRead(req.user, ch);
  if (req.user && ch.published) await query('UPDATE users SET last_chapter_id=$1 WHERE id=$2', [ch.id, req.user.id]);
  const [{ rows: reviews }, { rows: [mine] }, { rows: [journal] }, { rows: nav }] = await Promise.all([
    query(`SELECT r.*, u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.chapter_id=$1 AND r.status='approved' ORDER BY r.featured DESC, r.created_at DESC LIMIT 50`, [ch.id]),
    req.user ? query('SELECT * FROM reviews WHERE chapter_id=$1 AND user_id=$2', [ch.id, req.user.id]) : { rows: [] },
    req.user && access ? query('SELECT * FROM journal_entries WHERE chapter_id=$1 AND user_id=$2', [ch.id, req.user.id]) : { rows: [] },
    query('SELECT slug, number, title, label FROM chapters WHERE publish_on IS NOT NULL AND publish_on <= $1::date ORDER BY number, id', [h.today()]),
  ]);
  const idx = nav.findIndex((n) => n.slug === ch.slug);
  const avg = reviews.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : 0;
  res.render('chapter', {
    title: ch.label && !/^Chapter/.test(ch.label) ? ch.title : `${h.chLabel(ch)}: ${ch.title}`, ch, access, reviews, mine, journal, avg,
    prev: idx > 0 ? nav[idx - 1] : null, next: idx >= 0 && idx < nav.length - 1 ? nav[idx + 1] : null,
    commentaryHtml: access ? h.markdown(ch.commentary) : '',
    previewHtml: access ? '' : h.markdown(previewOf(ch.commentary)),
    notes: access && ch.notes ? Object.entries(ch.notes).sort((a, b) => Number(a[0]) - Number(b[0])) : [],
  });
}));

router.post('/chapters/:slug/review', formLimiter, h.requireLogin, wrap(async (req, res) => {
  const { rows: [ch] } = await query('SELECT * FROM chapters WHERE slug=$1 AND publish_on <= $2::date', [req.params.slug, h.today()]);
  if (!ch) return res.status(404).render('error', { title: 'Not found', message: 'That chapter does not exist.' });
  const back = `/chapters/${ch.slug}#reviews`;
  if (!canRead(req.user, ch)) { h.flash(req, 'error', 'Unlock this chapter review to share your thoughts on it.'); return res.redirect(back); }
  const rating = parseInt(req.body.rating, 10);
  const body = h.str(req.body.body, 2000);
  if (!(rating >= 1 && rating <= 5)) { h.flash(req, 'error', 'Choose a rating from 1 to 5 stars.'); return res.redirect(back); }
  if (body.length < 10) { h.flash(req, 'error', 'Please write at least a sentence about this chapter.'); return res.redirect(back); }
  await query(
    `INSERT INTO reviews (chapter_id, user_id, rating, body) VALUES ($1,$2,$3,$4)
     ON CONFLICT (chapter_id, user_id) DO UPDATE SET rating=EXCLUDED.rating, body=EXCLUDED.body, status='pending', featured=FALSE, updated_at=NOW()`,
    [ch.id, req.user.id, rating, body]);
  h.flash(req, 'success', 'Thank you. Your review will appear once the author has read it.');
  res.redirect(back);
}));

router.post('/chapters/:slug/journal', formLimiter, h.requireLogin, wrap(async (req, res) => {
  const { rows: [ch] } = await query('SELECT * FROM chapters WHERE slug=$1 AND publish_on <= $2::date', [req.params.slug, h.today()]);
  if (!ch || !canRead(req.user, ch)) return res.redirect('/chapters');
  const body = h.str(req.body.body, 10000);
  if (!body) await query('DELETE FROM journal_entries WHERE chapter_id=$1 AND user_id=$2', [ch.id, req.user.id]);
  else {
    await query(
      `INSERT INTO journal_entries (chapter_id, user_id, body) VALUES ($1,$2,$3)
       ON CONFLICT (chapter_id, user_id) DO UPDATE SET body=EXCLUDED.body, updated_at=NOW()`, [ch.id, req.user.id, body]);
  }
  h.flash(req, 'success', 'Your reflections are saved. Only you can see them.');
  res.redirect(`/chapters/${ch.slug}#journal`);
}));

router.get('/journal', h.requireLogin, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT j.*, c.number, c.label, c.title, c.slug FROM journal_entries j JOIN chapters c ON c.id=j.chapter_id
     WHERE j.user_id=$1 ORDER BY c.number`, [req.user.id]);
  res.render('journal', { title: 'My reflections', entries: rows });
}));

router.get('/account', h.requireLogin, wrap(async (req, res) => {
  const { rows: payments } = await query("SELECT * FROM payments WHERE user_id=$1 AND status IN ('success','pending','rejected') ORDER BY created_at DESC", [req.user.id]);
  res.render('account', { title: 'My account', payments });
}));

router.get('/support', (req, res) => res.redirect('/pass'));
const donationRef = (user) => `NITP-${String(user.id).padStart(4, '0')}`;
function donationLimits(site) {
  const min = Math.max(100, Math.round(Number(site.donation_min_ngn) || 1000));
  const suggested = String(site.donation_suggested || '').split(',').map(Number).filter((n) => n >= min);
  return { min, suggested: suggested.length ? suggested : [min] };
}

router.get('/pass', wrap(async (req, res) => {
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM chapters WHERE publish_on IS NOT NULL AND publish_on <= $1::date', [h.today()]);
  const site = res.locals.site;
  const { min, suggested } = donationLimits(site);
  let pending = null;
  if (req.user) ({ rows: [pending] } = await query("SELECT * FROM payments WHERE user_id=$1 AND method='bank' AND status='pending' ORDER BY id DESC LIMIT 1", [req.user.id]));
  const bankReady = !!(site.bank_account_number && site.bank_name && site.bank_account_name);
  res.render('pass', {
    title: 'Donate to read the book', released: c.n, min, suggested, pending, bankReady,
    reference: req.user ? donationRef(req.user) : null, today: h.today(),
  });
}));

// Bank transfer: the reader transfers to the author's account, then tells us here.
// The author confirms it in Admin → Donations, which unlocks the book (or it unlocks
// at once if "Unlock immediately" is switched on in Settings).
const transferLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { h.flash(req, 'error', 'Too many attempts. Please wait a little and try again.'); res.redirect('/pass'); },
});
const proofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 20 } });
function imageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  return null;
}
router.post('/pass/transfer', transferLimiter, h.requireLogin, (req, res, next) => proofUpload.single('proof')(req, res, (err) => {
  if (err) { h.flash(req, 'error', 'The receipt must be an image or PDF under 4 MB.'); return res.redirect('/pass'); }
  next();
}), h.checkCsrf, wrap(async (req, res) => {
  const site = res.locals.site;
  const { min } = donationLimits(site);
  const naira = Math.round(Number(String(req.body.amount || '').replace(/[,₦\s]/g, '')));
  const sender = h.str(req.body.sender_name, 120);
  const paidOn = h.isoDate(req.body.paid_on) ? req.body.paid_on : null;
  if (!Number.isFinite(naira) || naira < min) { h.flash(req, 'error', `The minimum donation is ${h.naira(min)}.`); return res.redirect('/pass'); }
  if (naira > 50000000) { h.flash(req, 'error', 'Please check the amount.'); return res.redirect('/pass'); }
  if (sender.length < 2) { h.flash(req, 'error', 'Enter the name on the account you sent the money from, so we can find your transfer.'); return res.redirect('/pass'); }
  if (!paidOn || paidOn > h.today()) { h.flash(req, 'error', 'Enter the date you made the transfer.'); return res.redirect('/pass'); }
  let mime = null;
  if (req.file && req.file.size) {
    mime = imageMime(req.file.buffer);
    if (!mime) { h.flash(req, 'error', 'Upload the receipt as a JPG, PNG, WEBP or PDF.'); return res.redirect('/pass'); }
  }
  const { rows: [open] } = await query("SELECT COUNT(*)::int AS n FROM payments WHERE user_id=$1 AND method='bank' AND status='pending'", [req.user.id]);
  if (open.n >= 3) { h.flash(req, 'error', 'You already have donations waiting for confirmation. We’ll confirm them shortly.'); return res.redirect('/pass'); }
  const instant = site.bank_instant_unlock === 'yes';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let proofId = null;
    if (mime) ({ rows: [{ id: proofId }] } = await c.query("INSERT INTO images (purpose, mime, data) VALUES ('proof',$1,$2) RETURNING id", [mime, req.file.buffer]));
    const reference = `${donationRef(req.user)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await c.query(
      `INSERT INTO payments (user_id, reference, amount_kobo, currency, status, method, channel, sender_name, paid_on, proof_id, message)
       VALUES ($1,$2,$3,'NGN','pending','bank','bank transfer',$4,$5,$6,$7)`,
      [req.user.id, reference, naira * 100, sender, paidOn, proofId, h.optStr(req.body.message, 300)]);
    if (instant) await c.query("UPDATE users SET has_pass=TRUE, pass_granted_at=COALESCE(pass_granted_at, NOW()), pass_source=COALESCE(pass_source,'transfer') WHERE id=$1", [req.user.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  if (instant) {
    h.flash(req, 'success', 'Thank you for your donation. The whole book is now unlocked for you.');
    return res.redirect('/chapters');
  }
  h.flash(req, 'success', 'Thank you! We’ve received your details. As soon as the author confirms the transfer, every chapter unlocks on your account. You can keep reading the free chapters meanwhile.');
  res.redirect('/pass');
}));

router.post('/subscribe', formLimiter, wrap(async (req, res) => {
  const email = h.str(req.body.email, 200).toLowerCase();
  const back = h.safeNext(req.body.back) || '/';
  if (!h.isEmail(email)) { h.flash(req, 'error', 'Please enter a valid email address.'); return res.redirect(back + '#subscribe'); }
  await query('INSERT INTO subscribers (email, name) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [email, h.optStr(req.body.name, 80)]);
  h.flash(req, 'success', 'You’re on the list. We’ll email you when each new chapter review is released.');
  res.redirect(back + '#subscribe');
}));

router.get('/cover', wrap(async (req, res) => {
  const { rows: [img] } = await query("SELECT * FROM images WHERE purpose='cover' ORDER BY id DESC LIMIT 1");
  if (!img) return res.redirect('/static/cover.jpg');
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.send(img.data);
}));

module.exports = router;
