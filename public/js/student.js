// Student app: join, take the quiz, freeze when the student leaves.
const code = (location.pathname.split('/q/')[1] || new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const TOKEN_KEY = 'qp_att_' + code;
const fsSupported = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

let info = null;      // public quiz info
let token = store.get(TOKEN_KEY, null);
let state = null;     // latest state from server
let current = 0;      // question index shown
let answers = {};
let socket = null;
let remainingMs = null;
let timerInt = null;

// lock state
let armed = false;        // detection on
let graceUntil = 0;       // ignore events until (fullscreen transitions fire blur/resize)
let frozenLocal = false;
let fsEntered = false;    // we successfully entered fullscreen
let needsReentry = false; // unlocked, waiting for a tap to go back in

const screens = ['sLoading', 'sJoin', 'quiz', 'sMsg'];
function show(id) { screens.forEach((s) => $('#' + s).classList.toggle('hidden', s !== id)); }

// ================================================================ boot
(async function boot() {
  if (!code) return message('🤔', 'No quiz code', 'Open the link your lecturer shared, or enter the code on the home page.', '<a class="btn" href="/">Go home</a>');
  try {
    info = await api('GET', '/api/join/' + code);
  } catch (e) {
    return message('🤷', 'Quiz not found', e.message, '<a class="btn" href="/">Try another code</a>');
  }
  document.title = info.title + ' · QuizLock';
  if (token) return connect(true); // returning to an attempt (reload / reopen)
  renderJoin();
})();

// ================================================================ join
function renderJoin() {
  show('sJoin');
  $('#jTitle').textContent = info.title;
  $('#jDesc').textContent = info.description || '';
  $('#jInfo').innerHTML = `<span class="badge primary">${info.questionCount} questions</span>
    <span class="badge">${info.timeLimitMin ? '⏱ ' + info.timeLimitMin + ' min' : 'No time limit'}</span>`;
  $('#ruleFs').classList.toggle('hidden', !(info.requireFullscreen && fsSupported));
  const saved = store.get('qp_me', {});
  $('#jName').value ||= saved.name || '';
  $('#jSid').value ||= saved.sid || '';
  updateJoinStatus();

  // Live: wait for the lecturer to open the quiz
  const lobby = io({ auth: { role: 'lobby', code } });
  lobby.on('quizStatus', (s) => { info.status = s; updateJoinStatus(); });
  lobby.on('connect', async () => { // refresh after reconnects
    try { info = { ...info, ...(await api('GET', '/api/join/' + code)) }; updateJoinStatus(); } catch {}
  });
  renderJoin.lobby = lobby;
}
function updateJoinStatus() {
  const open = info.status === 'open';
  $('#jForm').classList.toggle('hidden', !open);
  $('#jWaiting').classList.toggle('hidden', open);
  $('#jWaitingTxt').textContent = info.status === 'closed' ? 'This quiz session has ended.' : 'Waiting for your lecturer to open the quiz…';
}

$('#jForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#jName').value.trim();
  const sid = $('#jSid').value.trim();
  if (!name || !sid) return;
  $('#jStart').disabled = true;
  // Must be called directly inside the tap handler for browsers to allow it.
  if (info.requireFullscreen) await enterFullscreen();
  try {
    const r = await api('POST', '/api/join/' + code, { name, studentId: sid });
    token = r.token;
    store.set(TOKEN_KEY, token);
    store.set('qp_me', { name, sid });
    renderJoin.lobby?.disconnect();
    graceUntil = Date.now() + 1500;
    connect(false);
  } catch (err) {
    exitFullscreen();
    toast(err.message, 'danger');
    $('#jStart').disabled = false;
  }
});

// ================================================================ socket
function connect(fresh) {
  let first = fresh;
  socket = io({ auth: (cb) => { cb({ token, fresh: first }); first = false; } });
  socket.on('state', onState);
  socket.on('disconnect', () => { if (armed) toast('Connection lost — reconnecting…'); });
}

function onState(s) {
  const prev = state;
  state = s;
  remainingMs = s.remainingMs;

  if (s.status === 'removed' || s.status === 'gone') {
    disarm();
    store.del(TOKEN_KEY);
    return message('🚪', 'You were removed', 'Your lecturer removed this attempt. You can join again.', `<a class="btn primary" href="/q/${code}">Join again</a>`);
  }

  if (s.status === 'submitted') {
    disarm();
    exitFullscreen();
    hideOverlays();
    const score = s.score != null ? `<div class="score-ring">${s.score}<span class="muted" style="font-size:1.4rem">/${s.maxScore}</span></div>` : '';
    return message('🎉', 'Quiz submitted', `${score}<p class="muted">Thanks, ${esc(s.name)}. Your answers have been recorded.</p>`);
  }

  if (s.status === 'frozen') {
    frozenLocal = true;
    armed = false;
    needsReentry = false;
    $('#oReason').textContent = s.freezeReason || 'Left the quiz';
    $('#oResume').classList.add('hidden');
    $('#oFrozen').classList.remove('hidden');
    show('quiz');
    $('#qTitle').textContent = s.quizTitle;
    stopTimer();
    return;
  }

  // ---- active
  answers = { ...s.answers };
  const wasActive = prev && prev.status === 'active';
  if (!wasActive) current = Math.min(s.current || 0, s.questions.length - 1);
  if (prev && prev.status === 'frozen') {
    frozenLocal = false;
    $('#oFrozen').classList.add('hidden');
    const restarted = s.attemptNo !== prev.attemptNo;
    if (restarted) current = 0;
    $('#oResumeTitle').textContent = restarted ? 'Quiz restarted' : "You've been unlocked";
    $('#oResumeTxt').textContent = restarted
      ? 'Your lecturer restarted your quiz from the beginning. Tap below when you are ready.'
      : 'Your lecturer let you continue where you left off. Tap below to go back in.';
    needsReentry = true;
    $('#oResume').classList.remove('hidden');
  }
  show('quiz');
  $('#qTitle').textContent = s.quizTitle;
  document.body.classList.add('locked');
  renderQuestion();
  startTimer();
  arm();
}

// ================================================================ quiz UI
function renderQuestion() {
  const qs = state.questions;
  const q = qs[current];
  const answered = Object.keys(answers).filter((k) => qs.some((x) => x.id === k)).length;
  $('#qProg').style.width = (answered / qs.length) * 100 + '%';
  $('#qStrip').innerHTML = qs.map((x, i) => `<button class="${answers[x.id] ? 'ans' : ''} ${i === current ? 'cur' : ''}" data-i="${i}">${i + 1}</button>`).join('');
  $('#qStrip .cur')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#qBody').innerHTML = `
    <div class="qmeta"><span>Question ${current + 1} of ${qs.length}</span><span>${q.points} pt${q.points === 1 ? '' : 's'}</span></div>
    <div class="qtext">${esc(q.text)}</div>
    ${q.options.map((o, i) => `
      <button class="option ${answers[q.id] === o.id ? 'sel' : ''}" data-o="${o.id}">
        <span class="letter">${String.fromCharCode(65 + i)}</span><span class="otext">${esc(o.text)}</span>
      </button>`).join('')}`;
  $('#qPrev').disabled = current === 0;
  const last = current === qs.length - 1;
  $('#qNext').textContent = last ? 'Submit ✓' : 'Next ›';
  $('#qNext').className = 'btn ' + (last ? 'ok' : 'primary');
}

$('#qBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-o]');
  if (!b || !state || state.status !== 'active') return;
  const q = state.questions[current];
  answers[q.id] = b.dataset.o;
  socket.emit('answer', { qid: q.id, oid: b.dataset.o });
  navigator.vibrate?.(10);
  renderQuestion();
});
$('#qStrip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) go(+b.dataset.i);
});
$('#qPrev').onclick = () => go(current - 1);
$('#qNext').onclick = () => (current === state.questions.length - 1 ? confirmSubmit() : go(current + 1));
function go(i) {
  if (i < 0 || i >= state.questions.length) return;
  current = i;
  socket.emit('goto', i);
  renderQuestion();
  $('.qbody').scrollTop = 0;
}

async function confirmSubmit() {
  const left = state.questions.filter((q) => !answers[q.id]).length;
  const r = await modal(`
    <h2>Submit quiz?</h2>
    <p class="muted">${left ? `<b style="color:var(--danger)">${left} question${left > 1 ? 's are' : ' is'} unanswered.</b> ` : 'All questions answered. '}You can't change your answers after submitting.</p>
    <div class="row end"><button class="btn" data-value="no">Keep working</button><button class="btn ok" data-value="yes">Submit</button></div>`);
  if (r?.value === 'yes') socket.emit('submit');
}

function startTimer() {
  stopTimer();
  const el = $('#qTimer');
  if (remainingMs == null) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const paint = () => {
    el.textContent = '⏱ ' + fmtTime(remainingMs);
    el.classList.toggle('low', remainingMs <= 60000);
  };
  paint();
  timerInt = setInterval(() => {
    remainingMs = Math.max(0, remainingMs - 1000);
    paint();
  }, 1000);
}
function stopTimer() { clearInterval(timerInt); }

function message(icon, title, body, actions = '') {
  stopTimer();
  document.body.classList.remove('locked');
  show('sMsg');
  $('#msgCard').innerHTML = `<div style="font-size:52px">${icon}</div><h1>${esc(title)}</h1><div class="muted">${body.startsWith('<') ? body : esc(body)}</div><div style="margin-top:16px">${actions}</div>`;
}
function hideOverlays() { $('#oFrozen').classList.add('hidden'); $('#oResume').classList.add('hidden'); }

// Back into the quiz after an unlock (needs a tap so fullscreen is allowed)
$('#oResumeBtn').onclick = async () => {
  graceUntil = Date.now() + 1500;
  if (info.requireFullscreen) await enterFullscreen();
  needsReentry = false;
  $('#oResume').classList.add('hidden');
};

// ================================================================ lock-down
function arm() {
  if (armed) return;
  armed = true;
  graceUntil = Math.max(graceUntil, Date.now() + 800);
  history.pushState({ locked: true }, '', location.href);
}
function disarm() { armed = false; document.body.classList.remove('locked'); }

function violation(type) {
  if (!armed || frozenLocal || !token || Date.now() < graceUntil) return;
  frozenLocal = true;
  armed = false;
  // Freeze immediately on screen, then tell the server two ways (socket may already be suspended on mobile).
  $('#oReason').textContent = type;
  $('#oResume').classList.add('hidden');
  $('#oFrozen').classList.remove('hidden');
  stopTimer();
  socket?.emit('violation', { type });
  try { navigator.sendBeacon('/api/violation', JSON.stringify({ token, type })); } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') violation('Switched to another app or tab');
});
window.addEventListener('blur', () => {
  // Short delay: some browsers blur briefly during fullscreen changes / permission prompts.
  setTimeout(() => { if (!document.hasFocus()) violation('Left the quiz window'); }, 250);
});
window.addEventListener('pagehide', () => violation('Closed or reloaded the page'));
function onFsChange() {
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (inFs) fsEntered = true;
  else if (fsEntered) {
    fsEntered = false;
    if (info?.requireFullscreen && !needsReentry) violation('Exited full screen');
  }
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// Back button: stay on the quiz
window.addEventListener('popstate', () => {
  if (armed) { history.pushState({ locked: true }, '', location.href); toast("You can't leave during the quiz."); }
});
// No copying, pasting, right-click or text selection; detect the screenshot key on desktop
['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart'].forEach((ev) =>
  document.addEventListener(ev, (e) => { if (document.body.classList.contains('locked')) e.preventDefault(); }));
document.addEventListener('keydown', (e) => {
  if (!armed) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'a', 'p', 's', 'u', 'f'].includes(k)) e.preventDefault();
  if (k === 'f12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(k))) e.preventDefault();
});
document.addEventListener('keyup', (e) => { if (e.key === 'PrintScreen') violation('Pressed the screenshot key'); });

async function enterFullscreen() {
  if (!fsSupported) return;
  const el = document.documentElement;
  try {
    const req = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
    // Some browsers/webviews never settle the promise — don't let that block the quiz.
    await Promise.race([req, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
    fsEntered = !!(document.fullscreenElement || document.webkitFullscreenElement);
    try { await screen.orientation?.lock?.('portrait'); } catch {}
  } catch {}
}
function exitFullscreen() {
  fsEntered = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
}
