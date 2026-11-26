# Nobody Is the Problem: read-online site

The home of the book *Nobody Is the Problem* by Lincoln Matthew. Readers can read the book online, chapter by chapter. The whole manuscript is built in: Preface, Prologue, 24 chapters in five parts, Epilogue, figures, and each chapter's notes. The Preface, Prologue and Chapter One are free. A **donation of any amount** above a minimum you set, made by **bank transfer to your own account**, unlocks the rest.

## What it does

**For readers**
- Home page with the book, buy links (Amazon, Selar), the chapter series, featured reviews and email sign-up.
- **Free sections** to start reading straight away. Locked chapters show the epigraph and the opening paragraphs, then a donate prompt.
- **The full book text** with figures and captions, numbered note markers that link to each chapter's Notes, a reading-progress bar and reading times.
- **Bank-transfer donations**: the reader signs in and sees your bank, account number and account name with **their own reference** (e.g. NITP-0042) to use as the narration. They transfer, then fill in a short form (amount, date, sender name, optional receipt screenshot). You confirm it in the dashboard and the book unlocks on their account. If you prefer, you can set transfers to unlock immediately and check them afterwards.
- **Continue reading**: the home page takes signed-in readers back to the chapter they last opened.
- **Reviews**: star rating and text for each chapter. These appear after the author approves them.
- **My reflections**: a private journal for each chapter's questions.
- **Quote cards**: turn a chosen line into a 1080×1080 image to download or share on WhatsApp or Instagram.

**For the author (`/admin`)**
- Overview: revenue, readers, pass holders, average rating, email list, upcoming chapters, latest sales.
- Add chapters (paste the chapter text) and **schedule** them. Each goes live on its publish date automatically (Nigeria time; set `SITE_TIMEZONE` to change it). Release them all at once or one at a time.
- Approve, hide or feature reader reviews (featured ones show on the home page).
- Readers: give free access (e.g. to reviewers), or reset a forgotten password.
- **Donations**: a queue of transfers to check against your bank app, with the receipt, sender name, amount and date. **Confirm** unlocks the book; **Not received** records a reason the reader can see and removes any access it gave. Then the full donation history, subscriber list with CSV download, and site settings (minimum and suggested amounts, links, blurb, bio, cover upload).

---

## Deploy on Replit

1. **Get the code in.** Use **Create App → Import from GitHub**, or upload this folder.
2. **Add a database.** Go to **Tools → Database → Create a database**. This sets `DATABASE_URL` for you.
3. **Add Secrets** under **Tools → Secrets**:

   | Key | Value |
   |---|---|
   | `SESSION_SECRET` | A long random string. Make one in the Shell with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `AUTHOR_EMAIL` | The email you'll sign in with |
   | `AUTHOR_PASSWORD` | *(optional)* Your password, 10+ characters. If you leave it out, a one-time password is printed in the Console on first start. |

4. **Run** to test, then **Deploy → Autoscale**.
5. Sign in at `/login`, then go to **Dashboard → Settings → Donation account** and paste your **bank name, account number and account name**. Until you do, the donate page says donations open soon. Choose whether transfers unlock **after you confirm** (the default) or **straight away**.
6. Set your web address in the marketing kit and start posting (see the kit's README).

The book is loaded automatically from `data/book.json` the first time the site starts with an empty database; the figures are in `public/book/`. Edit any chapter afterwards under **Dashboard → Chapters**.

### Card payments (optional)
Paystack code is still included but **switched off**. The site only offers bank transfer unless you add a `PAYSTACK_SECRET_KEY` secret (and set the webhook to `https://YOUR-SITE/pay/webhook`).

## Updating the book
- **Dashboard → Chapters** lists every section. Edit the text (markdown), the epigraph (teaser), the free/locked setting, the reflection questions and the shareable quotes.
- To re-import a revised manuscript, regenerate `data/book.json`, empty the chapters table and restart. Note that this also removes reviews and reflections.

## Run the automated checks
In the Replit Shell, run `npm test`. It runs 57 checks covering access rules, the imported manuscript, reviews, the journal, bank-transfer donations (reporting, receipts, confirm and reject, instant unlock), optional Paystack against a simulator, and author tools. It cleans up after itself.
