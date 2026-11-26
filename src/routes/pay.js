// Reader's Pass payments with Paystack (https://paystack.com/docs/payments/accept-payments).
// Flow: /pay/start → Paystack checkout → /pay/callback verifies with Paystack's API.
// The signed webhook (/pay/webhook) grants the pass too, in case the reader closes the
// browser before returning. Granting is idempotent, so both paths are safe.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool, query, getSettings } = require('../db');
const h = require('../helpers');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const BASE = (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, '');
const SECRET = () => process.env.PAYSTACK_SECRET_KEY || '';

const startLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { h.flash(req, 'error', 'Too many payment attempts. Please wait a few minutes.'); res.redirect('/pass'); },
});

async function paystack(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${SECRET()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== true) throw new Error(j.message || `Paystack error ${r.status}`);
  return j.data;
}

// Marks a payment successful and grants the pass, once. Returns the user id or null.
async function settle(data) {
  if (!data || data.status !== 'success' || !data.reference) return null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE reference=$1 FOR UPDATE', [data.reference]);
    if (!p) { await c.query('ROLLBACK'); return null; }
    if (p.status === 'success') { await c.query('COMMIT'); return p.user_id; }
    if (Number(data.amount) < p.amount_kobo || String(data.currency || 'NGN').toUpperCase() !== p.currency) {
      await c.query("UPDATE payments SET status='failed', raw=$2 WHERE id=$1", [p.id, JSON.stringify({ reason: 'amount_or_currency_mismatch', data })]);
      await c.query('COMMIT');
      return null;
    }
    await c.query("UPDATE payments SET status='success', channel=$2, paid_at=COALESCE($3::timestamptz, NOW()), raw=$4 WHERE id=$1",
      [p.id, data.channel || null, data.paid_at || null, JSON.stringify(data)]);
    await c.query("UPDATE users SET has_pass=TRUE, pass_granted_at=COALESCE(pass_granted_at, NOW()), pass_source=COALESCE(pass_source,'donation') WHERE id=$1", [p.user_id]);
    await c.query('COMMIT');
    return p.user_id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

router.post('/start', startLimiter, h.requireLogin, wrap(async (req, res) => {
  // Readers who already have access can still donate again if they wish
  if (!SECRET()) { h.flash(req, 'error', 'Online payment isn’t switched on yet. Please check back soon.'); return res.redirect('/pass'); }
  const site = await getSettings();
  // Pay-what-you-want donation, at least the minimum set by the author
  const min = Math.max(100, Math.round(Number(site.donation_min_ngn) || 1000));
  const naira = Math.round(Number(String(req.body.amount || '').replace(/[,₦\s]/g, '')));
  if (!Number.isFinite(naira) || naira < min) { h.flash(req, 'error', `The minimum donation is ${h.naira(min)}.`); return res.redirect('/pass'); }
  if (naira > 5000000) { h.flash(req, 'error', 'For donations above ₦5,000,000, please contact the author.'); return res.redirect('/pass'); }
  const reference = `NITP-${req.user.id}-${crypto.randomBytes(6).toString('hex')}`;
  const amountKobo = naira * 100;
  await query('INSERT INTO payments (user_id, reference, amount_kobo, currency, message) VALUES ($1,$2,$3,$4,$5)', [req.user.id, reference, amountKobo, 'NGN', h.optStr(req.body.message, 300)]);
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  try {
    const data = await paystack('POST', '/transaction/initialize', {
      email: req.user.email, amount: amountKobo, currency: 'NGN', reference,
      callback_url: `${base}/pay/callback`,
      metadata: { user_id: req.user.id, product: 'book_donation', cancel_action: `${base}/pass` },
    });
    const url = String(data.authorization_url || '');
    if (!/^https:\/\/([a-z0-9-]+\.)*paystack\.(com|co)\//i.test(url) && !process.env.PAYSTACK_BASE_URL) throw new Error('Unexpected checkout URL');
    res.redirect(url);
  } catch (e) {
    console.error('Paystack initialize failed:', e.message);
    await query("UPDATE payments SET status='failed', raw=$2 WHERE reference=$1", [reference, JSON.stringify({ error: e.message })]);
    h.flash(req, 'error', 'We couldn’t start the payment. Please try again in a moment.');
    res.redirect('/pass');
  }
}));

router.get('/callback', wrap(async (req, res) => {
  const reference = h.str(req.query.reference || req.query.trxref, 100);
  if (!reference) return res.redirect('/pass');
  try {
    const data = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const userId = await settle(data);
    if (userId) {
      h.flash(req, 'success', 'Thank you for your donation. Every chapter of the book is now unlocked for you.');
      return res.redirect('/chapters');
    }
    if (data && data.status === 'abandoned') await query("UPDATE payments SET status='abandoned' WHERE reference=$1 AND status='initialized'", [reference]);
    h.flash(req, 'error', 'The payment wasn’t completed, so you haven’t been charged. You can try again.');
  } catch (e) {
    console.error('Paystack verify failed:', e.message);
    h.flash(req, 'error', 'We couldn’t confirm the payment yet. If you were charged, your pass will activate within a few minutes, or contact us.');
  }
  res.redirect('/pass');
}));

router.post('/webhook', wrap(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = String(req.get('x-paystack-signature') || '');
  const expected = crypto.createHmac('sha512', SECRET()).update(raw).digest('hex');
  if (!SECRET() || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).end();
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  if (event.event === 'charge.success') await settle(event.data);
  res.status(200).end();
}));

module.exports = router;
module.exports.settle = settle;
