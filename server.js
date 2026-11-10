// QuizLock — locked-down quiz platform server
// Express (REST + static files) + Socket.IO (live freeze / unfreeze). Storage: PostgreSQL or data.json (see storage.js).

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // optional .env with DATABASE_URL, SMTP_*, …
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { openStorage } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------------------------------------------------------------- storage
// Filled in by main() before the server starts accepting requests.
// db = { quizzes, attempts, users, sessions, resets }
let db = null;
let storage = null;
const save = () => storage.save();
const INVITE_CODE = process.env.INVITE_CODE || ''; // if set, required to create a lecturer account

// ---------------------------------------------------------------- helpers
const id = (n = 12) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (Object.values(db.runs).some((r) => r.code === code));
  return code;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const clean = (s, max = 2000) => String(s ?? '').trim().slice(0, max);

function sanitizeQuiz(input) {
  const settings = input.settings || {};
  const questions = (Array.isArray(input.questions) ? input.questions : [])
    .map((q) => {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => ({ id: clean(o.id, 40) || id(6), text: clean(o.text, 500) }))
        .filter((o) => o.text);
      // One or more correct options (older data has only `correct`)
      const valid = new Set(options.map((o) => o.id));
      let correctIds = (Array.isArray(q.correctIds) ? q.correctIds : [q.correct]).filter((cid) => valid.has(cid));
      correctIds = [...new Set(correctIds)];
      if (!correctIds.length && options[0]) correctIds = [options[0].id];
      return {
        id: clean(q.id, 40) || id(6),
        text: clean(q.text, 2000),
        points: Math.max(0, Math.min(100, Number(q.points) || 1)),
        options,
        correct: correctIds[0],
        correctIds,
        freePoints: !!q.freePoints, // question voided: everyone gets the points
      };
    })
    .filter((q) => q.text && q.options.length >= 2);
  return {
    title: clean(input.title, 200) || 'Untitled quiz',
    description: clean(input.description, 2000),
    timeLimitMin: Math.max(0, Math.min(600, Number(input.timeLimitMin) || 0)),
    settings: {
      shuffleQuestions: !!settings.shuffleQuestions,
      shuffleOptions: !!settings.shuffleOptions,
      showScore: settings.showScore !== false,
      requireFullscreen: settings.requireFullscreen !== false,
    },
    questions,
  };
}

const attemptsOf = (runId) => Object.values(db.attempts).filter((a) => a.runId === runId);

function buildOrder(quiz, shuffleQ, shuffleO) {
  const qs = shuffleQ ? shuffle(quiz.questions) : quiz.questions;
  const optionOrder = {};
  for (const q of quiz.questions) {
    const ids = q.options.map((o) => o.id);
    optionOrder[q.id] = shuffleO ? shuffle(ids) : ids;
  }
  return { order: qs.map((q) => q.id), optionOrder };
}

function elapsed(a) {
  return a.elapsedMs + (a.status === 'active' && a.activeSince ? now() - a.activeSince : 0);
}
function remaining(a, quiz) {
  if (!quiz.timeLimitMin) return null;
  return Math.max(0, quiz.timeLimitMin * 60000 - elapsed(a));
}

const correctSet = (q) => (Array.isArray(q.correctIds) && q.correctIds.length ? q.correctIds : [q.correct]);

// How one question is marked for one student.
// source: 'free' (question voided), 'override' (lecturer marked it), 'key' (answer key), 'blank'
function markQuestion(q, a) {
  const chosen = a.answers[q.id] || null;
  const ov = a.overrides ? a.overrides[q.id] : undefined;
  let correct;
  let source;
  if (q.freePoints) { correct = true; source = 'free'; }
  else if (ov === true || ov === false) { correct = ov; source = 'override'; }
  else if (!chosen) { correct = false; source = 'blank'; }
  else { correct = correctSet(q).includes(chosen); source = 'key'; }
  return { chosen, correct, earned: correct ? q.points : 0, source };
}

function grade(a, quiz) {
  let score = 0;
  let max = 0;
  for (const q of quiz.questions) {
    max += q.points;
    score += markQuestion(q, a).earned;
  }
  a.score = score;
  a.maxScore = max;
}

// Re-score everyone who has finished (after the key changed or a mark was overridden)
function regrade(run, onlyAttempt) {
  let n = 0;
  for (const a of onlyAttempt ? [onlyAttempt] : attemptsOf(run.id)) {
    if (a.status !== 'submitted') continue;
    const before = a.score;
    grade(a, run);
    push(a); // lecturer monitor + student's own result screen update live
    if (a.score !== before) n++;
  }
  save();
  return n;
}

// What the student is allowed to see (never the correct answers).
function studentView(a) {
  const quiz = db.runs[a.runId];
  if (!quiz) return { status: 'gone' };
  const view = {
    status: a.status,
    name: a.name,
    quizTitle: quiz.title,
    quizStatus: quiz.status,
    paused: quiz.status === 'paused',
    attemptNo: a.attemptNo,
    freezeReason: a.freezeReason,
    requireFullscreen: quiz.settings.requireFullscreen,
    remainingMs: remaining(a, quiz),
    total: quiz.questions.length,
    answeredCount: Object.keys(a.answers).length,
  };
  if (a.status === 'active' && quiz.status !== 'paused') {
    const byId = Object.fromEntries(quiz.questions.map((q) => [q.id, q]));
    view.questions = a.order
      .filter((qid) => byId[qid])
      .map((qid) => {
        const q = byId[qid];
        const optById = Object.fromEntries(q.options.map((o) => [o.id, o]));
        return {
          id: q.id,
          text: q.text,
          points: q.points,
          options: (a.optionOrder[qid] || q.options.map((o) => o.id)).filter((oid) => optById[oid]).map((oid) => optById[oid]),
        };
      });
    view.answers = a.answers;
    view.current = a.current || 0;
  }
  if (a.status === 'submitted' && quiz.settings.showScore) {
    view.score = a.score;
    view.maxScore = a.maxScore;
  }
  return view;
}

// What the lecturer sees for each student.
function hostView(a) {
  const quiz = db.runs[a.runId];
  return {
    id: a.id,
    name: a.name,
    studentId: a.studentId,
    status: a.status,
    attemptNo: a.attemptNo,
    answered: Object.keys(a.answers).length,
    total: quiz ? quiz.questions.length : 0,
    violations: a.violations,
    freezeReason: a.freezeReason,
    frozenAt: a.frozenAt,
    online: !!a.online,
    score: a.score,
    maxScore: a.maxScore,
    startedAt: a.startedAt,
    submittedAt: a.submittedAt,
    remainingMs: quiz ? remaining(a, quiz) : null,
  };
}

// ---------------------------------------------------------------- state changes
function push(a) {
  io.to('attempt:' + a.id).emit('state', studentView(a));
  io.to('host:' + a.runId).emit('attempt', hostView(a));
  save();
}

function freeze(a, type, detail) {
  if (a.status !== 'active') return;
  if (db.runs[a.runId]?.status === 'paused') return;
  a.elapsedMs = elapsed(a);
  a.activeSince = null;
  a.status = 'frozen';
  a.freezeReason = type;
  a.frozenAt = now();
  a.violations.push({ type, detail: clean(detail, 200), at: now() });
  push(a);
  io.to('host:' + a.runId).emit('alert', { name: a.name, reason: type });
}

function submit(a, how = 'student') {
  if (a.status === 'submitted') return;
  const quiz = db.runs[a.runId];
  a.elapsedMs = elapsed(a);
  a.activeSince = null;
  a.status = 'submitted';
  a.submittedAt = now();
  a.submittedBy = how;
  grade(a, quiz);
  push(a);
}

function unfreeze(a, mode, opts = {}) {
  if (a.status !== 'frozen') return;
  const quiz = db.runs[a.runId];
  if (mode === 'restart') {
    const { order, optionOrder } = buildOrder(quiz, !!opts.shuffleQuestions, !!opts.shuffleOptions);
    a.order = order;
    a.optionOrder = optionOrder;
    a.answers = {};
    a.current = 0;
    a.elapsedMs = 0;
    a.attemptNo += 1;
  } else if (opts.shuffleQuestions || opts.shuffleOptions) {
    // Resume but reshuffle what's still unanswered.
    if (opts.shuffleQuestions) {
      const answered = a.order.filter((q) => a.answers[q]);
      const open = shuffle(a.order.filter((q) => !a.answers[q]));
      a.order = [...answered, ...open];
      a.current = answered.length < a.order.length ? answered.length : 0;
    }
    if (opts.shuffleOptions) {
      for (const qid of a.order) if (!a.answers[qid]) a.optionOrder[qid] = shuffle(a.optionOrder[qid] || []);
    }
  }
  a.status = 'active';
  a.activeSince = quiz.status === 'open' ? now() : null; // stays stopped while the session is paused
  a.freezeReason = null;
  a.frozenAt = null;
  a.violations.push({ type: mode === 'restart' ? 'Restarted by lecturer' : 'Resumed by lecturer', at: now(), system: true });
  push(a);
}

// ---------------------------------------------------------------- app
const app = express();
// Behind a hosting proxy (Render, Vercel, Nginx…) use the client address it forwards, so rate limits
// and Secure cookies work. Override with TRUST_PROXY (e.g. 2 for two proxies, false to disable).
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', tp != null ? (/^\d+$/.test(tp) ? Number(tp) : tp === 'true') : !!(process.env.RENDER || process.env.VERCEL) && 1);
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '10kb' })); // sendBeacon payloads
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------- lecturer accounts
const SESSION_COOKIE = 'ql_session';
const SESSION_DAYS = 30;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function userFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expires < now()) { delete db.sessions[token]; save(); return null; }
  return db.users[s.userId] || null;
}
function startSession(req, res, user) {
  const token = id(32);
  db.sessions[token] = { userId: user.id, expires: now() + SESSION_DAYS * 864e5 };
  save();
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
const normEmail = (e) => clean(e, 200).toLowerCase();

// Basic brute-force protection: max 8 failed logins per IP+email per 15 minutes
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  if (f && f.until > now() && f.count >= 8) return true;
  if (f && f.until <= now()) failures.delete(key);
  return false;
}
function noteFailure(key) {
  const f = failures.get(key) || { count: 0, until: now() + 15 * 60000 };
  f.count += 1;
  failures.set(key, f);
}

// ---------------------------------------------------------------- password reset
// Email via SMTP when configured; otherwise the reset link is printed in the server console.
// Public address used in join links and reset emails. On Vercel, falls back to the production domain
// (so links never point at a preview/branch URL like project-git-main-….vercel.app).
const APP_URL = (process.env.APP_URL
  || process.env.RENDER_EXTERNAL_URL // set automatically by Render, e.g. https://quizemaker.onrender.com
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')
).replace(/\/+$/, '');
const SMTP = process.env.SMTP_HOST ? {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
} : null;
const mailer = SMTP ? require('nodemailer').createTransport(SMTP) : null;
const RESET_MINUTES = 60;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function setPassword(user, password) {
  Object.assign(user, hashPassword(password));
  user.passwordChangedAt = now();
}
function endSessions(userId, exceptToken) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === userId && t !== exceptToken) delete db.sessions[t];
}
function findReset(token) {
  const r = db.resets[sha(token)];
  if (!r) return null;
  if (r.expires < now() || !db.users[r.userId]) { delete db.resets[sha(token)]; save(); return null; }
  return r;
}

async function sendResetEmail(user, link) {
  const text = `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your QuizLock lecturer password.\n\nOpen this link to choose a new password (valid for ${RESET_MINUTES} minutes, works once):\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.`;
  if (!mailer) {
    console.log(`\n[password reset] Email is not configured. Reset link for ${user.email}:\n  ${link}\n`);
    return;
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'Reset your QuizLock password',
    text,
  });
}

app.post('/api/auth/forgot', async (req, res) => {
  const email = normEmail(req.body?.email);
  const key = 'forgot|' + req.ip + '|' + email;
  if (tooManyFailures(key)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  noteFailure(key); // counts every request: max 8 per IP and email per 15 minutes
  const user = Object.values(db.users).find((u) => u.email === email);
  if (user) {
    for (const [h, r] of Object.entries(db.resets)) if (r.userId === user.id) delete db.resets[h]; // only the newest link works
    const token = id(32);
    db.resets[sha(token)] = { userId: user.id, expires: now() + RESET_MINUTES * 60000 };
    save();
    const base = APP_URL || `${req.protocol}://${req.get('host')}`;
    try {
      await sendResetEmail(user, `${base}/lecturer#/reset/${token}`);
    } catch (e) {
      console.error('Could not send reset email:', e.message);
    }
  }
  // Same answer whether or not the account exists, so emails can't be probed.
  res.json({ ok: true });
});

app.get('/api/auth/reset/:token', (req, res) => {
  const r = findReset(req.params.token);
  if (!r) return res.status(404).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
  res.json({ email: db.users[r.userId].email });
});

app.post('/api/auth/reset', (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  const r = findReset(token);
  if (!r) return res.status(404).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const user = db.users[r.userId];
  setPassword(user, password);
  delete db.resets[sha(token)]; // single use
  endSessions(user.id);         // log out every device
  // lift the wrong-password login lockout (keys "ip|email"), but keep the reset-request limit
  for (const k of failures.keys()) if (k.endsWith('|' + user.email) && !k.startsWith('forgot|')) failures.delete(k);
  startSession(req, res, user);
  res.json(publicUser(user));
});

app.post('/api/auth/change-password', (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  const key = 'change|' + user.id;
  if (tooManyFailures(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!checkPassword(String(req.body?.current || ''), user)) {
    noteFailure(key);
    return res.status(400).json({ error: 'Your current password is wrong.' });
  }
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  setPassword(user, password);
  endSessions(user.id, parseCookies(req.headers.cookie)[SESSION_COOKIE]); // other devices are logged out
  save();
  res.json({ ok: true });
});

app.get('/api/auth/config', (req, res) => res.json({ inviteRequired: !!INVITE_CODE, emailConfigured: !!mailer }));

app.get('/api/auth/me', (req, res) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(publicUser(user));
});

app.post('/api/auth/register', (req, res) => {
  const name = clean(req.body?.name, 80);
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (INVITE_CODE && req.body?.inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'Invalid invite code. Ask your administrator for it.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (Object.values(db.users).some((u) => u.email === email)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const user = { id: id(9), name, email, ...hashPassword(password), createdAt: now() };
  db.users[user.id] = user;
  startSession(req, res, user);
  res.json(publicUser(user));
});

app.post('/api/auth/login', (req, res) => {
  const email = normEmail(req.body?.email);
  const key = req.ip + '|' + email;
  if (tooManyFailures(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const user = Object.values(db.users).find((u) => u.email === email);
  if (!user || !checkPassword(String(req.body?.password || ''), user)) {
    noteFailure(key);
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  failures.delete(key);
  startSession(req, res, user);
  res.json(publicUser(user));
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) { delete db.sessions[token]; save(); }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

function requireUser(req, res, next) {
  req.user = userFromCookie(req.headers.cookie);
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function hostAuth(req, res, next) {
  requireUser(req, res, () => {
    const quiz = db.quizzes[req.params.id];
    if (!quiz || quiz.ownerId !== req.user.id) return res.status(404).json({ error: 'Quiz not found' });
    req.quiz = quiz;
    next();
  });
}
function runAuth(req, res, next) {
  requireUser(req, res, () => {
    const run = db.runs[req.params.id];
    if (!run || run.ownerId !== req.user.id) return res.status(404).json({ error: 'Session not found' });
    req.run = run;
    next();
  });
}
const runsOf = (quizId) => Object.values(db.runs).filter((r) => r.quizId === quizId);
function runSummary(r) {
  const atts = attemptsOf(r.id);
  const done = atts.filter((a) => a.status === 'submitted' && a.maxScore);
  return {
    id: r.id, code: r.code, label: r.label, status: r.status, startedAt: r.startedAt, closedAt: r.closedAt,
    studentCount: atts.length, submittedCount: done.length,
    avgPct: done.length ? Math.round((done.reduce((s, a) => s + a.score / a.maxScore, 0) / done.length) * 100) : null,
  };
}
function notifyRun(run) {
  io.to('lobby:' + run.code).emit('quizStatus', run.status);
  io.to('host:' + run.id).emit('runStatus', run.status); // other lecturer devices stay in sync
  // one update per student and per lecturer card for every state change
  for (const a of attemptsOf(run.id)) {
    io.to('attempt:' + a.id).emit('state', studentView(a));
    io.to('host:' + run.id).emit('attempt', hostView(a));
  }
  save();
}
// Lecturer presses Start: everyone in the waiting room begins at the same moment
function startRun(run) {
  if (run.status !== 'waiting') return;
  run.status = 'open';
  run.quizStartedAt = now();
  for (const a of attemptsOf(run.id)) {
    if (a.status !== 'waiting') continue;
    a.status = 'active';
    a.startedAt = now();
    a.activeSince = now();
  }
  notifyRun(run);
}
// Pause: clocks stop, questions are hidden, leaving the app is not a violation
function pauseRun(run) {
  if (run.status !== 'open') return;
  for (const a of attemptsOf(run.id)) {
    if (a.status === 'active') { a.elapsedMs = elapsed(a); a.activeSince = null; }
  }
  run.status = 'paused';
  run.pausedAt = now();
  notifyRun(run);
}
function resumeRun(run) {
  if (run.status !== 'paused') return;
  run.status = 'open';
  run.pausedMs = (run.pausedMs || 0) + (now() - (run.pausedAt || now()));
  run.pausedAt = null;
  for (const a of attemptsOf(run.id)) if (a.status === 'active') a.activeSince = now();
  notifyRun(run);
}
const lobbyCount = (run) => io.to('lobby:' + run.code).emit('count', attemptsOf(run.id).length);

function closeRun(run) {
  if (run.status === 'closed') return;
  // (paused clocks are already stopped, so ending a paused session needs no resume first)
  run.status = 'closed';
  run.closedAt = now();
  run.pausedAt = null;
  for (const a of attemptsOf(run.id)) if (a.status !== 'submitted') submit(a, 'closed');
  notifyRun(run);
}

// ---- Saved quizzes (reusable; editing never affects sessions already started)
app.get('/api/quizzes', requireUser, (req, res) => {
  const list = Object.values(db.quizzes)
    .filter((q) => q.ownerId === req.user.id)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .map((q) => {
      const runs = runsOf(q.id);
      return {
        id: q.id, title: q.title, questionCount: q.questions.length, timeLimitMin: q.timeLimitMin,
        createdAt: q.createdAt, updatedAt: q.updatedAt || q.createdAt,
        runCount: runs.length,
        lastRunAt: runs.reduce((m, r) => Math.max(m, r.startedAt), 0) || null,
        live: runs.filter((r) => r.status !== 'closed').map((r) => ({ id: r.id, code: r.code, label: r.label })),
      };
    });
  res.json(list);
});

app.post('/api/quizzes', requireUser, (req, res) => {
  const quiz = { id: id(9), ownerId: req.user.id, createdAt: now(), updatedAt: now(), ...sanitizeQuiz(req.body || {}) };
  db.quizzes[quiz.id] = quiz;
  save();
  res.json({ id: quiz.id });
});

// Quizzes made before accounts existed: claim them with the old per-quiz key kept in the browser
app.post('/api/quizzes/claim', requireUser, (req, res) => {
  let claimed = 0;
  for (const { id: qid, key } of Array.isArray(req.body?.items) ? req.body.items : []) {
    const q = db.quizzes[qid];
    if (q && !q.ownerId && q.hostKey && key === q.hostKey) {
      q.ownerId = req.user.id;
      delete q.hostKey;
      for (const r of runsOf(q.id)) r.ownerId = req.user.id;
      claimed++;
    }
  }
  if (claimed) save();
  res.json({ claimed });
});

app.get('/api/quizzes/:id', hostAuth, (req, res) => {
  const runs = runsOf(req.quiz.id).sort((a, b) => b.startedAt - a.startedAt).map(runSummary);
  res.json({ ...req.quiz, runs });
});

app.put('/api/quizzes/:id', hostAuth, (req, res) => {
  Object.assign(req.quiz, sanitizeQuiz(req.body || {}), { updatedAt: now() });
  save();
  res.json({ ok: true });
});

app.post('/api/quizzes/:id/duplicate', hostAuth, (req, res) => {
  const src = req.quiz;
  const copy = { id: id(9), ownerId: req.user.id, createdAt: now(), updatedAt: now(), ...sanitizeQuiz({ ...src, title: src.title + ' (copy)' }) };
  db.quizzes[copy.id] = copy;
  save();
  res.json({ id: copy.id });
});

// Permanently remove a session and its results; students still in it are sent out (not "submitted").
function deleteRun(run) {
  for (const a of attemptsOf(run.id)) {
    io.to('attempt:' + a.id).emit('state', { status: 'removed' });
    delete db.attempts[a.id];
  }
  io.to('lobby:' + run.code).emit('quizStatus', 'closed');
  io.to('host:' + run.id).emit('runDeleted');
  delete db.runs[run.id];
}

app.delete('/api/quizzes/:id', hostAuth, (req, res) => {
  for (const r of runsOf(req.quiz.id)) deleteRun(r);
  delete db.quizzes[req.quiz.id];
  save();
  res.json({ ok: true });
});

// ---- Sessions: "Start" a saved quiz -> new join code, its own students and results
app.post('/api/quizzes/:id/runs', hostAuth, (req, res) => {
  const q = req.quiz;
  if (!q.questions.length) return res.status(400).json({ error: 'Add at least one question before starting.' });
  const { title, description, timeLimitMin, settings, questions } = q;
  const run = {
    id: id(9), quizId: q.id, ownerId: req.user.id, code: makeCode(), status: 'waiting',
    label: clean(req.body?.label, 80), startedAt: now(), closedAt: null,
    // snapshot, so later edits to the saved quiz don't change this session
    ...structuredClone({ title, description, timeLimitMin, settings, questions }),
  };
  db.runs[run.id] = run;
  save();
  res.json({ id: run.id, code: run.code });
});

app.get('/api/runs/:id', runAuth, (req, res) => {
  const quiz = db.quizzes[req.run.quizId];
  res.json({ ...req.run, ...runSummary(req.run), quizTitle: quiz ? quiz.title : req.run.title });
});

app.post('/api/runs/:id/status', runAuth, (req, res) => {
  const run = req.run;
  const want = req.body?.status;
  if (want === 'open') {
    if (run.status === 'waiting') startRun(run);
    else if (run.status === 'paused') resumeRun(run);
    else if (run.status === 'closed') { run.status = 'waiting'; run.closedAt = null; notifyRun(run); } // reopen -> lobby
  } else if (want === 'paused') {
    if (run.status !== 'open') return res.status(409).json({ error: 'Only a running quiz can be paused.' });
    pauseRun(run);
  } else if (want === 'closed') closeRun(run);
  else if (want === 'waiting') {
    if (run.status !== 'closed') return res.status(409).json({ error: 'Only an ended session can be reopened.' });
    run.status = 'waiting'; run.closedAt = null; notifyRun(run);
  } else return res.status(400).json({ error: 'Bad status' });
  res.json({ ok: true, status: run.status });
});

app.delete('/api/runs/:id', runAuth, (req, res) => {
  deleteRun(req.run);
  save();
  res.json({ ok: true });
});

app.get('/api/runs/:id/results.csv', runAuth, (req, res) => {
  const r = req.run;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const letter = (q, oid) => {
    const i = q.options.findIndex((o) => o.id === oid);
    return i < 0 ? '' : String.fromCharCode(65 + i) + '. ' + q.options[i].text;
  };
  const head = ['Name', 'Student ID', 'Status', 'Score', 'Max', 'Answered', 'Attempt #', 'Violations', 'Started', 'Submitted'];
  r.questions.forEach((q, i) => head.push(`Q${i + 1} answer`, `Q${i + 1} mark`));
  const rows = [head];
  for (const a of attemptsOf(r.id)) {
    if (a.status === 'submitted') grade(a, r);
    const row = [
      a.name, a.studentId, a.status, a.score ?? '', a.maxScore ?? '', Object.keys(a.answers).length, a.attemptNo,
      a.violations.filter((v) => !v.system).map((v) => v.type).join('; '),
      a.startedAt ? new Date(a.startedAt).toISOString() : '', a.submittedAt ? new Date(a.submittedAt).toISOString() : '',
    ];
    for (const q of r.questions) {
      const m = markQuestion(q, a);
      const tag = m.source === 'override' ? ' (lecturer)' : m.source === 'free' ? ' (free)' : '';
      row.push(m.chosen ? letter(q, m.chosen) : '', (m.correct ? 'correct' : m.chosen ? 'wrong' : 'blank') + tag);
    }
    rows.push(row);
  }
  const day = new Date(r.startedAt).toISOString().slice(0, 10);
  const fname = ((r.title + (r.label ? '_' + r.label : '')).replace(/[^\w-]+/g, '_').slice(0, 60) || 'quiz') + '_' + day;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}_results.csv"`);
  res.send('﻿' + rows.map((row) => row.map(esc).join(',')).join('\r\n'));
});

// ---- Answers review (lecturer only): every student's answers, marked per question
app.get('/api/runs/:id/answers', runAuth, (req, res) => {
  const r = req.run;
  res.json({
    questions: r.questions.map((q) => ({
      id: q.id, text: q.text, points: q.points, options: q.options, correctIds: correctSet(q), freePoints: !!q.freePoints,
    })),
    attempts: attemptsOf(r.id).map((a) => {
      if (a.status === 'submitted') grade(a, r);
      const marks = {};
      let earned = 0;
      let max = 0;
      for (const q of r.questions) { const m = markQuestion(q, a); marks[q.id] = m; earned += m.earned; max += q.points; }
      return {
        id: a.id, name: a.name, studentId: a.studentId, status: a.status, attemptNo: a.attemptNo,
        score: earned, maxScore: max, // live "so far" score for students still writing
        marks, startedAt: a.startedAt, submittedAt: a.submittedAt, elapsedMs: elapsed(a),
        violations: a.violations.filter((v) => !v.system).map((v) => ({ type: v.type, at: v.at })),
      };
    }),
  });
});

// Change a question's answer key for this session (and optionally the saved quiz), then re-score
app.put('/api/runs/:id/questions/:qid/key', runAuth, (req, res) => {
  const r = req.run;
  const q = r.questions.find((x) => x.id === req.params.qid);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const valid = new Set(q.options.map((o) => o.id));
  const correctIds = [...new Set((Array.isArray(req.body?.correctIds) ? req.body.correctIds : []).filter((x) => valid.has(x)))];
  const freePoints = !!req.body?.freePoints;
  if (!correctIds.length && !freePoints) return res.status(400).json({ error: 'Pick at least one correct answer.' });
  if (correctIds.length) { q.correctIds = correctIds; q.correct = correctIds[0]; }
  q.freePoints = freePoints;
  let quizUpdated = false;
  if (req.body?.applyToQuiz) {
    const saved = db.quizzes[r.quizId];
    const sq = saved && saved.questions.find((x) => x.id === q.id);
    if (sq) {
      if (correctIds.length) { sq.correctIds = [...correctIds]; sq.correct = correctIds[0]; }
      sq.freePoints = freePoints;
      saved.updatedAt = now();
      quizUpdated = true;
    }
  }
  const changed = regrade(r);
  res.json({ ok: true, rescored: changed, quizUpdated });
});

// Lecturer marks one student's answer right/wrong by hand (value null = back to automatic)
app.put('/api/runs/:id/attempts/:aid/override', runAuth, (req, res) => {
  const a = db.attempts[req.params.aid];
  if (!a || a.runId !== req.run.id) return res.status(404).json({ error: 'Student not found' });
  const q = req.run.questions.find((x) => x.id === req.body?.qid);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const value = req.body?.value;
  a.overrides ||= {};
  if (value === true || value === false) a.overrides[q.id] = value;
  else delete a.overrides[q.id];
  if (a.status === 'submitted') regrade(req.run, a);
  else { io.to('host:' + a.runId).emit('attempt', hostView(a)); save(); }
  res.json({ ok: true, mark: markQuestion(q, a), score: a.score, maxScore: a.maxScore });
});

// LAN addresses, so a lecturer on localhost still gets a join link phones can open
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address))
  .map((i) => i.address);
// Health check for the host (Render pings this before sending traffic / to detect a dead server)
app.get('/healthz', (req, res) => res.json({ ok: true, storage: storage.kind.split(' ')[0], uptime: Math.round(process.uptime()) }));

app.get('/api/net', (req, res) => res.json({ ips: lanIps(), appUrl: APP_URL }));

app.get('/api/qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(clean(req.query.text, 500), { type: 'svg', margin: 1, width: 240 });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(400).end();
  }
});

// Student: public quiz info and joining
const runByCode = (code) => Object.values(db.runs).find((r) => r.code === String(code).toUpperCase());
app.get('/api/join/:code', (req, res) => {
  const quiz = runByCode(req.params.code);
  if (!quiz) return res.status(404).json({ error: 'No quiz with this code.' });
  res.json({
    title: quiz.title,
    description: quiz.description,
    timeLimitMin: quiz.timeLimitMin,
    questionCount: quiz.questions.length,
    status: quiz.status,
    requireFullscreen: quiz.settings.requireFullscreen,
  });
});

app.post('/api/join/:code', (req, res) => {
  const quiz = runByCode(req.params.code);
  if (!quiz) return res.status(404).json({ error: 'No quiz with this code.' });
  if (quiz.status === 'closed') return res.status(403).json({ error: 'This quiz session has ended.' });
  const name = clean(req.body?.name, 80);
  const studentId = clean(req.body?.studentId, 40);
  if (!name || !studentId) return res.status(400).json({ error: 'Enter your name and student ID.' });
  const existing = attemptsOf(quiz.id).find((a) => a.studentId.toLowerCase() === studentId.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'This student ID has already joined this quiz. Ask your lecturer if you need to rejoin.' });
  }
  const { order, optionOrder } = buildOrder(quiz, quiz.settings.shuffleQuestions, quiz.settings.shuffleOptions);
  const a = {
    id: id(9), token: id(24), runId: quiz.id, name, studentId,
    status: quiz.status === 'waiting' ? 'waiting' : 'active', order, optionOrder, answers: {}, current: 0,
    attemptNo: 1, violations: [], freezeReason: null,
    startedAt: now(), activeSince: quiz.status === 'open' ? now() : null, elapsedMs: 0, ua: clean(req.get('user-agent'), 300),
  };
  db.attempts[a.id] = a;
  push(a);
  lobbyCount(quiz);
  res.json({ token: a.token });
});

// Violation via navigator.sendBeacon (works even while the page is being hidden/closed)
app.post('/api/violation', (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const a = Object.values(db.attempts).find((x) => x.token === body?.token);
  if (a) freeze(a, clean(body.type, 100) || 'Left the quiz', body.detail);
  res.status(204).end();
});

// Pretty student link: /q/ABC123
app.get('/q/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
// Big QR + code for a projector / second screen
app.get('/present/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'present.html')));

// ---------------------------------------------------------------- sockets
io.on('connection', (socket) => {
  const auth = socket.handshake.auth || {};

  // Lecturer monitor
  if (auth.role === 'host') {
    const user = userFromCookie(socket.handshake.headers.cookie);
    const quiz = db.runs[auth.runId];
    if (!user || !quiz || quiz.ownerId !== user.id) return socket.disconnect(true);
    socket.join('host:' + quiz.id);
    socket.emit('attempts', attemptsOf(quiz.id).map(hostView));

    const own = (attemptId) => {
      const a = db.attempts[attemptId];
      return a && a.runId === quiz.id ? a : null;
    };
    socket.on('unfreeze', ({ attemptId, mode, shuffleQuestions, shuffleOptions } = {}) => {
      const a = own(attemptId);
      if (a) unfreeze(a, mode === 'restart' ? 'restart' : 'resume', { shuffleQuestions, shuffleOptions });
    });
    socket.on('forceSubmit', ({ attemptId } = {}) => {
      const a = own(attemptId);
      if (a) submit(a, 'lecturer');
    });
    socket.on('remove', ({ attemptId } = {}) => {
      const a = own(attemptId);
      if (!a) return;
      io.to('attempt:' + a.id).emit('state', { status: 'removed' });
      delete db.attempts[a.id];
      io.to('host:' + quiz.id).emit('removed', a.id);
      lobbyCount(quiz);
      save();
    });
    return;
  }

  // Student waiting room (before joining) – live quiz status
  if (auth.role === 'lobby') {
    const code = String(auth.code || '').toUpperCase();
    socket.join('lobby:' + code);
    const run = Object.values(db.runs).find((r) => r.code === code);
    if (run) { socket.emit('quizStatus', run.status); socket.emit('count', attemptsOf(run.id).length); }
    return;
  }

  // Student in a quiz
  const a = Object.values(db.attempts).find((x) => x.token === auth.token);
  if (!a) {
    socket.emit('state', { status: 'removed' });
    return socket.disconnect(true);
  }
  socket.join('attempt:' + a.id);
  a.online = true;

  // A brand-new page load while the quiz was running = page refreshed / reopened / tab killed.
  // (The client only sets `fresh` when it found a saved token at page load, not right after joining.)
  if (auth.fresh && a.status === 'active' && db.runs[a.runId]?.status === 'open') {
    freeze(a, 'Page reloaded or reopened');
  } else {
    push(a);
  }

  const active = () => db.attempts[a.id] && a.status === 'active' && db.runs[a.runId]?.status === 'open';
  socket.on('answer', ({ qid, oid } = {}) => {
    if (!active()) return;
    const quiz = db.runs[a.runId];
    const q = quiz.questions.find((x) => x.id === qid);
    if (!q) return;
    if (oid === null) delete a.answers[qid];
    else if (q.options.some((o) => o.id === oid)) a.answers[qid] = oid;
    io.to('host:' + a.runId).emit('attempt', hostView(a));
    save();
  });
  socket.on('goto', (idx) => {
    if (active() && Number.isInteger(idx)) { a.current = idx; save(); }
  });
  socket.on('violation', ({ type, detail } = {}) => {
    if (db.attempts[a.id]) freeze(a, clean(type, 100) || 'Left the quiz', detail);
  });
  socket.on('submit', () => {
    if (active()) submit(a, 'student');
  });
  socket.on('disconnect', () => {
    if (!db.attempts[a.id]) return;
    a.online = io.sockets.adapter.rooms.get('attempt:' + a.id)?.size > 0;
    io.to('host:' + a.runId).emit('attempt', hostView(a));
  });
});

// ---------------------------------------------------------------- start
// Older data: each quiz had its own code/status and attempts pointed at the quiz.
// Turn every quiz that was opened (or has students) into a past/live session, keep the quiz as a reusable template.
function migrateToSessions() {
  let moved = 0;
  for (const q of Object.values(db.quizzes)) {
    if (!('code' in q) && !('status' in q)) continue;
    const atts = Object.values(db.attempts).filter((a) => a.quizId === q.id && !a.runId);
    if (q.status === 'open' || q.status === 'closed' || atts.length) {
      const startedAt = atts.reduce((m, a) => Math.min(m, a.startedAt || m), q.createdAt || now());
      const { title, description, timeLimitMin, settings, questions } = q;
      const run = {
        id: id(9), quizId: q.id, ownerId: q.ownerId, code: q.code || makeCode(),
        status: q.status === 'open' ? 'open' : 'closed', label: '',
        startedAt, closedAt: q.status === 'open' ? null : now(),
        ...structuredClone({ title, description, timeLimitMin, settings, questions }),
      };
      db.runs[run.id] = run;
      for (const a of atts) { a.runId = run.id; delete a.quizId; }
    }
    delete q.code;
    delete q.status;
    q.updatedAt ||= q.createdAt;
    moved++;
  }
  if (moved) { console.log('  Migrated ' + moved + ' quiz(zes) to the saved-quiz + sessions model'); save(); }
}

async function main() {
  try {
    storage = await openStorage({ databaseUrl: process.env.DATABASE_URL, dataFile: DATA_FILE, table: process.env.DB_TABLE || 'ql_records' });
  } catch (e) {
    console.error(`\nCould not open storage: ${e.message}\n`);
    process.exit(1);
  }
  db = storage.db;
  migrateToSessions();

  // Auto-submit when time runs out
  setInterval(() => {
    for (const a of Object.values(db.attempts)) {
      if (a.status !== 'active') continue;
      const quiz = db.runs[a.runId];
      if (quiz && quiz.timeLimitMin && remaining(a, quiz) <= 0) submit(a, 'time');
    }
  }, 1000);

  // Tidy up expired logins and reset links once an hour
  setInterval(() => {
    let n = 0;
    for (const [t, s] of Object.entries(db.sessions)) if (s.expires < now()) { delete db.sessions[t]; n++; }
    for (const [h, r] of Object.entries(db.resets)) if (r.expires < now()) { delete db.resets[h]; n++; }
    if (n) save();
  }, 3600000);

  // Write pending changes before exiting (Ctrl+C, container stop, …)
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      console.log('\nSaving and shutting down…');
      try { await storage.close(); } catch (e) { console.error('Final save failed:', e.message); }
      process.exit(0);
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\nQuizLock running');
    console.log('  Lecturer:  http://localhost:' + PORT + '/lecturer');
    for (const ip of lanIps()) console.log('  On your network (phones): http://' + ip + ':' + PORT);
    console.log('  Storage: ' + storage.kind + (storage.imported ? ' — imported ' + storage.imported + ' records from ' + path.basename(DATA_FILE) : ''));
    console.log(mailer ? '  Password-reset emails: via ' + SMTP.host : '  Password-reset emails: not configured (links are printed here instead)');
    if (mailer && !APP_URL) console.log('  ⚠ Set APP_URL (e.g. https://quiz.example.edu) so reset links point at the right address.');
    console.log('');
  });
}
main();
