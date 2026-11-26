// End-to-end test of the book site, including payments against a fake Paystack.
// Run in the Replit workspace (not the live deployment):  npm test
// It starts its own server on a spare port, creates throwaway readers and chapters
// (marked with a run id), and removes them, restoring settings and the cover, at the end.
require('../src/env');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
if (process.env.REPLIT_DEPLOYMENT) { console.error('Refusing to run tests on the live deployment.'); process.exit(1); }

const PORT = 5099, MOCK = 5999, B = `http://127.0.0.1:${PORT}`;
const SECRET = 'sk_test_fake_for_tests';
const RUN = Date.now().toString(36);
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
const AUTHOR = { email: `author-${RUN}@example.test`, password: 'AuthorTest2026' };

let passed = 0, failed = 0;
const check = (c, name) => { if (c) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } };

// ---- Fake Paystack ----
const charges = new Map(); // reference -> { amount, email }
const shortPay = new Set(); // references to report as underpaid
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization === `Bearer ${SECRET}`;
    res.setHeader('Content-Type', 'application/json');
    if (!auth) { res.statusCode = 401; return res.end(JSON.stringify({ status: false, message: 'bad key' })); }
    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      const j = JSON.parse(body);
      charges.set(j.reference, { amount: j.amount, email: j.email, currency: j.currency });
      return res.end(JSON.stringify({ status: true, data: { authorization_url: `http://127.0.0.1:${MOCK}/checkout/${j.reference}`, reference: j.reference } }));
    }
    const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (req.method === 'GET' && m) {
      const ref = decodeURIComponent(m[1]); const c = charges.get(ref);
      if (!c) { res.statusCode = 404; return res.end(JSON.stringify({ status: false, message: 'not found' })); }
      return res.end(JSON.stringify({ status: true, data: { status: 'success', reference: ref, amount: shortPay.has(ref) ? c.amount - 100 : c.amount, currency: 'NGN', channel: 'card', paid_at: new Date().toISOString() } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

function agent() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (r) => { for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } };
  return {
    async req(p, { method = 'GET', form } = {}) {
      const headers = { cookie: cookie() };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const r = await fetch(B + p, { method, headers, body, redirect: 'manual' });
      keep(r);
      return { status: r.status, loc: r.headers.get('location'), text: await r.text(), type: r.headers.get('content-type') };
    },
    async csrf(p) { const r = await this.req(p); return (r.text.match(/name="_csrf" value="([^"]+)"/) || [])[1]; },
    async post(page, action, form) { return this.req(action, { method: 'POST', form: { _csrf: await this.csrf(page), ...form } }); },
    cookieHeader() { return cookie(); },
    async form(page, action, fields, file, csrf = true) {
      const fd = new FormData();
      if (csrf) fd.append('_csrf', await this.csrf(page));
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      if (file) fd.append(file.field, new Blob([file.buf], { type: file.type }), file.name);
      const r = await fetch(B + action, { method: 'POST', body: fd, headers: { cookie: cookie() }, redirect: 'manual' });
      keep(r);
      return { status: r.status, loc: r.headers.get('location') };
    },
    async upload(page, action, field, buf) {
      const fd = new FormData();
      fd.append('_csrf', await this.csrf(page));
      fd.append(field, new Blob([buf], { type: 'image/png' }), 'cover.png');
      const r = await fetch(B + action, { method: 'POST', body: fd, headers: { cookie: cookie() }, redirect: 'manual' });
      keep(r);
      return { status: r.status, loc: r.headers.get('location') };
    },
  };
}
async function waitUp() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) return; } catch (e) { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not start');
}

(async () => {
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
  const server = spawn(process.execPath, [...process.execArgv, path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), PAYSTACK_BASE_URL: `http://127.0.0.1:${MOCK}`, PAYSTACK_SECRET_KEY: SECRET, PUBLIC_URL: B, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  const { rows: savedSettings } = await db.query('SELECT * FROM settings');
  const { rows: savedCover } = await db.query("SELECT * FROM images WHERE purpose='cover'");

  try {
    await waitUp();
    await db.query("INSERT INTO users (role,email,password_hash,name,has_pass) VALUES ('author',$1,$2,'Test Author',TRUE)", [AUTHOR.email, await bcrypt.hash(AUTHOR.password, 10)]);
    const tz = process.env.SITE_TIMEZONE || 'Africa/Lagos';
    const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 864e5));

    console.log('\nAuthor: chapters');
    const au = agent();
    let r = await au.post('/login', '/login', { email: AUTHOR.email, password: AUTHOR.password });
    check(r.loc === '/admin', 'author signs in to the dashboard');
    const mk = async (num, title, extra) => {
      const res = await au.post('/admin/chapters/new', '/admin/chapters', { number: String(num), title, teaser: `Teaser ${title}`, commentary: `## Heading\n\nSecret commentary ${title} <script>alert(1)</script>\n\n${'Opening words of the chapter. '.repeat(40)}\n\nHidden ending ${title}`, key_ideas: 'Idea one\nIdea two', questions: 'Question one?\nQuestion two?', quotes: 'A short line to share.', excerpt: `Excerpt ${title}`, ...extra });
      const { rows: [c] } = await db.query('SELECT * FROM chapters WHERE title=$1', [title]);
      return c;
    };
    const free = await mk(901, `Free ${RUN}`, { is_free: 'on', publish_on: day(0) });
    const paid = await mk(902, `Paid ${RUN}`, { publish_on: day(0) });
    const soon = await mk(903, `Soon ${RUN}`, { publish_on: day(30) });
    const draft = await mk(904, `Draft ${RUN}`, {});
    check(free && paid && soon && draft, 'author creates free, paid, scheduled and draft chapters');

    console.log('\nVisitors & access');
    const anon = agent();
    r = await anon.req('/chapters');
    check(r.text.includes(`Free ${RUN}`) && r.text.includes(`Paid ${RUN}`) && r.text.includes(`Soon ${RUN}`) && !r.text.includes(`Draft ${RUN}`), 'chapter list shows released and upcoming chapters, hides drafts');
    check(r.text.includes('Coming '), 'scheduled chapter shows its release date');
    r = await anon.req(`/chapters/${free.slug}`);
    check(r.text.includes(`Secret commentary Free ${RUN}`), 'a free chapter is readable by anyone');
    check(!r.text.includes('<script>alert(1)</script>'), 'commentary HTML is sanitised');
    r = await anon.req('/chapters/chapter-1');
    if (r.status === 200) {
      check(r.text.includes('id="notes"') && r.text.includes('href="#note-1"') && r.text.includes('/static/book/'), 'the free Chapter 1 from the manuscript shows its figures and linked notes');
      r = await anon.req('/chapters/chapter-2');
      check(r.text.includes('Unlock the rest of the book') && !r.text.includes('id="notes"') && !r.text.includes('Institutional Mirror'), 'manuscript Chapter 2 is locked for visitors');
    }
    r = await anon.req(`/chapters/${paid.slug}`);
    check(!r.text.includes('Idea one') && !r.text.includes(`Hidden ending Paid ${RUN}`) && r.text.includes('Unlock the rest of the book') && r.text.includes('Opening words of the chapter'), 'a locked chapter shows the opening paragraphs and a donate prompt, not the full text');
    r = await anon.req(`/chapters/${soon.slug}`);
    check(r.status === 404, 'scheduled chapter cannot be opened before its date');

    console.log('\nReaders, reviews & journal');
    const rd = agent();
    const READER = `reader-${RUN}@example.test`;
    r = await rd.post('/signup', '/signup', { name: 'Ada Reader', email: READER, password: 'ReaderPass1', subscribe: 'on' });
    check(r.loc === '/chapters', 'reader creates an account');
    await rd.post(`/chapters/${paid.slug}`, `/chapters/${paid.slug}/review`, { rating: '5', body: 'Wonderful chapter, really moving.' });
    const { rows: noRev } = await db.query('SELECT 1 FROM reviews WHERE chapter_id=$1', [paid.id]);
    check(noRev.length === 0, 'readers without the pass cannot review a paid chapter');
    await rd.post(`/chapters/${free.slug}`, `/chapters/${free.slug}/review`, { rating: '5', body: 'This chapter changed how I see blame.' });
    r = await anon.req(`/chapters/${free.slug}`);
    check(!r.text.includes('changed how I see blame'), 'a new review is hidden until the author publishes it');
    const { rows: [rev] } = await db.query('SELECT id FROM reviews WHERE chapter_id=$1', [free.id]);
    await au.post('/admin/reviews', `/admin/reviews/${rev.id}/status`, { status: 'approved' });
    await au.post('/admin/reviews?status=approved', `/admin/reviews/${rev.id}/feature`, {});
    r = await anon.req(`/chapters/${free.slug}`);
    check(r.text.includes('changed how I see blame'), 'published review appears on the chapter');
    r = await anon.req('/');
    check(r.text.includes('changed how I see blame'), 'featured review appears on the home page');
    await rd.post(`/chapters/${free.slug}`, `/chapters/${free.slug}/journal`, { body: `My private note ${RUN}` });
    r = await rd.req('/journal');
    check(r.text.includes(`My private note ${RUN}`), 'reader saves a private reflection');
    r = await anon.req(`/chapters/${free.slug}`);
    check(!r.text.includes(`My private note ${RUN}`), 'reflections are not visible to anyone else');
    r = await rd.req('/admin');
    check(r.status === 403, 'readers cannot open the author dashboard');

    console.log('\nPayments (fake Paystack)');
    const { rows: [minRow] } = await db.query("SELECT value FROM settings WHERE key='donation_min_ngn'");
    const min = Math.round(Number(minRow.value));
    r = await rd.post('/pass', '/pay/start', { amount: String(min - 1) });
    check(r.loc === '/pass', 'a donation below the minimum is refused');
    r = await rd.post('/pass', '/pay/start', { amount: (min + 1500).toLocaleString('en-NG'), message: 'Loved chapter one' });
    check(r.loc && r.loc.startsWith(`http://127.0.0.1:${MOCK}/checkout/`), 'donating redirects to Paystack checkout');
    const ref = r.loc.split('/checkout/')[1];
    const { rows: [pay] } = await db.query('SELECT * FROM payments WHERE reference=$1', [ref]);
    check(pay && pay.amount_kobo === (min + 1500) * 100 && pay.message === 'Loved chapter one', 'the chosen amount (in kobo) and the note are recorded');
    r = await rd.req(`/pay/callback?reference=${ref}`);
    check(r.loc === '/chapters', 'Paystack callback verifies the donation');
    r = await rd.req('/');
    check(r.text.includes('Continue: Chapter 901'), 'home page offers to continue where the reader stopped');
    r = await rd.req(`/chapters/${paid.slug}`);
    check(r.text.includes('Idea one') && r.text.includes(`Secret commentary Paid ${RUN}`), 'after donating, the locked chapter is readable');
    await rd.req(`/pay/callback?reference=${ref}`);
    const { rows: pays } = await db.query("SELECT * FROM payments WHERE reference=$1 AND status='success'", [ref]);
    check(pays.length === 1, 'returning to the callback twice records one payment');

    const r2 = agent();
    await r2.post('/signup', '/signup', { name: 'Short Payer', email: `short-${RUN}@example.test`, password: 'ReaderPass2' });
    r = await r2.post('/pass', '/pay/start', { amount: String(min) });
    const ref2 = r.loc.split('/checkout/')[1]; shortPay.add(ref2);
    await r2.req(`/pay/callback?reference=${ref2}`);
    const { rows: [u2] } = await db.query('SELECT has_pass FROM users WHERE email=$1', [`short-${RUN}@example.test`]);
    check(u2.has_pass === false, 'an underpaid amount does not unlock the book');

    const r3 = agent();
    await r3.post('/signup', '/signup', { name: 'Webhook Reader', email: `hook-${RUN}@example.test`, password: 'ReaderPass3' });
    r = await r3.post('/pass', '/pay/start', { amount: String(min) });
    const ref3 = r.loc.split('/checkout/')[1];
    const event = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: ref3, amount: charges.get(ref3).amount, currency: 'NGN', channel: 'bank_transfer' } });
    let wr = await fetch(B + '/pay/webhook', { method: 'POST', body: event, headers: { 'content-type': 'application/json', 'x-paystack-signature': 'bad' } });
    check(wr.status === 401, 'webhook with a bad signature is rejected');
    const sig = crypto.createHmac('sha512', SECRET).update(event).digest('hex');
    wr = await fetch(B + '/pay/webhook', { method: 'POST', body: event, headers: { 'content-type': 'application/json', 'x-paystack-signature': sig } });
    const { rows: [u3] } = await db.query('SELECT has_pass FROM users WHERE email=$1', [`hook-${RUN}@example.test`]);
    check(wr.status === 200 && u3.has_pass === true, 'signed webhook unlocks the book even if the reader never returns');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    console.log('\nBank transfer donations');
    const base = Object.fromEntries(savedSettings.map((s) => [s.key, s.value || '']));
    await au.post('/admin/settings', '/admin/settings', { ...base, bank_name: 'Test Bank', bank_account_number: '01234 56789', bank_account_name: 'Lincoln Matthew', bank_instant_unlock: 'no' });
    const { rows: [acct] } = await db.query("SELECT value FROM settings WHERE key='bank_account_number'");
    check(acct.value === '0123456789', 'author saves the donation account (spaces removed)');
    const b1 = agent();
    await b1.post('/signup', '/signup', { name: 'Bank Reader', email: `bank-${RUN}@example.test`, password: 'ReaderPass4' });
    const { rows: [bu] } = await db.query('SELECT * FROM users WHERE email=$1', [`bank-${RUN}@example.test`]);
    r = await b1.req('/pass');
    check(r.text.includes('0123456789') && r.text.includes('Test Bank') && r.text.includes(`NITP-${String(bu.id).padStart(4, '0')}`), 'signed-in readers see the account details and their reference');
    r = await anon.req('/pass');
    check(!r.text.includes('0123456789'), 'visitors are asked to sign up before seeing the account');
    const today = day(0);
    r = await b1.form('/pass', '/pass/transfer', { amount: String(min - 1), sender_name: 'Bank Reader', paid_on: today });
    const { rows: none } = await db.query('SELECT * FROM payments WHERE user_id=$1', [bu.id]);
    check(r.loc === '/pass' && none.length === 0, 'a transfer below the minimum is refused');
    r = await b1.form('/pass', '/pass/transfer', { amount: String(min), sender_name: 'Bank Reader', paid_on: today }, null, false);
    check(r.status === 403, 'transfer form without the CSRF token is refused');
    r = await b1.form('/pass', '/pass/transfer', { amount: 'abc', sender_name: 'Bank Reader', paid_on: today }, { field: 'proof', buf: Buffer.from('not an image at all'), type: 'image/png', name: 'x.png' });
    const { rows: none2 } = await db.query('SELECT * FROM payments WHERE user_id=$1', [bu.id]);
    check(none2.length === 0, 'a fake receipt file is refused');
    r = await b1.form('/pass', '/pass/transfer', { amount: (min + 1000).toLocaleString('en-NG'), sender_name: 'Bank Reader Ltd', paid_on: today, message: 'Sent from GTB' }, { field: 'proof', buf: png, type: 'image/png', name: 'receipt.png' });
    const { rows: [bp] } = await db.query('SELECT * FROM payments WHERE user_id=$1', [bu.id]);
    const { rows: [bu2] } = await db.query('SELECT has_pass FROM users WHERE id=$1', [bu.id]);
    check(bp && bp.status === 'pending' && bp.method === 'bank' && bp.amount_kobo === (min + 1000) * 100 && bp.proof_id && !bu2.has_pass, 'reader reports a transfer with a receipt: recorded as pending, book still locked');
    r = await b1.req('/pass');
    check(r.text.includes('Waiting for confirmation'), 'reader sees their transfer is waiting for confirmation');
    r = await b1.req(`/admin/payments/${bp.id}/proof`);
    check(r.status === 403, 'readers cannot open receipts');
    const pr = await fetch(B + `/admin/payments/${bp.id}/proof`, { headers: { cookie: au.cookieHeader() } });
    check(pr.status === 200 && pr.headers.get('content-type') === 'image/png', 'author can open the receipt');
    r = await au.req('/admin/payments');
    check(r.text.includes('Bank Reader Ltd') && r.text.includes('Waiting for you'), 'the transfer appears in the author’s Donations queue');
    await au.post('/admin/payments', `/admin/payments/${bp.id}/confirm`, { amount: String(min + 1000) });
    const { rows: [bp2] } = await db.query('SELECT * FROM payments WHERE id=$1', [bp.id]);
    const { rows: [bu3] } = await db.query('SELECT has_pass, pass_source FROM users WHERE id=$1', [bu.id]);
    check(bp2.status === 'success' && bu3.has_pass && bu3.pass_source === 'transfer', 'author confirms the transfer and the book unlocks');
    r = await b1.req(`/chapters/${paid.slug}`);
    check(r.text.includes(`Hidden ending Paid ${RUN}`), 'the confirmed reader can read locked chapters');

    const b2 = agent();
    await b2.post('/signup', '/signup', { name: 'Fake Payer', email: `fake-${RUN}@example.test`, password: 'ReaderPass5' });
    await au.post('/admin/settings', '/admin/settings', { ...base, bank_name: 'Test Bank', bank_account_number: '0123456789', bank_account_name: 'Lincoln Matthew', bank_instant_unlock: 'yes' });
    r = await b2.form('/pass', '/pass/transfer', { amount: String(min), sender_name: 'Fake Payer', paid_on: today });
    const { rows: [fu] } = await db.query('SELECT * FROM users WHERE email=$1', [`fake-${RUN}@example.test`]);
    check(r.loc === '/chapters' && fu.has_pass, 'with “unlock straight away” on, the book opens as soon as the reader reports a transfer');
    const { rows: [fp] } = await db.query('SELECT * FROM payments WHERE user_id=$1', [fu.id]);
    await au.post('/admin/payments', `/admin/payments/${fp.id}/reject`, { note: 'No transfer found' });
    const { rows: [fu2] } = await db.query('SELECT has_pass FROM users WHERE id=$1', [fu.id]);
    const { rows: [fp2] } = await db.query('SELECT status, review_note FROM payments WHERE id=$1', [fp.id]);
    check(!fu2.has_pass && fp2.status === 'rejected' && fp2.review_note === 'No transfer found', 'marking a transfer “not received” removes the access it gave');
    r = await b2.req('/account');
    check(r.text.includes('No transfer found'), 'the reader sees why their transfer was not confirmed');
    r = await b2.form('/pass', '/pass/transfer', { amount: String(min), sender_name: 'Fake Payer', paid_on: day(5) });
    const { rows: fut } = await db.query("SELECT * FROM payments WHERE user_id=$1 AND status='pending'", [fu.id]);
    check(fut.length === 0, 'a transfer date in the future is refused');
    await au.post('/admin/settings', '/admin/settings', base);

    console.log('\nAuthor tools');
    await au.post('/admin/settings', '/admin/settings', { ...Object.fromEntries(savedSettings.map((s) => [s.key, s.value || ''])), donation_min_ngn: '1,500', amazon_url: 'javascript:alert(1)' });
    const { rows: [p1] } = await db.query("SELECT value FROM settings WHERE key='donation_min_ngn'");
    check(p1.value !== '1500', 'unsafe store links are refused');
    await au.post('/admin/settings', '/admin/settings', { ...Object.fromEntries(savedSettings.map((s) => [s.key, s.value || ''])), donation_min_ngn: '1,500', donation_suggested: '1500, 3000, 500, 10000' });
    const { rows: [p2] } = await db.query("SELECT value FROM settings WHERE key='donation_min_ngn'");
    const { rows: [p3] } = await db.query("SELECT value FROM settings WHERE key='donation_suggested'");
    check(p2.value === '1500' && p3.value === '1500,3000,10000', 'author sets the minimum and suggested amounts (below-minimum suggestions dropped)');
    r = await au.upload('/admin/settings', '/admin/settings/cover', 'cover', png);
    const cov = await fetch(B + '/cover');
    check(cov.headers.get('content-type') === 'image/png', 'author uploads a book cover');
    await anon.post('/', '/subscribe', { email: `=cmd-${RUN}@example.test` });
    r = await au.req('/admin/subscribers.csv');
    check(r.text.includes(`'=cmd-${RUN}@example.test`), 'subscriber CSV export is protected against spreadsheet formulas');
    for (const p of ['/admin', '/admin/chapters', `/admin/chapters/${paid.id}`, '/admin/reviews', '/admin/readers', '/admin/payments', '/admin/subscribers', '/admin/settings']) {
      r = await au.req(p); check(r.status === 200, `author page ${p} loads`);
    }
  } catch (e) {
    failed++;
    console.error('\nTest run crashed:', e);
    console.error(log.slice(-2000));
  } finally {
    await db.query("DELETE FROM images WHERE id IN (SELECT proof_id FROM payments WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))", [`%-${RUN}@example.test`]).catch(() => {});
    await db.query("DELETE FROM payments WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`%-${RUN}@example.test`]).catch(() => {});
    await db.query('DELETE FROM users WHERE email LIKE $1', [`%-${RUN}@example.test`]).catch(() => {});
    await db.query('DELETE FROM subscribers WHERE email LIKE $1', [`%-${RUN}@example.test`]).catch(() => {});
    await db.query('DELETE FROM chapters WHERE title LIKE $1', [`% ${RUN}`]).catch(() => {});
    for (const s of savedSettings) await db.query('UPDATE settings SET value=$2 WHERE key=$1', [s.key, s.value]).catch(() => {});
    await db.query("DELETE FROM images WHERE purpose='cover'").catch(() => {});
    for (const c of savedCover) await db.query('INSERT INTO images (purpose, mime, data, created_at) VALUES ($1,$2,$3,$4)', [c.purpose, c.mime, c.data, c.created_at]).catch(() => {});
    server.kill(); mock.close(); await db.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
