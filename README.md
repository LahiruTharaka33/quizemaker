# QuizLock

A quiz platform built for phones first, and it also works on desktop. Lecturers build a quiz and share a link or QR code. Students take it in a locked screen, and **if a student leaves the quiz, it freezes** until the lecturer unlocks it. The lecturer can let the student **continue** or make them **restart**, with or without shuffling.

## Run

```bash
npm install
npm start
```

- Lecturer dashboard: http://localhost:3000/lecturer
- When the server starts, it prints your network address (e.g. `http://192.168.1.20:3000`). Phones on the same Wi-Fi use this address. The join link and QR code use it automatically.
- Settings live in a **`.env`** file next to `server.js`, which the server loads automatically. Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored, so keep your secrets there and never in the code.

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (e.g. Neon). **Recommended.** Without it, data is saved to `data.json`. |
| `PORT` | Port to listen on (default 3000) |
| `DATA_FILE` | JSON file used when there's no `DATABASE_URL` (default `./data.json`) |
| `DB_TABLE` | Table name in Postgres (default `ql_records`) |
| `TRUST_PROXY` | Number of proxies in front of the app. Set automatically on Render/Vercel; set it yourself behind Nginx etc. |
| `INVITE_CODE` | If set, the code is needed to **create** a lecturer account, so random people can't sign up. Share it with your lecturers. |
| `APP_URL` | Public address of the site, e.g. `https://quiz.example.edu`. Used in reset-email links. **Set it in production.** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Mail server for password-reset emails (e.g. Gmail with an app password, Outlook, SendGrid, Brevo). Without `SMTP_HOST`, reset links are **printed in the server console** instead. |

Example: `INVITE_CODE=CS2026 npm start` (PowerShell: `$env:INVITE_CODE='CS2026'; npm start`).

Gmail example (needs 2-step verification and an [app password](https://myaccount.google.com/apppasswords)):
```bash
APP_URL=https://quiz.example.edu SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USER=you@gmail.com SMTP_PASS="app password" SMTP_FROM="QuizLock <you@gmail.com>" npm start
```

## Deploy on Render (recommended)
QuizLock needs **one always-on server**: it keeps live quiz state in memory and holds open connections to every student. Serverless hosts like Vercel aren't a good fit, because they run several short-lived copies and pause them between requests. That breaks the live monitor, the timers and saving.

1. Push this repo to GitHub, which is already done.
2. In [Render](https://dashboard.render.com), choose **New → Blueprint**, pick the `quizemaker` repo, and Render reads `render.yaml`.
3. When asked for **`DATABASE_URL`**, paste your Neon connection string, then click **Apply**.
4. Open `https://<service-name>.onrender.com`. Join links and reset emails use this address automatically (`RENDER_EXTERNAL_URL`). For a custom domain, set `APP_URL`.
5. Optional, under **Environment**: `INVITE_CODE` and `SMTP_*`.

Notes:
- **Free plan:** the service sleeps after 15 minutes with no visitors, and the first visit afterwards takes about 30–60 s to wake it. A running quiz keeps it awake. For lectures, the **Starter** plan stays always on.
- Every push to `main` redeploys. While it restarts, students see "reconnecting…" for a moment. Their answers are already saved and the quiz picks up again.
- **Run only one server per database.** Don't run a second copy (such as Vercel, or a local `npm start`) against the same `DATABASE_URL`. For local testing, use a separate Neon branch.
- `GET /healthz` is the health check Render uses.

## Database (PostgreSQL / Neon)
- With `DATABASE_URL` set, everything is stored in one table, `ql_records (kind, id, data jsonb, updated_at)`. There is one row per quiz, student attempt, lecturer, login session and reset link. The server creates the table itself on first start.
- **One-time import:** if the table is empty and a `data.json` exists, the server imports it on first start. Here the old file was then renamed to `data.backup-before-postgres.json`.
- The server keeps the live state in memory, because quizzes update many times a second. About 0.3 s after each change it writes **only the rows that changed**, in one transaction.
  - If the database is briefly unreachable, it keeps retrying (up to every 30 s) and nothing is lost while the server is running.
  - On Ctrl+C or a normal stop, it saves pending changes before exiting.
- Run **one server instance** per database. Two servers sharing one database would overwrite each other's changes.
- Look at the data in Neon's SQL editor, e.g. `select data->>'title', data->>'status' from ql_records where kind = 'quizzes';`
- Backups: Neon keeps a restore history (point-in-time restore). You can also export a backup with `pg_dump`.

## Lecturer accounts
- Lecturers **create an account** (name, email, password of at least 8 characters) and **log in** at `/lecturer`, from any device. That includes a phone, so the live monitor works there too.
- Each lecturer sees and controls **only their own quizzes**. Other lecturers get "not found" for both the web pages and the live connection.
- Passwords are stored as salted scrypt hashes. The login session is an HttpOnly cookie that lasts 30 days. After 8 wrong passwords, login is blocked for 15 minutes.
- Students **don't** need accounts. They still join with just the link and their name and student ID.
- Quizzes created before accounts existed are moved into your account automatically the first time you log in from the same browser.

### Forgot / change password
- **Forgot password?** on the login page: enter your email to get a reset link.
  - The link works **once** and expires after **1 hour**. Asking again cancels the older link.
  - The server stores only a scrambled fingerprint (hash) of the link's secret code.
  - The reply is the same whether or not the email has an account, so nobody can use it to check who is registered. Each IP address can ask 8 times per 15 minutes.
  - Setting a new password **logs you out on every device**, and you're logged in on the one you used.
- No mail server set up? The link is printed in the server console, and the page says so. Whoever runs the server can pass it on.
- **Change password** (tap your initial in the top bar) needs your current password. It logs out your other devices but keeps you logged in on this one.

## How it works

**Lecturer**
1. **New quiz**: add a title, instructions and a time limit, then multiple-choice questions with points. Tap the circle to mark the correct answer.
2. Settings: shuffle questions, shuffle answers, lock to full screen, show score after submitting.
3. **Save** it. Saved quizzes stay under **My quizzes** for later use, and you can edit or duplicate them any time.
4. Whenever you want to run it (today, next week, for several groups), press **▶ Start**. Each start creates a **session** with:
   - its own join code, link and QR code
   - its own students and results (the same student ID can take a new session)
   - an optional name, e.g. "Group A"
   - a copy of the questions as they were at start, so later edits never change a running or past session

   **▶ Save & start** does both in one step.
5. The quiz page lists **Live now** and **Past sessions** with dates, student counts and average score. Tap one to open it.
6. The live monitor shows every student: writing / 🔒 frozen / submitted, progress, violations, timer and score. You get a toast, a beep and a vibration when someone freezes.
7. For a frozen student:
   - **Continue**: they resume where they left off, and their answers are kept.
   - **Restart / options**: continue or start from the beginning, with optional *shuffle questions* and *shuffle answers*.
8. ⋯ menu: activity log, force submit, remove a student (they can then rejoin).
9. **End session** auto-submits everyone still writing or frozen, and the quiz stays saved for next time. **Reopen** lets the same code work again. **Results CSV** exports that session's marks.
10. Log in on your phone to monitor and unlock students from there.

**Reviewing answers** (in any live or past session)
- **👥 Students:** tap a student (or **📝 Answers**) to see their sheet:
  - score, number correct, time taken and violations
  - every question with their answer next to the correct one, marked ✓ / ✗ / not answered
  - **‹ Prev / Next ›** (or the arrow keys) to go through the class
- **📊 Questions:** for each question:
  - how many answered correctly (count and %), and how many picked each option
  - **Who answered what** lists the names; tap a name to open that student's sheet
  - sort by quiz order or hardest first. By default only submitted students are counted; switch on *Include students still writing* for live answers.
- **Mark answers yourself:**
  - **✎ Correct answer** on a question changes the key for this session. You can tick several correct options, or **give everyone the points** for a faulty question. Everyone is re-scored instantly, and you can also fix the saved quiz for future sessions.
  - **✓ Mark correct / ✗ Mark wrong** on one student's answer overrides it for that student. It shows *Marked by lecturer*, and **↺ Automatic** undoes it.
  - Students who can see their score get the updated one live.
- In the builder you can mark **more than one correct answer** per question.
- **Results CSV** includes each student's answer and mark for every question.

Quizzes created before sessions existed are converted automatically on first start. Each quiz becomes a saved quiz, and its students and results move into a session with the same join code.

**Student**: open the link, enter a name and student ID, then tap start. The quiz goes full screen, shows one question per screen with big tap targets, and has a question strip and a timer.

## What triggers a freeze

| Action | Detected by |
|---|---|
| Switching apps, home button, notification shade, switching tabs | `visibilitychange` |
| Clicking another window (desktop) | `blur` + `hasFocus()` |
| Exiting full screen (Android / desktop) | `fullscreenchange` |
| Closing or reloading the page, or reopening the link later | `pagehide` beacon, plus a "fresh page load while active" check on the server |
| PrintScreen key (desktop) | `keyup` |

The freeze appears on screen immediately. It is also reported over the socket **and** via `navigator.sendBeacon`, so it still reaches the server when the phone suspends the page. The state lives on the server, so reloading or rejoining with the same student ID can't get around it. Copy, paste, right-click, text selection and the back button are blocked during the quiz. Correct answers are never sent to students.

### Honest limits of a web app
A website **cannot stop** a phone from opening another app. It can only **detect** that the student left, and freeze the quiz. Things a browser can't see:
- A second device, or a screenshot taken with the phone's hardware buttons.
- iPhone Safari doesn't support full-screen mode, so on iPhone the lock relies on app-switch detection (which works).
- Some floating windows / split-screen on Android may not trigger an event.

To *prevent* (not just detect) leaving, you would need native apps: Android "screen pinning" / Lock Task mode, or iOS Guided Access / Assessment Mode. These could wrap this same server later.

## Project layout
```
server.js              Express + Socket.IO server, accounts, freeze logic
storage.js             Persistence: PostgreSQL (changed rows only) or data.json
.env.example           Settings template (copy to .env)
public/index.html      Landing page (join by code / lecturer)
public/lecturer.html   Lecturer app (list, builder, live monitor)
public/student.html    Student quiz app
public/js/*.js         Front-end logic
public/css/style.css   Shared mobile-first styles (light/dark)
```

## Before real use
- Set `INVITE_CODE` so only your staff can create lecturer accounts.
- Configure SMTP and `APP_URL` so password-reset emails actually go out.
- Use `DATABASE_URL` (Postgres) rather than `data.json`. If you stay on the file, back it up regularly. If the file is ever unreadable, the server refuses to start rather than overwrite it.
- On your hosting platform, set `DATABASE_URL` and the other settings as **environment variables**, not in a committed file.
- Run behind HTTPS (e.g. Nginx/Caddy, or a host like Render/Railway). Some full-screen and vibration features work best over HTTPS.
