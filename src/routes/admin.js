const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, query } = require('../db');
const h = require('../helpers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
router.use(h.requireAuthor);
router.use((req, res, next) => { res.locals.adminArea = true; next(); });
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That record does not exist.' });

// ---------- Dashboard ----------
router.get('/', wrap(async (req, res) => {
  const [{ rows: [s] }, { rows: pending }, { rows: payments }, { rows: upcoming }] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*)::int FROM users WHERE role='reader') AS readers,
      (SELECT COUNT(*)::int FROM users WHERE role='reader' AND has_pass) AS pass_holders,
      (SELECT COALESCE(SUM(amount_kobo),0)/100.0 FROM payments WHERE status='success') AS revenue,
      (SELECT COUNT(*)::int FROM payments WHERE status='success') AS sales,
      (SELECT COUNT(*)::int FROM reviews WHERE status='pending') AS pending_reviews,
      (SELECT COUNT(*)::int FROM subscribers) AS subscribers,
      (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS pending_transfers,
      (SELECT COALESCE(ROUND(AVG(rating),1),0) FROM reviews WHERE status='approved') AS avg_rating`),
    query(`SELECT r.*, u.name, c.number, c.label, c.title FROM reviews r JOIN users u ON u.id=r.user_id JOIN chapters c ON c.id=r.chapter_id
           WHERE r.status='pending' ORDER BY r.created_at LIMIT 5`),
    query(`SELECT p.*, u.name, u.email FROM payments p LEFT JOIN users u ON u.id=p.user_id WHERE p.status='success' ORDER BY p.paid_at DESC LIMIT 8`),
    query('SELECT * FROM chapters WHERE publish_on IS NULL OR publish_on > $1::date ORDER BY publish_on NULLS LAST, number LIMIT 5', [h.today()]),
  ]);
  res.render('admin/dashboard', { title: 'Author dashboard', s, pending, payments, upcoming, paystackOn: !!process.env.PAYSTACK_SECRET_KEY });
}));

// ---------- Chapters ----------
router.get('/chapters', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, COUNT(r.id) FILTER (WHERE r.status='approved')::int AS reviews,
       COALESCE(ROUND(AVG(r.rating) FILTER (WHERE r.status='approved'),1),0) AS avg_rating
     FROM chapters c LEFT JOIN reviews r ON r.chapter_id=c.id GROUP BY c.id ORDER BY c.number, c.id`);
  res.render('admin/chapters', { title: 'Chapters', chapters: rows, today: h.today() });
}));

function readChapter(b) {
  return {
    number: Math.max(-9, Math.min(999, parseInt(b.number, 10) || 0)),
    label: h.optStr(b.label, 40), part: h.optStr(b.part, 120),
    title: h.str(b.title, 160), teaser: h.optStr(b.teaser, 1000), commentary: h.optStr(b.commentary, 60000),
    key_ideas: h.optStr(b.key_ideas, 4000), excerpt: h.optStr(b.excerpt, 4000), questions: h.optStr(b.questions, 4000),
    quotes: h.optStr(b.quotes, 4000), is_free: b.is_free === 'on', publish_on: h.isoDate(b.publish_on),
  };
}
async function uniqueSlug(base, exceptId) {
  let slug = base, i = 2;
  // eslint-disable-next-line no-await-in-loop
  while ((await query('SELECT 1 FROM chapters WHERE slug=$1 AND id<>$2', [slug, exceptId || 0])).rows.length) slug = `${base}-${i++}`;
  return slug;
}

router.get('/chapters/new', wrap(async (req, res) => {
  const { rows: [m] } = await query('SELECT COALESCE(MAX(number),0)+1 AS n FROM chapters');
  res.render('admin/chapter-edit', { title: 'New chapter review', ch: { number: m.n }, error: null });
}));

router.post('/chapters', wrap(async (req, res) => {
  const v = readChapter(req.body);
  if (!v.title) return res.status(400).render('admin/chapter-edit', { title: 'New chapter review', ch: v, error: 'Give the chapter a title.' });
  const slug = await uniqueSlug(h.slugify(`chapter-${v.number}-${v.title}`));
  const { rows: [c] } = await query(
    `INSERT INTO chapters (number, slug, title, teaser, commentary, key_ideas, excerpt, questions, quotes, is_free, publish_on, label, part)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [v.number, slug, v.title, v.teaser, v.commentary, v.key_ideas, v.excerpt, v.questions, v.quotes, v.is_free, v.publish_on, v.label, v.part]);
  h.flash(req, 'success', v.publish_on ? `Chapter ${v.number} saved. It goes live on ${h.longDate(v.publish_on)}.` : `Chapter ${v.number} saved as a draft.`);
  res.redirect(`/admin/chapters/${c.id}`);
}));

router.get('/chapters/:id', wrap(async (req, res) => {
  const { rows: [ch] } = await query('SELECT * FROM chapters WHERE id=$1', [Number(req.params.id) || 0]);
  if (!ch) return notFound(res);
  res.render('admin/chapter-edit', { title: `Edit chapter ${ch.number}`, ch, error: null });
}));

router.post('/chapters/:id', wrap(async (req, res) => {
  const { rows: [old] } = await query('SELECT * FROM chapters WHERE id=$1', [Number(req.params.id) || 0]);
  if (!old) return notFound(res);
  const v = readChapter(req.body);
  if (!v.title) return res.status(400).render('admin/chapter-edit', { title: `Edit chapter ${old.number}`, ch: { ...old, ...v }, error: 'Give the chapter a title.' });
  await query(
    `UPDATE chapters SET number=$1, title=$2, teaser=$3, commentary=$4, key_ideas=$5, excerpt=$6, questions=$7, quotes=$8,
       is_free=$9, publish_on=$10, label=$12, part=$13, updated_at=NOW() WHERE id=$11`,
    [v.number, v.title, v.teaser, v.commentary, v.key_ideas, v.excerpt, v.questions, v.quotes, v.is_free, v.publish_on, old.id, v.label, v.part]);
  h.flash(req, 'success', 'Chapter saved.');
  res.redirect(`/admin/chapters/${old.id}`);
}));

router.post('/chapters/:id/delete', wrap(async (req, res) => {
  await query('DELETE FROM chapters WHERE id=$1', [Number(req.params.id) || 0]);
  h.flash(req, 'success', 'Chapter deleted, along with its reviews and readers’ reflections.');
  res.redirect('/admin/chapters');
}));

// ---------- Reviews ----------
router.get('/reviews', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'hidden'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await query(
    `SELECT r.*, u.name, u.email, c.number, c.label, c.title, c.slug FROM reviews r JOIN users u ON u.id=r.user_id JOIN chapters c ON c.id=r.chapter_id
     WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT 300`, [status]);
  res.render('admin/reviews', { title: 'Reader reviews', reviews: rows, status });
}));

router.post('/reviews/:id/status', wrap(async (req, res) => {
  const status = ['approved', 'hidden', 'pending'].includes(req.body.status) ? req.body.status : null;
  if (status) await query('UPDATE reviews SET status=$1, featured=CASE WHEN $1=\'approved\' THEN featured ELSE FALSE END WHERE id=$2', [status, Number(req.params.id) || 0]);
  res.redirect(h.safeNext(req.body.back) || '/admin/reviews');
}));

router.post('/reviews/:id/feature', wrap(async (req, res) => {
  await query("UPDATE reviews SET featured = NOT featured WHERE id=$1 AND status='approved'", [Number(req.params.id) || 0]);
  res.redirect(h.safeNext(req.body.back) || '/admin/reviews?status=approved');
}));

// ---------- Readers ----------
router.get('/readers', wrap(async (req, res) => {
  const q = h.str(req.query.q, 100);
  const params = [];
  let where = "role='reader'";
  if (q) { params.push(`%${q}%`); where += ' AND (name ILIKE $1 OR email ILIKE $1)'; }
  const { rows } = await query(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
  res.render('admin/readers', { title: 'Readers', readers: rows, q, tempPassword: req.session.tempPassword || null });
  delete req.session.tempPassword;
}));

router.post('/readers/:id/pass', wrap(async (req, res) => {
  const grant = req.body.grant === '1';
  await query(`UPDATE users SET has_pass=$1, pass_granted_at=CASE WHEN $1 THEN COALESCE(pass_granted_at, NOW()) ELSE NULL END,
               pass_source=CASE WHEN $1 THEN COALESCE(pass_source,'gift') ELSE NULL END WHERE id=$2 AND role='reader'`, [grant, Number(req.params.id) || 0]);
  h.flash(req, 'success', grant ? 'Free access given.' : 'Access removed.');
  res.redirect('/admin/readers');
}));

router.post('/readers/:id/reset-password', wrap(async (req, res) => {
  const temp = crypto.randomBytes(6).toString('base64url');
  const { rows: [u] } = await query("UPDATE users SET password_hash=$1, must_change_password=TRUE, failed_logins=0, locked_until=NULL WHERE id=$2 AND role='reader' RETURNING email",
    [await bcrypt.hash(temp, 12), Number(req.params.id) || 0]);
  if (u) req.session.tempPassword = { email: u.email, password: temp };
  res.redirect('/admin/readers');
}));

// ---------- Payments & subscribers ----------
router.get('/payments', wrap(async (req, res) => {
  const { rows } = await query(`SELECT p.*, u.name, u.email, u.has_pass FROM payments p LEFT JOIN users u ON u.id=p.user_id
    WHERE p.status <> 'initialized' OR p.created_at > NOW() - INTERVAL '2 days'
    ORDER BY (p.status='pending') DESC, p.created_at DESC LIMIT 500`);
  res.render('admin/payments', { title: 'Donations', payments: rows });
}));

router.get('/payments/:id/proof', wrap(async (req, res) => {
  const { rows: [img] } = await query("SELECT i.* FROM payments p JOIN images i ON i.id=p.proof_id WHERE p.id=$1", [Number(req.params.id) || 0]);
  if (!img) return res.status(404).render('error', { title: 'Not found', message: 'No receipt was uploaded for this donation.' });
  res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="receipt-${req.params.id}.${img.mime.split('/')[1]}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  res.send(img.data);
}));

// Confirm a bank transfer: marks it received and unlocks the book for the reader
router.post('/payments/:id/confirm', wrap(async (req, res) => {
  const amount = Math.round(Number(String(req.body.amount || '').replace(/[,₦\s]/g, '')));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [p] } = await c.query("SELECT * FROM payments WHERE id=$1 AND method='bank' FOR UPDATE", [Number(req.params.id) || 0]);
    if (!p || p.status === 'success') { await c.query('ROLLBACK'); return res.redirect('/admin/payments'); }
    await c.query("UPDATE payments SET status='success', paid_at=COALESCE(paid_on::timestamptz, NOW()), reviewed_at=NOW(), review_note=NULL, amount_kobo=$2 WHERE id=$1",
      [p.id, amount > 0 ? amount * 100 : p.amount_kobo]);
    if (p.user_id) await c.query("UPDATE users SET has_pass=TRUE, pass_granted_at=COALESCE(pass_granted_at, NOW()), pass_source=COALESCE(pass_source,'transfer') WHERE id=$1", [p.user_id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  h.flash(req, 'success', 'Transfer confirmed. The reader now has the whole book.');
  res.redirect('/admin/payments');
}));

// Reject: the money wasn't found. Access is removed unless another donation was confirmed.
router.post('/payments/:id/reject', wrap(async (req, res) => {
  const { rows: [p] } = await query("UPDATE payments SET status='rejected', reviewed_at=NOW(), review_note=$2 WHERE id=$1 AND method='bank' AND status='pending' RETURNING *",
    [Number(req.params.id) || 0, h.optStr(req.body.note, 300)]);
  if (p && p.user_id) {
    await query(`UPDATE users SET has_pass=FALSE, pass_granted_at=NULL, pass_source=NULL WHERE id=$1 AND pass_source='transfer'
      AND NOT EXISTS (SELECT 1 FROM payments WHERE user_id=$1 AND status='success')`, [p.user_id]);
  }
  h.flash(req, 'success', 'Marked as not received.');
  res.redirect('/admin/payments');
}));

router.get('/subscribers', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 2000');
  res.render('admin/subscribers', { title: 'Email subscribers', subscribers: rows });
}));

router.get('/subscribers.csv', wrap(async (req, res) => {
  const { rows } = await query('SELECT email, name, created_at FROM subscribers ORDER BY created_at');
  const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"' });
  res.send(['email,name,joined', ...rows.map((r) => [r.email, r.name, new Date(r.created_at).toISOString().slice(0, 10)].map(esc).join(','))].join('\n'));
}));

// ---------- Settings ----------
const SETTINGS = ['book_title', 'subtitle', 'author_name', 'tagline', 'blurb', 'author_bio', 'donation_min_ngn', 'donation_suggested', 'pass_name', 'amazon_url', 'selar_url', 'contact_email',
  'bank_name', 'bank_account_name', 'bank_account_number', 'bank_instructions', 'bank_instant_unlock', 'whatsapp_number'];
router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Site settings', paystackOn: !!process.env.PAYSTACK_SECRET_KEY }));

router.post('/settings', wrap(async (req, res) => {
  const b = req.body;
  for (const k of ['amazon_url', 'selar_url']) {
    if (h.safeUrl(b[k]) === null) { h.flash(req, 'error', 'Store links must start with https://'); return res.redirect('/admin/settings'); }
  }
  const price = Math.round(Number(String(b.donation_min_ngn || '').replace(/[,₦\s]/g, '')));
  if (!(price >= 100 && price <= 10000000)) { h.flash(req, 'error', 'Set a minimum donation of at least ₦100.'); return res.redirect('/admin/settings'); }
  const suggested = String(b.donation_suggested || '').split(/[,\s]+/).map((x) => Math.round(Number(x.replace(/[₦]/g, '')))).filter((n) => n >= price).slice(0, 4);
  const acct = h.str(b.bank_account_number, 30).replace(/[\s-]/g, '');
  if (acct && !/^\d{6,20}$/.test(acct)) { h.flash(req, 'error', 'The account number should contain digits only (10 digits for Nigerian banks).'); return res.redirect('/admin/settings'); }
  const wa = h.str(b.whatsapp_number, 20).replace(/[^\d]/g, '');
  if (b.contact_email && !h.isEmail(h.str(b.contact_email))) { h.flash(req, 'error', 'Enter a valid contact email.'); return res.redirect('/admin/settings'); }
  const values = {
    book_title: h.str(b.book_title, 120) || 'Nobody Is the Problem', author_name: h.str(b.author_name, 80), tagline: h.str(b.tagline, 200),
    blurb: h.str(b.blurb, 3000), author_bio: h.str(b.author_bio, 3000), donation_min_ngn: String(price), donation_suggested: (suggested.length ? suggested : [price]).join(','), pass_name: h.str(b.pass_name, 60) || 'Supporter access',
    amazon_url: h.safeUrl(b.amazon_url) || '', selar_url: h.safeUrl(b.selar_url) || '', contact_email: h.str(b.contact_email, 200),
    subtitle: h.str(b.subtitle, 200), bank_name: h.str(b.bank_name, 80), bank_account_name: h.str(b.bank_account_name, 120), bank_account_number: acct,
    bank_instructions: h.str(b.bank_instructions, 500), bank_instant_unlock: b.bank_instant_unlock === 'yes' ? 'yes' : 'no', whatsapp_number: wa,
  };
  for (const k of SETTINGS) {
    // eslint-disable-next-line no-await-in-loop
    await query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, values[k]]);
  }
  h.flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
router.post('/settings/cover', (req, res, next) => upload.single('cover')(req, res, (err) => {
  if (err) { h.flash(req, 'error', 'The cover must be an image under 4 MB.'); return res.redirect('/admin/settings'); }
  next();
}), h.checkCsrf, wrap(async (req, res) => {
  const mime = req.file && imageType(req.file.buffer);
  if (!mime) { h.flash(req, 'error', 'Upload the cover as a PNG, JPG or WEBP image.'); return res.redirect('/admin/settings'); }
  await query("DELETE FROM images WHERE purpose='cover'");
  await query("INSERT INTO images (purpose, mime, data) VALUES ('cover',$1,$2)", [mime, req.file.buffer]);
  h.flash(req, 'success', 'Book cover updated.');
  res.redirect('/admin/settings');
}));

module.exports = router;
