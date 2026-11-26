// Loads the manuscript (data/book.json) into an empty chapters table on first start,
// and fills the book's blurb and author bio if they are still the defaults.
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function seedBook() {
  const file = path.join(__dirname, '..', 'data', 'book.json');
  if (!fs.existsSync(file)) return;
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM chapters');
  const book = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (n === 0) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const s of book.sections) {
        let md = s.markdown;
        // The epigraph is shown in the chapter header, so drop it from the body
        if (s.epigraph) md = md.replace(/^> .*\n*/m, (line) => (line.includes(s.epigraph.slice(0, 40)) ? '' : line));
        await c.query(
          `INSERT INTO chapters (number, slug, title, label, part, teaser, commentary, excerpt, questions, quotes, notes, is_free, publish_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE - 1)`,
          [s.number, s.slug, s.title, s.label, s.part, s.teaser || null, md.trim(), s.opening || null,
            (s.questions || []).join('\n') || null, (s.quotes || []).join('\n') || null,
            Object.keys(s.notes || {}).length ? JSON.stringify(s.notes) : null, !!s.is_free]);
      }
      await c.query('COMMIT');
      console.log(`Loaded ${book.sections.length} sections of the book.`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.query(`UPDATE settings SET value=$1 WHERE key='blurb' AND value LIKE 'Read Nobody Is the Problem here, one chapter at a time.%'`, [book.blurb]);
  await pool.query(`UPDATE settings SET value=$1 WHERE key='author_bio' AND COALESCE(value,'')=''`, [book.about]);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('subtitle', $1) ON CONFLICT (key) DO NOTHING`, [book.subtitle]);
}

module.exports = { seedBook };
