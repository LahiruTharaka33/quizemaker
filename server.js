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
  } while (Object.values(db.quizzes).some((q) => q.code === code));
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
      const correct = options.find((o) => o.id === q.correct) ? q.correct : options[0]?.id;
      return {
        id: clean(q.id, 40) || id(6),
        text: clean(q.text, 2000),
        points: Math.max(0, Math.min(100, Number(q.points) || 1)),
        options,
        correct,
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

const attemptsOf = (quizId) => Object.values(db.attempts).filter((a) => a.quizId === quizId);

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

function grade(a, quiz) {
  let score = 0;
  let max = 0;
  for (const q of quiz.questions) {
    max += q.points;
    if (a.answers[q.id] && a.answers[q.id] === q.correct) score += q.points;
  }
  a.score = score;
  a.maxScore = max;
}

// What the student is allowed to see (never the correct answers).
function studentView(a) {
  const quiz = db.quizzes[a.quizId];
  if (!quiz) return { status: 'gone' };
  const view = {
    status: a.status,
    name: a.name,
    quizTitle: quiz.title,
    quizStatus: quiz.status,
    attemptNo: a.attemptNo,
    freezeReason: a.freezeReason,
    requireFullscreen: quiz.settings.requireFullscreen,
    remainingMs: remaining(a, quiz),
    total: quiz.questions.length,
    answeredCount: Object.keys(a.answers).length,
  };
  if (a.status === 'active') {
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
  const quiz = db.quizzes[a.quizId];
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
  io.to('host:' + a.quizId).emit('attempt', hostView(a));
  save();
}

function freeze(a, type, detail) {
  if (a.status !== 'active') return;
  a.elapsedMs = elapsed(a);
  a.activeSince = null;
  a.status = 'frozen';
  a.freezeReason = type;
  a.frozenAt = now();
  a.violations.push({ type, detail: clean(detail, 200), at: now() });
  push(a);
  io.to('host:' + a.quizId).emit('alert', { name: a.name, reason: type });
}

function submit(a, how = 'student') {
  if (a.status === 'submitted') return;
  const quiz = db.quizzes[a.quizId];
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
  const quiz = db.quizzes[a.quizId];
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
  a.activeSince = now();
  a.freezeReason = null;
  a.frozenAt = null;
  a.violations.push({ type: mode === 'restart' ? 'Restarted by lecturer' : 'Resumed by lecturer', at: now(), system: true });
  push(a);
}

// ---------------------------------------------------------------- app
const app = express();
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
  const key = 'forgot|' + req.ip;
  if (tooManyFailures(key)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  noteFailure(key); // counts every request: max 8 per IP per 15 minutes
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
  for (const k of failures.keys()) if (k.endsWith('|' + user.email)) failures.delete(k);
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

// Lecturer: list / create / read / update / delete
app.get('/api/quizzes', requireUser, (req, res) => {
  const list = Object.values(db.quizzes)
    .filter((q) => q.ownerId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((q) => ({ id: q.id, title: q.title, code: q.code, status: q.status, questionCount: q.questions.length, attemptCount: attemptsOf(q.id).length, createdAt: q.createdAt }));
  res.json(list);
});

app.post('/api/quizzes', requireUser, (req, res) => {
  const data = sanitizeQuiz(req.body || {});
  const quiz = { id: id(9), code: makeCode(), ownerId: req.user.id, status: 'draft', createdAt: now(), ...data };
  db.quizzes[quiz.id] = quiz;
  save();
  res.json({ id: quiz.id, code: quiz.code });
});

// Quizzes made before accounts existed: claim them with the old per-quiz key kept in the browser
app.post('/api/quizzes/claim', requireUser, (req, res) => {
  let claimed = 0;
  for (const { id: qid, key } of Array.isArray(req.body?.items) ? req.body.items : []) {
    const q = db.quizzes[qid];
    if (q && !q.ownerId && q.hostKey && key === q.hostKey) { q.ownerId = req.user.id; delete q.hostKey; claimed++; }
  }
  if (claimed) save();
  res.json({ claimed });
});

app.get('/api/quizzes/:id', hostAuth, (req, res) => {
  res.json({ ...req.quiz, attemptCount: attemptsOf(req.quiz.id).length });
});

app.put('/api/quizzes/:id', hostAuth, (req, res) => {
  if (attemptsOf(req.quiz.id).length) {
    return res.status(409).json({ error: 'Students have already joined this quiz, so it can no longer be edited. Duplicate it instead.' });
  }
  Object.assign(req.quiz, sanitizeQuiz(req.body || {}));
  save();
  res.json({ ok: true });
});

app.post('/api/quizzes/:id/status', hostAuth, (req, res) => {
  const status = req.body?.status;
  if (!['draft', 'open', 'closed'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'open' && !req.quiz.questions.length) return res.status(400).json({ error: 'Add at least one question first.' });
  req.quiz.status = status;
  if (status === 'closed') {
    for (const a of attemptsOf(req.quiz.id)) if (a.status !== 'submitted') submit(a, 'closed');
  }
  io.to('quiz:' + req.quiz.code).emit('quizStatus', status);
  for (const a of attemptsOf(req.quiz.id)) io.to('attempt:' + a.id).emit('state', studentView(a));
  save();
  res.json({ ok: true });
});

app.delete('/api/quizzes/:id', hostAuth, (req, res) => {
  for (const a of attemptsOf(req.quiz.id)) delete db.attempts[a.id];
  delete db.quizzes[req.quiz.id];
  save();
  res.json({ ok: true });
});

app.get('/api/quizzes/:id/results.csv', hostAuth, (req, res) => {
  const q = req.quiz;
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Name', 'Student ID', 'Status', 'Score', 'Max', 'Answered', 'Attempt #', 'Violations', 'Started', 'Submitted']];
  for (const a of attemptsOf(q.id)) {
    if (a.status === 'submitted') grade(a, q);
    rows.push([
      a.name, a.studentId, a.status, a.score ?? '', a.maxScore ?? '', Object.keys(a.answers).length, a.attemptNo,
      a.violations.filter((v) => !v.system).map((v) => v.type).join('; '),
      a.startedAt ? new Date(a.startedAt).toISOString() : '', a.submittedAt ? new Date(a.submittedAt).toISOString() : '',
    ]);
  }
  const fname = q.title.replace(/[^\w-]+/g, '_').slice(0, 50) || 'quiz';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}_results.csv"`);
  res.send('﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'));
});

// LAN addresses, so a lecturer on localhost still gets a join link phones can open
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address))
  .map((i) => i.address);
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
app.get('/api/join/:code', (req, res) => {
  const quiz = Object.values(db.quizzes).find((q) => q.code === String(req.params.code).toUpperCase());
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
  const quiz = Object.values(db.quizzes).find((q) => q.code === String(req.params.code).toUpperCase());
  if (!quiz) return res.status(404).json({ error: 'No quiz with this code.' });
  if (quiz.status !== 'open') return res.status(403).json({ error: quiz.status === 'closed' ? 'This quiz is closed.' : 'This quiz has not been opened yet.' });
  const name = clean(req.body?.name, 80);
  const studentId = clean(req.body?.studentId, 40);
  if (!name || !studentId) return res.status(400).json({ error: 'Enter your name and student ID.' });
  const existing = attemptsOf(quiz.id).find((a) => a.studentId.toLowerCase() === studentId.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'This student ID has already joined this quiz. Ask your lecturer if you need to rejoin.' });
  }
  const { order, optionOrder } = buildOrder(quiz, quiz.settings.shuffleQuestions, quiz.settings.shuffleOptions);
  const a = {
    id: id(9), token: id(24), quizId: quiz.id, name, studentId,
    status: 'active', order, optionOrder, answers: {}, current: 0,
    attemptNo: 1, violations: [], freezeReason: null,
    startedAt: now(), activeSince: now(), elapsedMs: 0, ua: clean(req.get('user-agent'), 300),
  };
  db.attempts[a.id] = a;
  push(a);
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

// ---------------------------------------------------------------- sockets
io.on('connection', (socket) => {
  const auth = socket.handshake.auth || {};

  // Lecturer monitor
  if (auth.role === 'host') {
    const user = userFromCookie(socket.handshake.headers.cookie);
    const quiz = db.quizzes[auth.quizId];
    if (!user || !quiz || quiz.ownerId !== user.id) return socket.disconnect(true);
    socket.join('host:' + quiz.id);
    socket.emit('attempts', attemptsOf(quiz.id).map(hostView));

    const own = (attemptId) => {
      const a = db.attempts[attemptId];
      return a && a.quizId === quiz.id ? a : null;
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
      save();
    });
    return;
  }

  // Student waiting room (before joining) – live quiz status
  if (auth.role === 'lobby') {
    socket.join('quiz:' + String(auth.code || '').toUpperCase());
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
  if (auth.fresh && a.status === 'active') {
    freeze(a, 'Page reloaded or reopened');
  } else {
    push(a);
  }

  const active = () => db.attempts[a.id] && a.status === 'active';
  socket.on('answer', ({ qid, oid } = {}) => {
    if (!active()) return;
    const quiz = db.quizzes[a.quizId];
    const q = quiz.questions.find((x) => x.id === qid);
    if (!q) return;
    if (oid === null) delete a.answers[qid];
    else if (q.options.some((o) => o.id === oid)) a.answers[qid] = oid;
    io.to('host:' + a.quizId).emit('attempt', hostView(a));
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
    io.to('host:' + a.quizId).emit('attempt', hostView(a));
  });
});

// ---------------------------------------------------------------- start
async function main() {
  try {
    storage = await openStorage({ databaseUrl: process.env.DATABASE_URL, dataFile: DATA_FILE, table: process.env.DB_TABLE || 'ql_records' });
  } catch (e) {
    console.error(`\nCould not open storage: ${e.message}\n`);
    process.exit(1);
  }
  db = storage.db;

  // Auto-submit when time runs out
  setInterval(() => {
    for (const a of Object.values(db.attempts)) {
      if (a.status !== 'active') continue;
      const quiz = db.quizzes[a.quizId];
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
