// Loads the manuscript (data/book.json) into the chapters table.
// - First start (empty table): every section is inserted.
// - Later starts: if data/book.json has changed since it was last loaded, the text of each
//   section is refreshed in place (matched by slug), so readers' reviews, reflections and
//   reading progress are kept. Free/locked settings and publish dates you changed in the
//   dashboard are left alone. Set BOOK_AUTO_UPDATE=off to stop this.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

function bodyOf(s) {
  let md = s.markdown;
  // The epigraph is shown in the chapter header, so drop it from the body
  if (s.epigraph) md = md.replace(/^> .*\n*/m, (line) => (line.includes(s.epigraph.slice(0, 40)) ? '' : line));
  return md.trim();
}
const fields = (s) => [s.title, s.label, s.part, s.teaser || null, bodyOf(s), s.opening || null,
  (s.questions || []).join('\n') || null, (s.quotes || []).join('\n') || null,
  Object.keys(s.notes || {}).length ? JSON.stringify(s.notes) : null];

async function seedBook() {
  const file = path.join(__dirname, '..', 'data', 'book.json');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  const version = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  const book = JSON.parse(raw);
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM chapters');
  const { rows: [ver] } = await pool.query("SELECT value FROM settings WHERE key='book_version'");
  const refresh = n > 0 && (!ver || ver.value !== version) && process.env.BOOK_AUTO_UPDATE !== 'off';
  if (n === 0 || refresh) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let added = 0, updated = 0;
      for (const s of book.sections) {
        const { rows: [row] } = await c.query('SELECT id FROM chapters WHERE slug=$1', [s.slug]);
        if (row) {
          await c.query(`UPDATE chapters SET title=$1, label=$2, part=$3, teaser=$4, commentary=$5, excerpt=$6, questions=$7, quotes=$8, notes=$9, updated_at=NOW() WHERE id=$10`,
            [...fields(s), row.id]);
          updated++;
        } else {
          await c.query(
            `INSERT INTO chapters (title, label, part, teaser, commentary, excerpt, questions, quotes, notes, number, slug, is_free, publish_on)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE - 1)`,
            [...fields(s), s.number, s.slug, !!s.is_free]);
          added++;
        }
      }
      await c.query(`INSERT INTO settings (key, value) VALUES ('book_version', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [version]);
      await c.query('COMMIT');
      console.log(`Book text loaded: ${added} sections added, ${updated} updated.`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.query(`UPDATE settings SET value=$1 WHERE key='blurb' AND value LIKE 'Read Nobody Is the Problem here, one chapter at a time.%'`, [book.blurb]);
  await pool.query(`UPDATE settings SET value=$1 WHERE key='author_bio' AND (COALESCE(value,'')='' OR value LIKE 'Lincoln Matthew is the Programme Manager%')`, [book.about]);
  for (const [k, v] of [['subtitle', book.subtitle], ['dedication', book.dedication || ''], ['copyright_notice', book.copyright || '']]) {
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [k, v]);
  }
}

module.exports = { seedBook };
