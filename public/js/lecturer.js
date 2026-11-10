// Lecturer app: login, quiz list, builder, live monitor
const view = $('#view');
const hostApi = (method, id, path = '', body) => api(method, `/api/quizzes/${id}${path}`, body);

let me = null;      // logged-in lecturer
let cleanup = null; // teardown for the current view (sockets/timers)

// Any 401 from the API (session expired / logged out elsewhere) -> back to login
function onUnauthorized() {
  if (!me) return;
  me = null;
  toast('Your session has ended. Please log in again.');
  route();
}

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  renderUserBar();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'reset' && parts[1]) return renderReset(parts[1]);
  if (!me) return renderAuth(parts[0] === 'register' ? 'register' : 'login');
  if (parts[0] === 'register') { history.replaceState(null, '', '#/'); return renderList(); }
  if (parts[0] === 'new') return renderBuilder(null);
  if (parts[0] === 'edit' && parts[1]) return renderBuilder(parts[1]);
  if (parts[0] === 'quiz' && parts[1]) return renderQuiz(parts[1]);   // saved quiz: start it, see past sessions
  if (parts[0] === 'run' && parts[1]) return renderMonitor(parts[1]);  // one live/past session
  renderList();
}
window.addEventListener('hashchange', route);

// ================================================================ account
function renderUserBar() {
  const bar = $('#userBar');
  if (!me) { bar.innerHTML = '<span class="badge primary">Lecturer</span>'; return; }
  bar.innerHTML = `<button class="btn sm ghost" id="userBtn" title="Account">
    <span class="avatar" style="width:28px;height:28px;font-size:.8rem">${esc(me.name.trim()[0]?.toUpperCase() || '?')}</span>
    <span class="uname">${esc(me.name.split(' ')[0])}</span></button>`;
  $('#userBtn').onclick = async () => {
    const r = await modal(`<h2>${esc(me.name)}</h2><p class="muted">${esc(me.email)}</p>
      <div class="row end"><button class="btn" data-value="close">Close</button><button class="btn" data-value="password">Change password</button><button class="btn danger" data-value="logout">Log out</button></div>`);
    if (r?.value === 'password') return changePassword();
    if (r?.value !== 'logout') return;
    await api('POST', '/api/auth/logout').catch(() => {});
    me = null;
    location.hash = '#/';
    route();
  };
}

async function renderAuth(mode = 'login') {
  const cfg = await api('GET', '/api/auth/config').catch(() => ({}));
  const reg = mode === 'register';
  view.innerHTML = `
    <div class="wrap" style="max-width:440px;padding-top:32px">
      <div style="text-align:center;margin-bottom:18px">
        <div style="font-size:44px">🧑‍🏫</div>
        <h1>${reg ? 'Create lecturer account' : 'Lecturer login'}</h1>
        <p class="muted">${reg ? 'Make quizzes and watch your students live.' : 'Log in to manage your quizzes from any device.'}</p>
      </div>
      <form class="card" id="authForm" novalidate>
        ${reg ? '<label class="field"><span>Full name</span><input type="text" id="aName" autocomplete="name" maxlength="80" required></label>' : ''}
        <label class="field"><span>Email</span><input type="email" id="aEmail" autocomplete="email" inputmode="email" maxlength="200" required></label>
        <label class="field"><span>Password${reg ? ' <span class="muted">(at least 8 characters)</span>' : ''}</span>
          <div class="row" style="flex-wrap:nowrap"><input type="password" id="aPass" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 8 : 1}" required>
          <button type="button" class="btn ghost sm" id="aShow">Show</button></div></label>
        ${reg && cfg.inviteRequired ? '<label class="field"><span>Invite code</span><input type="text" id="aInvite" autocomplete="off" required></label>' : ''}
        <div id="aErr" class="freeze-box hidden" style="margin:0 0 14px;padding:10px 12px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-weight:600;font-size:.9rem"></div>
        <button class="btn primary block" id="aGo" type="submit" style="min-height:50px">${reg ? 'Create account' : 'Log in'}</button>
      </form>
      ${reg ? '' : '<p style="text-align:center;margin-top:-4px"><a href="#" id="aForgot">Forgot password?</a></p>'}
      <p style="text-align:center" class="muted">${reg ? 'Already have an account?' : 'New here?'}
        <a href="#" id="aSwitch">${reg ? 'Log in' : 'Create an account'}</a></p>
    </div>`;
  $('#aSwitch').onclick = (e) => { e.preventDefault(); renderAuth(reg ? 'login' : 'register'); };
  $('#aForgot')?.addEventListener('click', (e) => { e.preventDefault(); renderForgot($('#aEmail').value.trim(), cfg); });
  $('#aShow').onclick = () => {
    const p = $('#aPass');
    p.type = p.type === 'password' ? 'text' : 'password';
    $('#aShow').textContent = p.type === 'password' ? 'Show' : 'Hide';
  };
  (reg ? $('#aName') : $('#aEmail')).focus();
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { email: $('#aEmail').value.trim(), password: $('#aPass').value };
    if (reg) { body.name = $('#aName').value.trim(); body.inviteCode = $('#aInvite')?.value.trim(); }
    $('#aGo').disabled = true;
    $('#aErr').classList.add('hidden');
    try {
      me = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', body);
      await claimOldQuizzes();
      toast(reg ? `Welcome, ${me.name.split(' ')[0]}!` : 'Logged in');
      route();
    } catch (err) {
      $('#aErr').textContent = err.message;
      $('#aErr').classList.remove('hidden');
      $('#aGo').disabled = false;
    }
  };
}

// ---- password reset / change
const errBox = 'class="hidden" style="margin:0 0 14px;padding:10px 12px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-weight:600;font-size:.9rem"';
function authShell(icon, title, sub, body) {
  view.innerHTML = `
    <div class="wrap" style="max-width:440px;padding-top:32px">
      <div style="text-align:center;margin-bottom:18px"><div style="font-size:44px">${icon}</div><h1>${title}</h1><p class="muted">${sub}</p></div>
      ${body}
    </div>`;
}
function showErr(id, msg) { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); }

function renderForgot(email = '', cfg = {}) {
  authShell('🔑', 'Forgot password', 'Enter your account email and we\'ll send you a link to choose a new password.', `
    <form class="card" id="fForm" novalidate>
      <label class="field"><span>Email</span><input type="email" id="fEmail" autocomplete="email" inputmode="email" maxlength="200" required></label>
      <div id="fErr" ${errBox}></div>
      <button class="btn primary block" id="fGo" type="submit" style="min-height:50px">Send reset link</button>
    </form>
    <p style="text-align:center"><a href="#" id="fBack">‹ Back to login</a></p>`);
  $('#fEmail').value = email;
  $('#fEmail').focus();
  $('#fBack').onclick = (e) => { e.preventDefault(); renderAuth('login'); };
  $('#fForm').onsubmit = async (e) => {
    e.preventDefault();
    const em = $('#fEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return showErr('#fErr', 'Enter a valid email address.');
    $('#fGo').disabled = true;
    try {
      await api('POST', '/api/auth/forgot', { email: em });
      authShell('📬', 'Check your email', `If <b>${esc(em)}</b> has a lecturer account, a reset link is on its way. It works once and expires in 1 hour.`, `
        ${cfg.emailConfigured ? '' : '<div class="card small muted">Email sending isn\'t set up on this server yet, so the link was printed in the <b>server console</b>. Ask whoever runs the server for it.</div>'}
        <p style="text-align:center"><a href="#" id="fBack2">‹ Back to login</a></p>`);
      $('#fBack2').onclick = (ev) => { ev.preventDefault(); renderAuth('login'); };
    } catch (err) {
      showErr('#fErr', err.message);
      $('#fGo').disabled = false;
    }
  };
}

async function renderReset(token) {
  let info;
  try { info = await api('GET', '/api/auth/reset/' + encodeURIComponent(token)); } catch (err) {
    authShell('⌛', 'Link expired', esc(err.message), '<a class="btn primary block" href="#/" id="rAgain">Back to login</a>');
    $('#rAgain').onclick = (e) => { e.preventDefault(); history.replaceState(null, '', '#/'); me ? route() : renderForgot(); };
    return;
  }
  authShell('🔑', 'Choose a new password', `For <b>${esc(info.email)}</b>. You'll be logged out on all other devices.`, `
    <form class="card" id="rForm" novalidate>
      <label class="field"><span>New password <span class="muted">(at least 8 characters)</span></span><input type="password" id="rPass" autocomplete="new-password" required></label>
      <label class="field"><span>Repeat new password</span><input type="password" id="rPass2" autocomplete="new-password" required></label>
      <div id="rErr" ${errBox}></div>
      <button class="btn primary block" id="rGo" type="submit" style="min-height:50px">Save new password</button>
    </form>`);
  $('#rPass').focus();
  $('#rForm').onsubmit = async (e) => {
    e.preventDefault();
    const p = $('#rPass').value;
    if (p.length < 8) return showErr('#rErr', 'Password must be at least 8 characters.');
    if (p !== $('#rPass2').value) return showErr('#rErr', "The two passwords don't match.");
    $('#rGo').disabled = true;
    try {
      me = await api('POST', '/api/auth/reset', { token, password: p });
      history.replaceState(null, '', '#/'); // drop the token from the address bar
      toast('Password changed — you\'re logged in');
      route();
    } catch (err) {
      showErr('#rErr', err.message);
      $('#rGo').disabled = false;
    }
  };
}

async function changePassword() {
  const r = await modal(`
    <h2>Change password</h2>
    <label class="field"><span>Current password</span><input type="password" id="cCur" autocomplete="current-password" autofocus></label>
    <label class="field"><span>New password <span class="muted">(at least 8 characters)</span></span><input type="password" id="cNew" autocomplete="new-password"></label>
    <label class="field"><span>Repeat new password</span><input type="password" id="cNew2" autocomplete="new-password"></label>
    <p class="muted small">Other devices will be logged out.</p>
    <div class="row end"><button class="btn" data-value="cancel">Cancel</button><button class="btn primary" data-value="save">Save</button></div>`);
  if (r?.value !== 'save') return;
  const cur = $('#cCur', r.root).value;
  const p = $('#cNew', r.root).value;
  if (p.length < 8) { toast('New password must be at least 8 characters.', 'danger'); return changePassword(); }
  if (p !== $('#cNew2', r.root).value) { toast("The two new passwords don't match.", 'danger'); return changePassword(); }
  try {
    await api('POST', '/api/auth/change-password', { current: cur, password: p });
    toast('Password changed ✓');
  } catch (err) {
    toast(err.message, 'danger');
    if (err.status !== 401) changePassword();
  }
}

// Quizzes created before accounts existed were stored in this browser with a secret key.
async function claimOldQuizzes() {
  const old = store.get('qp_quizzes', []);
  if (!old.length) return;
  try {
    const r = await api('POST', '/api/quizzes/claim', { items: old.map((q) => ({ id: q.id, key: q.key })) });
    store.del('qp_quizzes');
    if (r.claimed) toast(`${r.claimed} earlier quiz${r.claimed > 1 ? 'zes were' : ' was'} added to your account`);
  } catch {}
}

// ================================================================ list
async function renderList() {
  view.innerHTML = `
    <div class="wrap">
      <div class="row" style="margin:8px 0 16px">
        <h1 style="margin:0">My quizzes</h1><span class="spacer"></span>
        <a class="btn primary" href="#/new">＋ New quiz</a>
      </div>
      <div id="items"><div class="card empty"><div class="spinner"></div></div></div>
    </div>`;
  let list;
  try { list = await api('GET', '/api/quizzes'); } catch (e) { return; }
  const items = $('#items');
  if (!list.length) {
    items.innerHTML = `<div class="card empty"><div class="big">📝</div><p><b>No saved quizzes yet.</b><br>Create a quiz once, then start it whenever you need it, as many times as you like.</p>
      <a class="btn primary" href="#/new">Create your first quiz</a></div>`;
    return;
  }
  items.innerHTML = list.map((q) => `
    <div class="card quiz-item" data-id="${q.id}">
      <a class="meta" href="#/quiz/${q.id}" style="text-decoration:none;color:inherit">
        <h3>${esc(q.title)}</h3>
        <div class="muted small">
          ${q.live.length ? `<span class="badge ok"><i class="dot"></i>Live${q.live.length > 1 ? ' ×' + q.live.length : ''}</span> ` : ''}
          ${q.questionCount} question${q.questionCount === 1 ? '' : 's'}${q.timeLimitMin ? ' · ' + q.timeLimitMin + ' min' : ''}
          · ${q.runCount ? `used ${q.runCount}× · last ${fmtDate(q.lastRunAt)}` : 'never started'}
        </div>
      </a>
      ${q.live.length === 1
        ? `<a class="btn sm ok" href="#/run/${q.live[0].id}">Open live</a>`
        : `<button class="btn sm primary" data-start="${q.id}">▶ Start</button>`}
    </div>`).join('');
  items.addEventListener('click', (e) => {
    const b = e.target.closest('[data-start]');
    if (b) startSession(b.dataset.start, list.find((q) => q.id === b.dataset.start)?.title);
  });
}

function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? 'today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function runBadge(s) {
  return s === 'open' ? '<span class="badge ok"><i class="dot"></i>Live</span>' : '<span class="badge">Ended</span>';
}

// Start a saved quiz: creates a new session with its own join code
async function startSession(quizId, title = 'this quiz') {
  const r = await modal(`
    <h2>Start “${esc(title)}”</h2>
    <p class="muted small">Students get a new join code and link. Results are kept separately for this session.</p>
    <label class="field"><span>Session name <span class="muted">(optional)</span></span>
      <input type="text" id="runLabel" maxlength="80" placeholder="e.g. Group A, Tuesday 10am" autofocus></label>
    <div class="row end"><button class="btn" data-value="cancel">Cancel</button><button class="btn ok" data-value="go">▶ Start now</button></div>`);
  if (r?.value !== 'go') return;
  try {
    const run = await hostApi('POST', quizId, '/runs', { label: $('#runLabel', r.root).value.trim() });
    toast('Quiz started — share the code ' + run.code);
    location.hash = '#/run/' + run.id;
  } catch (e) { toast(e.message, 'danger'); }
}

// ================================================================ saved quiz page
async function renderQuiz(quizId) {
  let quiz;
  try { quiz = await hostApi('GET', quizId); } catch (e) {
    view.innerHTML = `<div class="wrap"><div class="card empty"><div class="big">🤷</div><p>${esc(e.message)}</p><a class="btn" href="#/">Back</a></div></div>`;
    return;
  }
  const live = quiz.runs.filter((r) => r.status === 'open');
  const past = quiz.runs.filter((r) => r.status !== 'open');
  const runRow = (r) => `
    <a class="run-row" href="#/run/${r.id}">
      <div style="flex:1;min-width:0">
        <b>${r.label ? esc(r.label) : fmtDate(r.startedAt)}</b>
        <div class="muted small">${r.label ? fmtDate(r.startedAt) + ' · ' : ''}code ${r.code} · ${r.studentCount} student${r.studentCount === 1 ? '' : 's'}${r.avgPct != null ? ` · avg ${r.avgPct}%` : ''}</div>
      </div>
      ${runBadge(r.status)}<span class="muted">›</span>
    </a>`;

  view.innerHTML = `
    <div class="wrap">
      <a href="#/" class="muted small" style="text-decoration:none">‹ My quizzes</a>
      <h1 style="margin:6px 0 4px">${esc(quiz.title)}</h1>
      <div class="muted small" style="margin-bottom:14px">${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"} · ${quiz.timeLimitMin ? quiz.timeLimitMin + ' min' : 'no time limit'}
        · saved ${fmtDate(quiz.updatedAt || quiz.createdAt)}</div>

      <button class="btn ok block" id="start" style="min-height:54px;font-size:1.05rem;margin-bottom:10px">▶ Start quiz now</button>
      <div class="row" style="margin-bottom:16px">
        <a class="btn" href="#/edit/${quiz.id}" style="flex:1">✎ Edit</a>
        <button class="btn" id="dup" style="flex:1">⧉ Duplicate</button>
        <button class="btn ghost" id="del" title="Delete quiz">🗑</button>
      </div>

      ${live.length ? `<div class="card"><h3>Live now</h3>${live.map(runRow).join('')}</div>` : ''}

      <div class="card">
        <h3>Past sessions</h3>
        ${past.length ? past.map(runRow).join('') : '<p class="muted small" style="margin:0">Not used yet. Press <b>Start quiz now</b> whenever you\'re ready, today or any later day.</p>'}
      </div>

      <details class="card">
        <summary style="cursor:pointer;font-weight:700">Questions (${quiz.questions.length})</summary>
        <ol style="padding-left:20px;margin:12px 0 0">
          ${quiz.questions.map((q) => `<li style="margin-bottom:10px"><div>${esc(q.text)}</div>
            <div class="muted small">${q.options.map((o) => (o.id === q.correct ? `<b style="color:var(--ok)">✓ ${esc(o.text)}</b>` : esc(o.text))).join(' · ')}</div></li>`).join('')}
        </ol>
      </details>
      <p class="muted small">Editing the quiz only changes future sessions. Sessions already started keep the questions they began with.</p>
    </div>`;

  $('#start').onclick = () => startSession(quiz.id, quiz.title);
  $('#dup').onclick = async () => {
    try {
      const r = await hostApi('POST', quiz.id, '/duplicate');
      toast('Copy created');
      location.hash = '#/edit/' + r.id;
    } catch (e) { toast(e.message, 'danger'); }
  };
  $('#del').onclick = async () => {
    const r = await modal(`<h2>Delete “${esc(quiz.title)}”?</h2>
      <p class="muted">The saved quiz <b>and all ${quiz.runs.length} session${quiz.runs.length === 1 ? '' : 's'} with their student results</b> will be permanently deleted. This cannot be undone.</p>
      <div class="row end"><button class="btn" data-value="no">Cancel</button><button class="btn danger" data-value="yes">Delete forever</button></div>`);
    if (r?.value !== 'yes') return;
    try { await hostApi('DELETE', quiz.id); toast('Quiz deleted'); location.hash = '#/'; } catch (e) { toast(e.message, 'danger'); }
  };
}

// ================================================================ builder
const rid = () => Math.random().toString(36).slice(2, 9);
const blankQ = () => {
  const o = [{ id: rid(), text: '' }, { id: rid(), text: '' }, { id: rid(), text: '' }, { id: rid(), text: '' }];
  return { id: rid(), text: '', points: 1, options: o, correct: o[0].id };
};

async function renderBuilder(quizId) {
  let quiz;
  if (quizId) {
    try { quiz = await hostApi('GET', quizId); } catch (e) { return toast(e.message, 'danger'); }
  } else {
    quiz = {
      title: '', description: '', timeLimitMin: 15,
      settings: { shuffleQuestions: true, shuffleOptions: true, showScore: true, requireFullscreen: true },
      questions: [blankQ()],
    };
  }

  view.innerHTML = `
    <div class="wrap">
      <h1 style="margin:8px 0 16px">${quizId ? 'Edit quiz' : 'New quiz'}</h1>
      <div class="card">
        <label class="field"><span>Quiz title</span><input type="text" id="title" maxlength="200" placeholder="e.g. Week 5 – Data Structures"></label>
        <label class="field"><span>Instructions for students <span class="muted">(optional)</span></span><textarea id="desc" maxlength="2000" placeholder="Read each question carefully…"></textarea></label>
        <label class="field" style="margin:0"><span>Time limit (minutes, 0 = no limit)</span><input type="number" id="time" min="0" max="600" inputmode="numeric"></label>
      </div>
      <div class="card">
        <h3>Settings</h3>
        ${sw('shuffleQuestions', 'Shuffle questions', 'Each student gets a different question order')}
        ${sw('shuffleOptions', 'Shuffle answers', 'Answer choices appear in a random order')}
        ${sw('requireFullscreen', 'Lock to full screen', 'Quiz runs full screen; leaving full screen freezes it (where the device supports it)')}
        ${sw('showScore', 'Show score after submitting', 'Students see their mark when they finish')}
      </div>
      <div id="qs"></div>
      <button class="btn block" id="addQ" style="margin-bottom:90px">＋ Add question</button>
    </div>
    <div class="save-bar">
      <a class="btn" href="${quizId ? '#/quiz/' + quizId : '#/'}">Cancel</a>
      <button class="btn primary" id="save">💾 Save</button>
      <button class="btn ok" id="saveStart">▶ Save &amp; start</button>
    </div>`;

  function sw(key, title, sub) {
    return `<label class="switch"><span class="txt"><b>${title}</b><small>${sub}</small></span><input type="checkbox" data-set="${key}"></label>`;
  }

  $('#title').value = quiz.title;
  $('#desc').value = quiz.description || '';
  $('#time').value = quiz.timeLimitMin ?? 0;
  $$('[data-set]').forEach((i) => (i.checked = !!quiz.settings[i.dataset.set]));

  const qs = $('#qs');
  function renderQs() {
    qs.innerHTML = quiz.questions.map((q, i) => `
      <div class="card q-card" data-q="${i}">
        <div class="q-head">
          <span class="q-num">${i + 1}</span>
          <span class="spacer"></span>
          <input class="pts" type="number" min="0" max="100" value="${q.points}" data-f="points" title="Points" aria-label="Points">
          <span class="muted small">pts</span>
          <button class="btn ghost icon" data-a="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn ghost icon" data-a="down" title="Move down" ${i === quiz.questions.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn ghost icon" data-a="delQ" title="Delete question">🗑</button>
        </div>
        <label class="field"><textarea data-f="text" placeholder="Type the question…" rows="2">${esc(q.text)}</textarea></label>
        <div class="muted small" style="margin:-6px 0 8px">Tap the circle to mark the correct answer.</div>
        ${q.options.map((o, j) => `
          <div class="opt" data-o="${j}">
            <input class="correct" type="radio" name="c${q.id}" ${q.correct === o.id ? 'checked' : ''} data-a="correct" aria-label="Mark as correct">
            <input type="text" value="${esc(o.text)}" data-f="opt" placeholder="Answer ${String.fromCharCode(65 + j)}">
            <button class="btn ghost icon" data-a="delO" title="Remove answer" ${q.options.length <= 2 ? 'disabled' : ''}>✕</button>
          </div>`).join('')}
        ${q.options.length < 8 ? '<button class="btn sm" data-a="addO">＋ Answer</button>' : ''}
      </div>`).join('');
  }
  renderQs();

  qs.addEventListener('input', (e) => {
    const card = e.target.closest('[data-q]');
    if (!card) return;
    const q = quiz.questions[+card.dataset.q];
    const f = e.target.dataset.f;
    if (f === 'text') q.text = e.target.value;
    if (f === 'points') q.points = +e.target.value;
    if (f === 'opt') q.options[+e.target.closest('[data-o]').dataset.o].text = e.target.value;
  });
  qs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    const card = e.target.closest('[data-q]');
    if (!b || !card) return;
    const i = +card.dataset.q;
    const q = quiz.questions[i];
    const oi = b.closest('[data-o]') ? +b.closest('[data-o]').dataset.o : -1;
    switch (b.dataset.a) {
      case 'correct': q.correct = q.options[oi].id; return;
      case 'addO': q.options.push({ id: rid(), text: '' }); break;
      case 'delO':
        if (q.correct === q.options[oi].id) q.correct = q.options[oi === 0 ? 1 : 0].id;
        q.options.splice(oi, 1); break;
      case 'delQ':
        if (quiz.questions.length === 1) return toast('A quiz needs at least one question.');
        quiz.questions.splice(i, 1); break;
      case 'up': [quiz.questions[i - 1], quiz.questions[i]] = [quiz.questions[i], quiz.questions[i - 1]]; break;
      case 'down': [quiz.questions[i + 1], quiz.questions[i]] = [quiz.questions[i], quiz.questions[i + 1]]; break;
    }
    renderQs();
  });
  $('#addQ').onclick = () => {
    quiz.questions.push(blankQ());
    renderQs();
    qs.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    qs.lastElementChild.querySelector('textarea').focus();
  };

  $('#save').onclick = () => saveQuiz(false);
  $('#saveStart').onclick = () => saveQuiz(true);
  async function saveQuiz(andStart) {
    const payload = {
      title: $('#title').value.trim(),
      description: $('#desc').value.trim(),
      timeLimitMin: +$('#time').value || 0,
      settings: Object.fromEntries($$('[data-set]').map((i) => [i.dataset.set, i.checked])),
      questions: quiz.questions,
    };
    if (!payload.title) { $('#title').focus(); return toast('Give the quiz a title.'); }
    for (const [i, q] of payload.questions.entries()) {
      if (!q.text.trim()) return toast(`Question ${i + 1} is empty.`);
      const filled = q.options.filter((o) => o.text.trim());
      if (filled.length < 2) return toast(`Question ${i + 1} needs at least 2 answers.`);
      if (!filled.some((o) => o.id === q.correct)) return toast(`Question ${i + 1}: mark a correct answer that isn't empty.`);
    }
    $('#save').disabled = $('#saveStart').disabled = true;
    try {
      if (quizId) await hostApi('PUT', quizId, '', payload);
      else quizId = (await api('POST', '/api/quizzes', payload)).id;
      toast('Saved ✓ — find it any time under My quizzes');
      location.hash = '#/quiz/' + quizId;
      if (andStart) startSession(quizId, payload.title);
    } catch (e) {
      toast(e.message, 'danger');
      $('#save').disabled = $('#saveStart').disabled = false;
    }
  }
}

// ================================================================ monitor
async function renderMonitor(runId) {
  let quiz; // = the session (a snapshot of the saved quiz + code/status)
  try { quiz = await api('GET', '/api/runs/' + runId); } catch (e) {
    view.innerHTML = `<div class="wrap"><div class="card empty"><div class="big">🤷</div><p>${esc(e.message)}</p><a class="btn" href="#/">Back</a></div></div>`;
    return;
  }

  // Build a join link phones can actually reach (swap localhost for the LAN IP).
  // Join link address: the configured public URL (APP_URL / Vercel production domain) wins;
  // on localhost use the LAN IP so phones can reach it; otherwise the address in the browser.
  let origin = location.origin;
  try {
    const net = await api('GET', '/api/net');
    if (net.appUrl) origin = net.appUrl;
    else if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && net.ips[0]) origin = `${location.protocol}//${net.ips[0]}:${location.port || 80}`;
  } catch {}
  const joinUrl = `${origin}/q/${quiz.code}`;

  const attempts = new Map();
  let filter = 'all';
  let search = '';

  view.innerHTML = `
    <div class="wrap wide">
      <a href="#/quiz/${quiz.quizId}" class="muted small" style="text-decoration:none">‹ ${esc(quiz.quizTitle)}</a>
      <div class="row" style="margin:6px 0 14px">
        <div style="flex:1;min-width:0"><h1 style="margin:0">${esc(quiz.title)}${quiz.label ? ` <span class="muted" style="font-weight:500">· ${esc(quiz.label)}</span>` : ''}</h1>
          <div class="muted small">Started ${fmtDate(quiz.startedAt)} · ${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"} · ${quiz.timeLimitMin ? quiz.timeLimitMin + ' min' : 'no time limit'} · <span id="statusB">${runBadge(quiz.status)}</span></div></div>
      </div>
      <div class="row" style="margin-bottom:14px" id="ctrl"></div>

      <div class="card share">
        <div>
          <div class="muted small">Students join with this link or code</div>
          <div class="code-big">${quiz.code}</div>
          <div class="link-box" style="margin:8px 0"><input type="text" readonly value="${esc(joinUrl)}" id="joinUrl"><button class="btn" id="copy">Copy</button></div>
          <div class="row">
            ${navigator.share ? '<button class="btn sm" id="shareBtn">Share…</button>' : ''}

          </div>
        </div>
        <img class="qr" alt="QR code for the join link" src="/api/qr?text=${encodeURIComponent(joinUrl)}">
      </div>

      <div class="stats">
        <div class="stat"><b id="sJoined">0</b><span>Joined</span></div>
        <div class="stat"><b id="sActive">0</b><span>Writing</span></div>
        <div class="stat danger"><b id="sFrozen">0</b><span>Frozen</span></div>
        <div class="stat ok"><b id="sDone">0</b><span>Submitted</span></div>
      </div>

      <div class="row" style="margin-bottom:10px">
        <input type="text" id="search" placeholder="Search name or ID…" style="flex:1;min-width:180px">
      </div>
      <div class="tabs" id="tabs">
        ${['all', 'frozen', 'active', 'submitted'].map((t) => `<button class="btn sm ${t === 'all' ? 'on' : ''}" data-t="${t}">${{ all: 'All', frozen: '🔒 Frozen', active: 'Writing', submitted: 'Submitted' }[t]}</button>`).join('')}
      </div>
      <div class="students" id="students"></div>
      <div style="height:30px"></div>
    </div>`;

  function renderControls() {
    $('#statusB').innerHTML = runBadge(quiz.status);
    $('.share').classList.toggle('ended', quiz.status !== 'open');
    $('#ctrl').innerHTML = `
      ${quiz.status === 'open'
        ? '<button class="btn danger" data-st="closed">■ End session</button>'
        : '<button class="btn" data-st="open">↺ Reopen</button>'}
      <a class="btn" href="/api/runs/${quiz.id}/results.csv">⬇ Results CSV</a>
      <button class="btn ghost" id="delRun">🗑 Delete session</button>`;
  }
  renderControls();

  $('#ctrl').addEventListener('click', async (e) => {
    const st = e.target.closest('[data-st]')?.dataset.st;
    if (st) {
      if (st === 'closed') {
        const r = await modal(`<h2>End this session?</h2><p class="muted">No one new can join. Everyone still writing (including frozen students) is submitted automatically with their current answers. The quiz stays saved, so you can start it again any time.</p>
          <div class="row end"><button class="btn" data-value="no">Cancel</button><button class="btn danger" data-value="yes">End session</button></div>`);
        if (r?.value !== 'yes') return;
      }
      try {
        await api('POST', `/api/runs/${quiz.id}/status`, { status: st });
        quiz.status = st;
        renderControls();
        toast(st === 'open' ? 'Session reopened, students can join with the same code' : 'Session ended');
      } catch (err) { toast(err.message, 'danger'); }
    }
    if (e.target.closest('#delRun')) {
      const r = await modal(`<h2>Delete this session?</h2><p class="muted">This session's student results will be permanently deleted. The saved quiz is kept. This cannot be undone.</p>
        <div class="row end"><button class="btn" data-value="no">Cancel</button><button class="btn danger" data-value="yes">Delete results</button></div>`);
      if (r?.value !== 'yes') return;
      try { await api('DELETE', '/api/runs/' + quiz.id); toast('Session deleted'); location.hash = '#/quiz/' + quiz.quizId; } catch (err) { toast(err.message, 'danger'); }
    }
  });

  $('#copy').onclick = () => copy(joinUrl, 'Join link copied');
  $('#shareBtn')?.addEventListener('click', () => navigator.share({ title: quiz.title, text: `Join "${quiz.title}" (code ${quiz.code})`, url: joinUrl }).catch(() => {}));

  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (!t) return;
    filter = t.dataset.t;
    $$('#tabs .btn').forEach((b) => b.classList.toggle('on', b === t));
    renderStudents();
  });
  $('#search').addEventListener('input', (e) => { search = e.target.value.toLowerCase(); renderStudents(); });

  function renderStudents() {
    const all = [...attempts.values()];
    $('#sJoined').textContent = all.length;
    $('#sActive').textContent = all.filter((a) => a.status === 'active').length;
    $('#sFrozen').textContent = all.filter((a) => a.status === 'frozen').length;
    $('#sDone').textContent = all.filter((a) => a.status === 'submitted').length;

    const rank = { frozen: 0, active: 1, submitted: 2 };
    const list = all
      .filter((a) => filter === 'all' || a.status === filter)
      .filter((a) => !search || a.name.toLowerCase().includes(search) || a.studentId.toLowerCase().includes(search))
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.frozenAt || 0) - (b.frozenAt || 0) || a.name.localeCompare(b.name));

    const box = $('#students');
    if (!list.length) {
      box.innerHTML = `<div class="card empty" style="grid-column:1/-1"><div class="big">${all.length ? '🔍' : '👋'}</div><p>${all.length ? 'No students match.' : quiz.status === 'open' ? 'Waiting for students to join…' : 'This session has ended. No students joined.'}</p></div>`;
      return;
    }
    box.innerHTML = list.map(studentCard).join('');
  }

  function studentCard(a) {
    const pct = a.total ? Math.round((a.answered / a.total) * 100) : 0;
    const viol = a.violations.filter((v) => !v.system).length;
    const badge = a.status === 'frozen' ? '<span class="badge danger">🔒 Frozen</span>'
      : a.status === 'active' ? '<span class="badge primary"><i class="dot"></i>Writing</span>'
      : '<span class="badge ok">✓ Submitted</span>';
    return `
      <div class="card st ${a.status}" data-id="${a.id}">
        <div class="st-top">
          <div class="avatar">${esc(a.name.trim()[0]?.toUpperCase() || '?')}<i class="on ${a.online && a.status !== 'submitted' ? 'yes' : ''}" title="${a.online ? 'Online' : 'Offline'}"></i></div>
          <div class="st-name"><b>${esc(a.name)}</b><span class="muted small">${esc(a.studentId)}${a.attemptNo > 1 ? ` · attempt ${a.attemptNo}` : ''}</span></div>
          ${badge}
          <button class="btn ghost icon" data-act="more" title="More">⋯</button>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="st-foot">
          <span>${a.answered}/${a.total} answered</span>
          ${viol ? `<span style="color:var(--danger)">⚠ ${viol} violation${viol > 1 ? 's' : ''}</span>` : ''}
          ${a.status === 'submitted' && a.score != null ? `<span><b style="color:var(--text)">${a.score}/${a.maxScore}</b> score</span>` : ''}
          ${a.status === 'active' && a.remainingMs != null ? `<span data-rem="${a.id}">⏱ ${fmtTime(a.remainingMs)}</span>` : ''}
        </div>
        ${a.status === 'frozen' ? `
          <div class="freeze-box">${esc(a.freezeReason || 'Left the quiz')} · ${timeAgo(a.frozenAt)}</div>
          <div class="st-actions">
            <button class="btn ok" data-act="resume">▶ Continue</button>
            <button class="btn" data-act="unlock">↻ Restart / options</button>
          </div>` : ''}
      </div>`;
  }

  $('#students').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    const card = e.target.closest('[data-id]');
    if (!b || !card) return;
    const a = attempts.get(card.dataset.id);
    if (!a) return;
    if (b.dataset.act === 'resume') {
      socket.emit('unfreeze', { attemptId: a.id, mode: 'resume' });
      toast(`${a.name} can continue`);
    }
    if (b.dataset.act === 'unlock') unlockSheet(a);
    if (b.dataset.act === 'more') moreSheet(a);
  });

  async function unlockSheet(a) {
    const r = await modal(`
      <h2>Unlock ${esc(a.name)}</h2>
      <p class="muted small">Frozen because: <b>${esc(a.freezeReason || 'left the quiz')}</b></p>
      <label class="choice"><input type="radio" name="mode" value="resume" checked><b>Continue where they left off</b><div class="muted small">Keeps their ${a.answered} answer${a.answered === 1 ? '' : 's'}.</div></label>
      <label class="choice"><input type="radio" name="mode" value="restart"><b>Start again from the beginning</b><div class="muted small">Clears all answers and resets the timer.</div></label>
      <div class="card" style="box-shadow:none;padding:4px 14px">
        <label class="switch"><span class="txt"><b>Shuffle questions</b><small>Continue: reorders unanswered questions · Restart: reorders all</small></span><input type="checkbox" id="shufQ"></label>
        <label class="switch"><span class="txt"><b>Shuffle answers</b><small>Reorder answer choices</small></span><input type="checkbox" id="shufO"></label>
      </div>
      <div class="row end"><button class="btn" data-value="cancel">Cancel</button><button class="btn primary" data-value="go">Unlock</button></div>`);
    if (r?.value !== 'go') return;
    const mode = $('input[name=mode]:checked', r.root).value;
    socket.emit('unfreeze', { attemptId: a.id, mode, shuffleQuestions: $('#shufQ', r.root).checked, shuffleOptions: $('#shufO', r.root).checked });
    toast(mode === 'restart' ? `${a.name} restarted` : `${a.name} can continue`);
  }

  async function moreSheet(a) {
    const log = a.violations.length
      ? `<ul class="log">${a.violations.map((v) => `<li class="${v.system ? 'sys' : ''}"><span>${v.system ? '' : '⚠ '}${esc(v.type)}</span><span class="muted">${new Date(v.at).toLocaleTimeString()}</span></li>`).join('')}</ul>`
      : '<p class="muted">No violations. 👍</p>';
    const r = await modal(`
      <h2>${esc(a.name)}</h2><p class="muted small">${esc(a.studentId)} · joined ${new Date(a.startedAt).toLocaleTimeString()}</p>
      <h3>Activity</h3>${log}
      <div class="row end" style="margin-top:16px">
        ${a.status !== 'submitted' ? '<button class="btn" data-value="submit">Submit now</button>' : ''}
        <button class="btn danger" data-value="remove">Remove student</button>
        <button class="btn" data-value="close">Close</button>
      </div>`);
    if (r?.value === 'submit') socket.emit('forceSubmit', { attemptId: a.id });
    if (r?.value === 'remove') {
      const c = await modal(`<h2>Remove ${esc(a.name)}?</h2><p class="muted">Their attempt and answers are deleted. They can then join again with the same student ID.</p>
        <div class="row end"><button class="btn" data-value="no">Cancel</button><button class="btn danger" data-value="yes">Remove</button></div>`);
      if (c?.value === 'yes') socket.emit('remove', { attemptId: a.id });
    }
  }

  // ---- live connection
  const socket = io({ auth: { role: 'host', runId: quiz.id } });
  socket.on('attempts', (list) => { attempts.clear(); list.forEach((a) => attempts.set(a.id, a)); renderStudents(); });
  socket.on('attempt', (a) => {
    const first = !attempts.has(a.id);
    attempts.set(a.id, a);
    renderStudents();
  });
  socket.on('removed', (id) => { attempts.delete(id); renderStudents(); });
  socket.on('alert', ({ name, reason }) => {
    toast(`🔒 ${name} — ${reason}`, 'danger');
    beep();
    navigator.vibrate?.([120, 60, 120]);
  });
  socket.on('connect_error', () => toast('Connection lost — retrying…', 'danger'));

  // tick timers locally between server updates
  const tick = setInterval(() => {
    for (const a of attempts.values()) {
      if (a.status === 'active' && a.remainingMs != null) {
        a.remainingMs = Math.max(0, a.remainingMs - 1000);
        const el = document.querySelector(`[data-rem="${a.id}"]`);
        if (el) el.textContent = '⏱ ' + fmtTime(a.remainingMs);
      }
    }
  }, 1000);
  cleanup = () => { socket.disconnect(); clearInterval(tick); };
}

function copy(text, msg) {
  navigator.clipboard?.writeText(text).then(() => toast(msg), () => prompt('Copy this:', text));
}

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.35);
  } catch {}
}

// start (after all helpers are defined): restore the session, then route
api('GET', '/api/auth/me')
  .then((u) => { me = u; return claimOldQuizzes(); })
  .catch(() => {})
  .finally(route);
