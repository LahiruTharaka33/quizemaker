// Downloads: a quiz's questions + answer key (Excel / CSV) and a session's results workbook (Excel).
const ExcelJS = require('exceljs');

const L = (i) => String.fromCharCode(65 + i);

// CSV cell, safe to open in Excel: values starting with = + - @ (or tab/CR) would be run as formulas,
// so they get a leading apostrophe (e.g. a student who types "=HYPERLINK(...)" as their name).
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

const fileName = (...parts) => parts.filter(Boolean).join('_').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'quiz';
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// colours
const C = { head: 'FF4F46E5', headText: 'FFFFFFFF', ok: 'FFDCF5E8', okText: 'FF0F7A47', bad: 'FFFDE2E4', badText: 'FFB4232D', blank: 'FFF1F2F6', muted: 'FF6B7085', key: 'FFE9FBF1' };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: C.headText } };
  row.fill = fill(C.head);
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

module.exports = function makeDownloads({ correctSet, markQuestion, attemptsOf, elapsed }) {
  // ---------------------------------------------------------------- quiz: questions + answer key
  function quizTable(quiz) {
    const maxOpts = Math.max(2, ...quiz.questions.map((q) => q.options.length));
    const head = ['#', 'Question', ...Array.from({ length: maxOpts }, (_, i) => `Option ${L(i)}`), 'Correct answer(s)', 'Correct answer text', 'Points'];
    const rows = quiz.questions.map((q, i) => {
      const keys = correctSet(q);
      const letters = q.options.map((o, j) => (keys.includes(o.id) ? L(j) : null)).filter(Boolean);
      return [
        i + 1, q.text,
        ...Array.from({ length: maxOpts }, (_, j) => q.options[j]?.text ?? ''),
        q.freePoints ? 'Any (free points)' : letters.join(', '),
        q.options.filter((o) => keys.includes(o.id)).map((o) => o.text).join(' | '),
        q.points,
      ];
    });
    return { head, rows, maxOpts };
  }

  function quizCsv(quiz) {
    const { head, rows } = quizTable(quiz);
    return { name: fileName(quiz.title, 'questions') + '.csv', body: toCsv([head, ...rows]) };
  }

  async function quizXlsx(quiz) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'QuizLock';
    wb.created = new Date();
    const { head, rows, maxOpts } = quizTable(quiz);

    const ws = wb.addWorksheet('Questions');
    ws.columns = [
      { width: 5 }, { width: 50 },
      ...Array.from({ length: maxOpts }, () => ({ width: 24 })),
      { width: 16 }, { width: 30 }, { width: 8 },
    ];
    ws.addRow(head);
    styleHeader(ws);
    rows.forEach((r, i) => {
      const row = ws.addRow(r);
      row.alignment = { vertical: 'top', wrapText: true };
      const q = quiz.questions[i];
      const keys = correctSet(q);
      // highlight the correct option cells in green
      q.options.forEach((o, j) => {
        if (keys.includes(o.id) && !q.freePoints) {
          const cell = row.getCell(3 + j);
          cell.fill = fill(C.ok);
          cell.font = { bold: true, color: { argb: C.okText } };
        }
      });
      row.getCell(3 + maxOpts).font = { bold: true, color: { argb: C.okText } };
    });

    const info = wb.addWorksheet('Quiz info');
    info.columns = [{ width: 26 }, { width: 70 }];
    const totalPts = quiz.questions.reduce((s, q) => s + q.points, 0);
    [
      ['Title', quiz.title],
      ['Instructions', quiz.description || ''],
      ['Questions', quiz.questions.length],
      ['Total points', totalPts],
      ['Time limit', quiz.timeLimitMin ? `${quiz.timeLimitMin} min` : 'No limit'],
      ['Shuffle questions', quiz.settings?.shuffleQuestions ? 'Yes' : 'No'],
      ['Shuffle answers', quiz.settings?.shuffleOptions ? 'Yes' : 'No'],
      ['Lock to full screen', quiz.settings?.requireFullscreen ? 'Yes' : 'No'],
      ['Show score after submitting', quiz.settings?.showScore ? 'Yes' : 'No'],
      ['Exported', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
    ].forEach(([k, v]) => {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
      row.alignment = { vertical: 'top', wrapText: true };
    });

    return { name: fileName(quiz.title, 'questions') + '.xlsx', body: await wb.xlsx.writeBuffer() };
  }

  // ---------------------------------------------------------------- session results workbook
  async function resultsXlsx(run) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'QuizLock';
    wb.created = new Date();
    const qs = run.questions;
    const atts = attemptsOf(run.id).slice().sort((a, b) => a.name.localeCompare(b.name));
    const marks = new Map(atts.map((a) => [a.id, Object.fromEntries(qs.map((q) => [q.id, markQuestion(q, a)]))]));
    const maxPts = qs.reduce((s, q) => s + q.points, 0);
    const scoreOf = (a) => qs.reduce((s, q) => s + marks.get(a.id)[q.id].earned, 0);
    const statusText = { submitted: 'Submitted', active: 'Writing', frozen: 'Frozen', waiting: 'Waiting' };
    const day = new Date(run.startedAt);

    // ---- Summary
    const sum = wb.addWorksheet('Summary');
    sum.columns = [
      { header: 'Name', width: 26 }, { header: 'Student ID', width: 14 }, { header: 'Status', width: 11 },
      { header: 'Score', width: 8 }, { header: 'Max', width: 7 }, { header: '%', width: 7 },
      { header: 'Correct', width: 9 }, { header: 'Answered', width: 10 }, { header: 'Time taken', width: 11 },
      { header: 'Violations', width: 10 }, { header: 'Violation details', width: 40 }, { header: 'Attempt #', width: 10 },
      { header: 'Started', width: 18 }, { header: 'Submitted', width: 18 },
    ];
    styleHeader(sum);
    for (const a of atts) {
      const score = scoreOf(a);
      const v = a.violations.filter((x) => !x.system);
      const row = sum.addRow([
        a.name, a.studentId, statusText[a.status] || a.status,
        score, maxPts, maxPts ? score / maxPts : 0,
        qs.filter((q) => marks.get(a.id)[q.id].correct).length,
        qs.filter((q) => a.answers[q.id]).length,
        fmtDuration(elapsed(a)), v.length, v.map((x) => x.type).join('; '), a.attemptNo,
        a.startedAt ? new Date(a.startedAt) : null, a.submittedAt ? new Date(a.submittedAt) : null,
      ]);
      row.getCell(6).numFmt = '0%';
      row.getCell(13).numFmt = 'yyyy-mm-dd hh:mm';
      row.getCell(14).numFmt = 'yyyy-mm-dd hh:mm';
      if (v.length) row.getCell(10).font = { bold: true, color: { argb: C.badText } };
      if (a.status !== 'submitted') row.getCell(3).font = { italic: true, color: { argb: C.muted } };
    }
    if (atts.length) {
      const done = atts.filter((a) => a.status === 'submitted');
      sum.addRow([]);
      const avg = done.length ? done.reduce((s, a) => s + scoreOf(a), 0) / done.length : 0;
      const r = sum.addRow(['Class average (submitted)', '', `${done.length} of ${atts.length}`, Math.round(avg * 10) / 10, maxPts, maxPts ? avg / maxPts : 0]);
      r.font = { bold: true };
      r.getCell(6).numFmt = '0%';
    }
    sum.autoFilter = { from: 'A1', to: 'N1' };

    // ---- Answers: student x question grid, green = right, red = wrong
    const ans = wb.addWorksheet('Answers');
    ans.columns = [{ width: 26 }, { width: 14 }, { width: 8 }, ...qs.map(() => ({ width: 22 }))];
    ans.addRow(['Name', 'Student ID', 'Score', ...qs.map((q, i) => `Q${i + 1}. ${q.text.length > 60 ? q.text.slice(0, 57) + '…' : q.text}`)]);
    styleHeader(ans);
    ans.getRow(1).height = 48;
    ans.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    for (const a of atts) {
      const cells = qs.map((q) => {
        const m = marks.get(a.id)[q.id];
        const j = q.options.findIndex((o) => o.id === m.chosen);
        let t = j >= 0 ? `${L(j)}. ${q.options[j].text}` : '(not answered)';
        if (m.source === 'override') t += m.correct ? '  ✓ by lecturer' : '  ✗ by lecturer';
        if (m.source === 'free') t += '  (free points)';
        return t;
      });
      const row = ans.addRow([a.name, a.studentId, `${scoreOf(a)}/${maxPts}`, ...cells]);
      qs.forEach((q, i) => {
        const m = marks.get(a.id)[q.id];
        const cell = row.getCell(4 + i);
        cell.alignment = { wrapText: true, vertical: 'top' };
        if (m.correct) { cell.fill = fill(C.ok); cell.font = { color: { argb: C.okText } }; }
        else if (m.chosen) { cell.fill = fill(C.bad); cell.font = { color: { argb: C.badText } }; }
        else { cell.fill = fill(C.blank); cell.font = { italic: true, color: { argb: C.muted } }; }
      });
    }
    ans.addRow([]);
    ans.addRow(['Green = correct · Red = wrong · Grey = not answered']).font = { italic: true, color: { argb: C.muted } };

    // ---- Questions: key + how the class did (submitted students)
    const pool = atts.filter((a) => a.status === 'submitted');
    const maxOpts = Math.max(2, ...qs.map((q) => q.options.length));
    const qws = wb.addWorksheet('Questions');
    qws.columns = [
      { width: 5 }, { width: 48 }, { width: 8 }, { width: 22 }, { width: 10 }, { width: 10 },
      ...Array.from({ length: maxOpts }, () => ({ width: 18 })), { width: 13 },
    ];
    qws.addRow(['#', 'Question', 'Points', 'Correct answer(s)', 'Correct', '% correct',
      ...Array.from({ length: maxOpts }, (_, i) => `Chose ${L(i)}`), 'Not answered']);
    styleHeader(qws);
    qs.forEach((q, i) => {
      const keys = correctSet(q);
      const right = pool.filter((a) => marks.get(a.id)[q.id].correct).length;
      const row = qws.addRow([
        i + 1, q.text, q.points,
        q.freePoints ? 'Any (free points)' : q.options.map((o, j) => (keys.includes(o.id) ? `${L(j)}. ${o.text}` : null)).filter(Boolean).join('\n'),
        pool.length ? `${right}/${pool.length}` : '', pool.length ? right / pool.length : null,
        ...Array.from({ length: maxOpts }, (_, j) => (q.options[j] ? `${pool.filter((a) => marks.get(a.id)[q.id].chosen === q.options[j].id).length} · ${q.options[j].text}` : '')),
        pool.filter((a) => !marks.get(a.id)[q.id].chosen).length,
      ]);
      row.alignment = { vertical: 'top', wrapText: true };
      row.getCell(6).numFmt = '0%';
      const pct = pool.length ? right / pool.length : null;
      if (pct != null) row.getCell(6).fill = fill(pct >= 0.7 ? C.ok : pct >= 0.4 ? 'FFFFF1D6' : C.bad);
      q.options.forEach((o, j) => { if (keys.includes(o.id)) row.getCell(7 + j).fill = fill(C.key); });
    });
    qws.addRow([]);
    qws.addRow(['', `Based on ${pool.length} submitted student${pool.length === 1 ? '' : 's'}. Green "Chose" cells are correct options.`]).font = { italic: true, color: { argb: C.muted } };

    const name = fileName(run.title, run.label, day.toISOString().slice(0, 10), 'results') + '.xlsx';
    return { name, body: await wb.xlsx.writeBuffer() };
  }

  return { csvCell, quizCsv, quizXlsx, resultsXlsx };
};
