// Lists every template so Vercel's bundler ships them with the function.
// Regenerate if you add a template: see README (Vercel).
const fs = require('fs');
const path = require('path');
let found = 0;
try {
  found = [
  fs.readFileSync(path.join(__dirname, '..', 'views', 'account.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'chapter-edit.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'chapters.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'dashboard.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'payments.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'readers.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'reviews.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'settings.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'subscribers.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'change-password.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'chapter.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'chapters.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'error.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'home.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'journal.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'login.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'chapter-list.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'flash.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'foot.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'head.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'stars.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'pass.ejs')).length,
  fs.readFileSync(path.join(__dirname, '..', 'views', 'signup.ejs')).length,
  ].length;
} catch (e) {
  console.error('Some page templates are missing from the deployment:', e.message);
}
module.exports = found;
