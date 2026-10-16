/* ============================================================
   综合考核系统 —— 随机组卷 / 自动判分 / 错题回溯
   题库：军事技能训练理论 · 学生手册 · 安全知识
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 抽题规则（严格按要求配置） ---------- */
  var RULES = [
    { bank: 'saf', total: 4,  multi: null },  // 安全知识：4 题（不限题型）
    { bank: 'mil', total: 23, multi: 6    },  // 军事技能训练理论：23 题，其中 6 道多选
    { bank: 'stu', total: 13, multi: 4    },  // 学生手册：13 题，其中 4 道多选
  ];
  var PER_SCORE  = 2.5;                        // 每题 2.5 分
  var FULL_SCORE = 100;                        // 满分 100 分
  var PASS_SCORE = 60;                         // 及格线
  var TOTAL_Q    = RULES.reduce(function (n, r) { return n + r.total; }, 0); // 40
  var BANK_META  = window.BANK_META || {};
  var BANKS      = window.BANKS || {};

  /* ---------- 工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sameSet(x, y) {
    if (x.length !== y.length) return false;
    var a = x.slice().sort().join(''), b = y.slice().sort().join('');
    return a === b;
  }

  function letters(arr) { return arr.length ? arr.slice().sort().join('') : ''; }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtDate(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtStamp(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function lsGet(k, dft) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dft; } catch (e) { return dft; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  /* 触发浏览器下载 */
  function download(filename, content, mime) {
    var blob = new Blob(['\ufeff' + content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /* ---------- 模态框 ---------- */
  var modalResolve = null;
  function confirmBox(title, text, okText, cancelText) {
    $('modal-title').textContent = title;
    $('modal-text').innerHTML = text;
    $('modal-ok').textContent = okText || '确定';
    $('modal-cancel').textContent = cancelText || '取消';
    $('modal-mask').classList.add('open');
    return new Promise(function (res) { modalResolve = res; });
  }
  function closeModal(v) {
    $('modal-mask').classList.remove('open');
    if (modalResolve) { modalResolve(v); modalResolve = null; }
  }
  $('modal-ok').addEventListener('click', function () { closeModal(true); });
  $('modal-cancel').addEventListener('click', function () { closeModal(false); });
  $('modal-mask').addEventListener('click', function (e) {
    if (e.target === $('modal-mask')) closeModal(false);
  });

  /* ---------- 组卷 ---------- */
  function buildPaper(mode) {
    var paper = [];
    RULES.forEach(function (rule) {
      var pool = BANKS[rule.bank] || [];
      var singles = pool.filter(function (x) { return x.t !== 'M'; });
      var multis  = pool.filter(function (x) { return x.t === 'M'; });

      if (rule.multi === null) {                       // 不限题型
        shuffle(pool.slice()).slice(0, rule.total).forEach(function (q) {
          paper.push(makeItem(rule.bank, q));
        });
      } else {
        var needM = Math.min(rule.multi, multis.length);
        var needS = Math.min(rule.total - needM, singles.length);
        var picked = shuffle(multis.slice()).slice(0, needM)
          .concat(shuffle(singles.slice()).slice(0, needS));
        shuffle(picked).forEach(function (q) { paper.push(makeItem(rule.bank, q)); });
      }
    });

    if (mode === 'grouped') {
      var order = ['saf', 'mil', 'stu'];
      paper.sort(function (a, b) { return order.indexOf(a.bank) - order.indexOf(b.bank); });
    } else {
      shuffle(paper);
    }
    return paper;
  }

  function makeItem(bank, q) {
    return {
      bank: bank,
      type: q.t === 'M' ? 'M' : 'S',
      stem: q.q,
      options: q.o,          // [[label, text], ...]
      answer: q.a.slice(),   // ['A','B', ...]
      picked: []
    };
  }

  function signature(paper) {
    return paper.map(function (it) { return it.bank + '|' + it.stem; }).sort().join('~');
  }

  var lastSig = '';
  function newPaper(mode) {
    var paper, sig, tries = 0;
    do {
      paper = buildPaper(mode);
      sig = signature(paper);
      tries++;
    } while (sig === lastSig && tries < 8);
    lastSig = sig;
    return paper;
  }

  /* ---------- 状态 ---------- */
  var LS_ID = 'quiz.examinee';
  var LS_REC = 'quiz.records';

  var S = {
    mode: 'random',
    examinee: { name: '', cls: '', sid: '' },
    paper: [],
    idx: 0,
    answeredAt: {},
    startAt: 0,
    timer: null,
    elapsed: 0,
    graded: false,
    filter: 'wrong',
    result: null,
    finishedAt: '',
  };

  /* ---------- 首页 ---------- */
  function renderStart() {
    var cards = [
      { k: '全卷题量', v: TOTAL_Q, s: '题' },
      { k: '每题分值', v: PER_SCORE, s: '分' },
      { k: '试卷满分', v: FULL_SCORE, s: '分' },
      { k: '题库总量', v: (BANKS.mil || []).length + (BANKS.stu || []).length + (BANKS.saf || []).length, s: '题（三库合并）' },
    ];
    $('start-stats').innerHTML = cards.map(function (c) {
      return '<div class="stat"><div class="k">' + esc(c.k) + '</div>' +
        '<div class="v">' + esc(c.v) + '<em> ' + esc(c.s) + '</em></div></div>';
    }).join('');

    var rows = RULES.map(function (r) {
      var m = BANK_META[r.bank] || { name: r.bank };
      var pool = BANKS[r.bank] || [];
      var multiPool = pool.filter(function (x) { return x.t === 'M'; }).length;
      var typeTxt = r.multi === null
        ? '随机抽 ' + r.total + ' 题（单选/多选不限）'
        : '随机抽 ' + r.total + ' 题，其中多选 ' + r.multi + ' 题、单选 ' + (r.total - r.multi) + ' 题';
      return '<li><b>' + esc(m.name) + '</b>：' + typeTxt +
        '　<span class="hint">（题库 ' + pool.length + ' 题，含多选 ' + multiPool + ' 题）</span></li>';
    }).join('');
    $('start-rules').innerHTML = rows;

    // 选项顺序切换
    $('order-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
      S.mode = b.dataset.mode;
    });

    // 恢复上次填写的考生信息
    var saved = lsGet(LS_ID, null);
    if (saved) {
      if (saved.name) $('in-name').value = saved.name;
      if (saved.cls) $('in-class').value = saved.cls;
      if (saved.sid) $('in-id').value = saved.sid;
    }
    ['in-name', 'in-class', 'in-id'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        this.classList.remove('bad');
        $('id-hint').classList.remove('err');
        $('id-hint').textContent = '姓名、班级、学号会写入考核成绩单，请核对无误后开始答题。';
      });
    });
    renderHistory();
  }

  /* ---------- 考生信息 ---------- */
  var ID_HINT = '姓名、班级、学号会写入考核成绩单，请核对无误后开始答题。';

  function readIdentity() {
    var v = {
      name: $('in-name').value.trim(),
      cls: $('in-class').value.trim(),
      sid: $('in-id').value.trim(),
    };
    var bad = [];
    if (!v.name) bad.push('姓名');
    else if (v.name.length < 2) bad.push('姓名（至少 2 个字）');
    if (!v.cls) bad.push('班级');
    if (!v.sid) bad.push('学号');
    else if (!/^[0-9A-Za-z\-]{4,24}$/.test(v.sid)) bad.push('学号（4~24 位数字或字母）');

    $('in-name').classList.toggle('bad', !v.name || v.name.length < 2);
    $('in-class').classList.toggle('bad', !v.cls);
    $('in-id').classList.toggle('bad', !v.sid || !/^[0-9A-Za-z\-]{4,24}$/.test(v.sid));

    if (bad.length) {
      $('id-hint').classList.add('err');
      $('id-hint').textContent = '请填写正确的：' + bad.join('、');
      var first = $('in-name').classList.contains('bad') ? $('in-name')
        : ($('in-class').classList.contains('bad') ? $('in-class') : $('in-id'));
      first.focus();
      toast('请先完善考生信息');
      return null;
    }
    $('id-hint').classList.remove('err');
    $('id-hint').textContent = ID_HINT;
    return v;
  }

  /* ---------- 历史考核记录 ---------- */
  function saveRecord(rec) {
    var list = lsGet(LS_REC, []);
    list.unshift(rec);
    if (list.length > 200) list = list.slice(0, 200);
    lsSet(LS_REC, list);
  }

  function renderHistory() {
    var list = lsGet(LS_REC, []);
    var box = $('history-box');
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="rowline"><h2>历史考核记录</h2>' +
      '<span class="hint">本机共 ' + list.length + ' 条（保存在浏览器本地）</span>' +
      '<div class="spacer"></div>' +
      '<button class="btn btn-ghost" id="btn-csv">导出汇总表（CSV）</button>' +
      '<button class="btn btn-ghost" id="btn-clear">清空记录</button></div>' +
      '<div class="btable"><table><thead><tr>' +
      '<th>考试时间</th><th>姓名</th><th>班级</th><th>学号</th>' +
      '<th>得分</th><th>答对</th><th>答错</th><th>未答</th><th>用时</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><td class="num">' + esc(r.time) + '</td><td>' + esc(r.name) +
          '</td><td>' + esc(r.cls) + '</td><td class="who num">' + esc(r.sid) +
          '</td><td class="num">' + r.score + '</td><td class="num">' + r.right +
          '</td><td class="num">' + r.wrong + '</td><td class="num">' + r.blank +
          '</td><td class="num">' + esc(r.used) + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';

    $('btn-csv').addEventListener('click', exportCsv);
    $('btn-clear').addEventListener('click', function () {
      confirmBox('清空记录', '将删除本机保存的全部考核记录，确定吗？', '清空', '取消')
        .then(function (ok) { if (ok) { lsSet(LS_REC, []); renderHistory(); toast('已清空'); } });
    });
  }

  function exportCsv() {
    var list = lsGet(LS_REC, []);
    if (!list.length) { toast('暂无记录'); return; }
    var head = ['考试时间', '姓名', '班级', '学号', '得分', '答对', '答错', '未作答', '用时', '正确率'];
    var rows = list.map(function (r) {
      return [r.time, r.name, r.cls, r.sid, r.score, r.right, r.wrong, r.blank, r.used, r.rate];
    });
    var csv = [head].concat(rows).map(function (row) {
      return row.map(function (c) {
        c = String(c == null ? '' : c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\r\n');
    download('考核成绩汇总表_' + fmtStamp() + '.csv', csv, 'text/csv');
    toast('汇总表已导出');
  }

  /* ---------- 屏幕切换 ---------- */
  function show(name) {
    ['screen-start', 'screen-exam', 'screen-result'].forEach(function (id) {
      $(id).classList.toggle('active', id === 'screen-' + name);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ---------- 开始考试 ---------- */
  function beginExam() {
    var id = readIdentity();
    if (!id) return;                 // 信息不完整，阻止进入考试
    S.examinee = id;
    lsSet(LS_ID, id);
    startExam();
  }

  function startExam() {
    S.paper = newPaper(S.mode);
    S.idx = 0;
    S.graded = false;
    S.filter = 'wrong';
    S.startAt = Date.now();
    S.elapsed = 0;
    Array.prototype.forEach.call($('filter-seg').children, function (c) {
      c.classList.toggle('on', c.dataset.f === 'wrong');
    });
    $('btn-submit').disabled = false;
    $('btn-submit-top').disabled = false;
    $('pill-who').textContent = S.examinee.name + ' · ' + S.examinee.cls + ' · ' + S.examinee.sid;
    startTimer();
    show('exam');
    renderExam();
  }

  function startTimer() {
    clearInterval(S.timer);
    updateTimer();
    S.timer = setInterval(function () {
      S.elapsed = Math.floor((Date.now() - S.startAt) / 1000);
      updateTimer();
    }, 1000);
  }
  function updateTimer() { $('pill-timer').textContent = '用时 ' + fmtTime(S.elapsed); }
  function stopTimer() { clearInterval(S.timer); S.timer = null; }

  /* ---------- 渲染答题页 ---------- */
  function renderExam() {
    var item = S.paper[S.idx];
    if (!item) return;
    var meta = BANK_META[item.bank] || { short: item.bank };
    var isMulti = item.type === 'M';

    var html = '';
    html += '<div class="qhead">';
    html += '<span class="qno">第 ' + (S.idx + 1) + ' 题 / ' + TOTAL_Q + '</span>';
    html += '<span class="tag ' + (isMulti ? 'tag-multi' : 'tag-single') + '">' +
      (isMulti ? '多选' : '单选') + '</span>';
    html += '<span class="tag tag-bank">' + esc(meta.short) + '</span>';
    html += '</div>';
    html += '<div class="qstem">' + esc(item.stem) + '</div>';
    html += '<div class="opts">';
    item.options.forEach(function (o, i) {
      var on = item.picked.indexOf(o[0]) > -1;
      html += '<button type="button" class="opt' + (on ? ' on' : '') + '" data-opt="' + esc(o[0]) + '">' +
        '<span class="box' + (isMulti ? '' : ' round') + '">' + esc(o[0]) + '</span>' +
        '<span class="txt">' + esc(o[1]) + '</span></button>';
    });
    html += '</div>';
    html += '<div class="qnav">' +
      '<button class="btn btn-ghost" id="btn-prev"' + (S.idx === 0 ? ' disabled' : '') + '>上一题</button>' +
      '<span class="hint">' + (isMulti ? '多选题：可选择多个选项' : '单选题：选择 1 个选项') + '</span>' +
      '<div class="spacer"></div>' +
      '<span class="hint">按 <kbd>A</kbd>~<kbd>H</kbd> 或 <kbd>1</kbd>~<kbd>8</kbd> 选择，<kbd>←</kbd><kbd>→</kbd> 翻页</span>' +
      '<button class="btn ' + (S.idx === TOTAL_Q - 1 ? 'btn-ghost' : 'btn-primary') + '" id="btn-next">' +
      (S.idx === TOTAL_Q - 1 ? '最后一题' : '下一题') + '</button>' +
      '</div>';

    $('qcard').innerHTML = html;

    $('qcard').querySelector('.opts').addEventListener('click', function (e) {
      var btn = e.target.closest('.opt'); if (!btn) return;
      pick(btn.dataset.opt);
    });
    $('btn-prev').addEventListener('click', function () { go(S.idx - 1); });
    $('btn-next').addEventListener('click', function () { go(S.idx + 1); });

    renderCards();
    renderProgress();
  }

  function renderCards() {
    $('cards').innerHTML = S.paper.map(function (it, i) {
      var cls = 'cell' + (it.picked.length ? ' done' : '') + (i === S.idx ? ' cur' : '');
      return '<button class="' + cls + '" data-i="' + i + '">' + (i + 1) + '</button>';
    }).join('');
  }

  function renderProgress() {
    var done = S.paper.filter(function (it) { return it.picked.length; }).length;
    $('pill-progress').innerHTML = '已答 <b>' + done + '</b>/' + TOTAL_Q;
    $('bar-fill').style.width = (done / TOTAL_Q * 100) + '%';
  }

  $('cards').addEventListener('click', function (e) {
    var b = e.target.closest('.cell'); if (!b) return;
    go(parseInt(b.dataset.i, 10));
  });

  function pick(label) {
    var item = S.paper[S.idx];
    if (S.graded) return;
    if (item.type === 'M') {
      var i = item.picked.indexOf(label);
      if (i > -1) item.picked.splice(i, 1); else item.picked.push(label);
    } else {
      item.picked = [label];
    }
    S.answeredAt[S.idx] = Date.now();
    renderExam();
  }

  function go(i) {
    if (i < 0 || i >= TOTAL_Q) return;
    S.idx = i;
    renderExam();
  }

  /* ---------- 交卷与判分 ---------- */
  function submit() {
    var blank = S.paper.filter(function (it) { return !it.picked.length; }).length;
    var tip = blank
      ? '还有 <b>' + blank + '</b> 道题未作答，未作答的题目将按答错计分。<br>确定现在交卷吗？'
      : '确定交卷并判分吗？';
    confirmBox('交卷确认', tip, '确定交卷', '继续答题').then(function (ok) {
      if (ok) grade();
    });
  }

  function grade() {
    stopTimer();
    S.elapsed = Math.floor((Date.now() - S.startAt) / 1000);
    S.finishedAt = fmtDate();
    S.graded = true;

    var right = 0, wrong = 0, blank = 0, items = [];
    var byBank = {};
    S.paper.forEach(function (it, i) {
      var ok = it.picked.length > 0 && sameSet(it.picked, it.answer);
      var blankQ = it.picked.length === 0;
      if (ok) right++; else { wrong++; if (blankQ) blank++; }
      items.push({ no: i + 1, item: it, ok: ok, blank: blankQ });

      var b = byBank[it.bank] || (byBank[it.bank] = { total: 0, right: 0, wrong: 0 });
      b.total++;
      if (ok) b.right++; else b.wrong++;
    });

    var score = right * PER_SCORE;
    S.result = {
      score: score, right: right, wrong: wrong, blank: blank,
      items: items, byBank: byBank,
    };

    saveRecord({
      time: S.finishedAt,
      name: S.examinee.name, cls: S.examinee.cls, sid: S.examinee.sid,
      score: Math.round(score * 100) / 100, right: right, wrong: wrong, blank: blank,
      used: fmtTime(S.elapsed), rate: Math.round(right / TOTAL_Q * 100) + '%',
    });

    renderResult();
    show('result');
  }

  /* ---------- 渲染结果页 ---------- */
  function renderResult() {
    var R = S.result;
    var score = R.score;

    // 得分环
    var r = 76, C = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(1, score / FULL_SCORE));
    var color = score >= PASS_SCORE ? '#12915b' : '#d33a3a';
    $('ring').innerHTML =
      '<svg width="176" height="176" viewBox="0 0 176 176">' +
      '<circle cx="88" cy="88" r="' + r + '" fill="none" stroke="#e6ebf4" stroke-width="14"/>' +
      '<circle cx="88" cy="88" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="14" ' +
      'stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - pct)) + '"/>' +
      '</svg>' +
      '<div class="val"><b style="color:' + color + '">' + (score % 1 === 0 ? score : score.toFixed(1)) + '</b>' +
      '<span>满分 ' + FULL_SCORE + ' 分</span></div>';

    // 评语
    var verdict, sub;
    if (score >= 100)      { verdict = '满分通关 🎉'; sub = '全部答对，题库已经拿下了。'; }
    else if (score >= 90)  { verdict = '优秀'; sub = '基础非常扎实，把错题再过一遍就完美了。'; }
    else if (score >= 80)  { verdict = '良好'; sub = '掌握得不错，重点巩固下方错题即可。'; }
    else if (score >= PASS_SCORE) { verdict = '及格'; sub = '已通过，建议逐题研读错题回溯。'; }
    else                   { verdict = '未及格'; sub = '别急，先按错题回溯逐题复盘，再重新抽一套练手。'; }
    $('verdict').textContent = verdict + '　·　得分 ' + (score % 1 === 0 ? score : score.toFixed(1)) + ' 分';
    $('verdict-sub').textContent = sub;

    $('examinee-line').innerHTML =
      '<span>姓名：<b>' + esc(S.examinee.name) + '</b></span>' +
      '<span>班级：<b>' + esc(S.examinee.cls) + '</b></span>' +
      '<span>学号：<b>' + esc(S.examinee.sid) + '</b></span>' +
      '<span>用时：<b>' + fmtTime(S.elapsed) + '</b></span>' +
      '<span>交卷时间：<b>' + esc(S.finishedAt) + '</b></span>';

    $('score-grid').innerHTML =
      '<div class="s ok"><b>' + R.right + '</b><span>答对</span></div>' +
      '<div class="s bad"><b>' + R.wrong + '</b><span>答错</span></div>' +
      '<div class="s"><b>' + R.blank + '</b><span>未作答</span></div>' +
      '<div class="s"><b>' + (R.right / TOTAL_Q * 100).toFixed(0) + '%</b><span>正确率</span></div>';

    renderBankTable();

    $('review-count').textContent = '共答错 ' + R.wrong + ' 题' + (R.blank ? '（其中未作答 ' + R.blank + ' 题）' : '');
    renderReview();
  }

  /* 分题库得分表 */
  function renderBankTable() {
    var byBank = S.result.byBank;
    var order = RULES.map(function (r) { return r.bank; });
    var rows = '', tRight = 0, tWrong = 0, tScore = 0;
    order.forEach(function (key) {
      var b = byBank[key];
      if (!b) return;
      var meta = BANK_META[key] || { name: key };
      var s = b.right * PER_SCORE;
      tRight += b.right; tWrong += b.wrong; tScore += s;
      rows += '<tr><td>' + esc(meta.name) + '</td>' +
        '<td class="num">' + b.total + '</td>' +
        '<td class="num">' + b.right + '</td>' +
        '<td class="num">' + b.wrong + '</td>' +
        '<td class="num">' + (s % 1 === 0 ? s : s.toFixed(1)) + '</td></tr>';
    });
    rows += '<tr class="total"><td>合计</td><td class="num">' + (tRight + tWrong) +
      '</td><td class="num">' + tRight + '</td><td class="num">' + tWrong +
      '</td><td class="num">' + (tScore % 1 === 0 ? tScore : tScore.toFixed(1)) + '</td></tr>';

    $('bank-table').innerHTML = '<div class="btable"><table><thead><tr>' +
      '<th>来源题库</th><th>抽题数</th><th>答对</th><th>答错</th><th>得分</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderReview() {
    var R = S.result;
    var list = S.filter === 'all' ? R.items : R.items.filter(function (x) { return !x.ok; });
    if (!list.length) {
      $('review-list').innerHTML = '<div class="review right"><div class="rhead">' +
        '<span class="verdict-chip good">全部正确</span></div>' +
        '<div class="stem">本套试卷没有错题，太棒了！</div></div>';
      return;
    }
    $('review-list').innerHTML = list.map(function (rec) {
      var it = rec.item;
      var meta = BANK_META[it.bank] || { short: it.bank };
      var isMulti = it.type === 'M';
      var picked = it.picked;

      var opts = it.options.map(function (o) {
        var isAns = it.answer.indexOf(o[0]) > -1;
        var isPick = picked.indexOf(o[0]) > -1;
        var cls = 'ropt' + (isAns ? ' correct' : (isPick ? ' chosen-wrong' : ''));
        var bk = '';
        if (isAns) bk = '<span class="rb ok">正确答案</span>';
        else if (isPick) bk = '<span class="rb no">误选</span>';
        return '<div class="' + cls + '"><span class="lb">' + esc(o[0]) + '</span>' +
          '<span>' + esc(o[1]) + '</span>' + bk + '</div>';
      }).join('');

      var your = picked.length ? letters(picked) : '未作答';
      var okAns = letters(it.answer);

      return '<div class="review ' + (rec.ok ? 'right' : 'wrong') + '">' +
        '<div class="rhead">' +
        '<span class="qno">第 ' + rec.no + ' 题</span>' +
        '<span class="tag ' + (isMulti ? 'tag-multi' : 'tag-single') + '">' + (isMulti ? '多选' : '单选') + '</span>' +
        '<span class="tag tag-bank">' + esc(meta.name) + '</span>' +
        '<span class="verdict-chip ' + (rec.ok ? 'good' : 'bad') + '">' +
        (rec.ok ? '答对' : (rec.blank ? '未作答' : '答错')) + '</span>' +
        '</div>' +
        '<div class="stem">' + esc(it.stem) + '</div>' +
        '<div class="ropts">' + opts + '</div>' +
        '<div class="answers">' +
        '<span class="kv ' + (rec.ok ? 'hit' : 'miss') + '">你的答案：<b>' + esc(your) + '</b></span>' +
        '<span class="kv hit">标准答案：<b>' + esc(okAns) + '</b></span>' +
        '</div></div>';
    }).join('');
  }

  /* ---------- 成绩单文档（Word .doc，A4 排版） ---------- */
  var DOC_CSS = [
    '@page { size: A4; margin: 1.8cm 1.6cm; }',
    'body { font-family: "宋体", SimSun, serif; font-size: 10.5pt; color: #000; line-height: 1.65; }',
    'h1 { font-family: "黑体", SimHei, sans-serif; font-size: 18pt; text-align: center; margin: 0 0 4pt; }',
    '.sub { text-align: center; font-size: 9.5pt; color: #444; margin: 0 0 14pt; }',
    'h2 { font-family: "黑体", SimHei, sans-serif; font-size: 12pt; margin: 15pt 0 5pt; }',
    'table { border-collapse: collapse; width: 100%; margin: 4pt 0; }',
    'td, th { border: 0.75pt solid #888; padding: 5pt 7pt; font-size: 10pt; vertical-align: top; }',
    'th { background: #eef2ff; font-weight: bold; text-align: left; }',
    'td.k { background: #f5f7fb; font-weight: bold; width: 15%; }',
    'td.v { width: 35%; }',
    '.q { margin: 0 0 9pt; padding-bottom: 7pt; border-bottom: 0.5pt dashed #bbb; }',
    '.qt { font-weight: bold; margin: 0 0 3pt; }',
    '.qs { margin: 0 0 4pt; }',
    '.qo { margin: 1pt 0 1pt 16pt; }',
    '.qo.ok { color: #0b7a4b; font-weight: bold; }',
    '.qo.no { color: #c0392b; font-weight: bold; }',
    '.qa { margin: 5pt 0 0; font-weight: bold; }',
    '.note { color: #444; font-size: 9.5pt; margin: 0 0 8pt; }',
    '.sign { margin-top: 20pt; }'
  ].join('\n');

  function buildDocHtml() {
    var R = S.result, e = S.examinee;
    var score = R.score % 1 === 0 ? R.score : R.score.toFixed(1);
    var h = [];

    h.push('<h1>综合考核成绩单</h1>');
    h.push('<p class="sub">军事技能训练理论 · 学生手册 · 安全知识　　全卷 40 题，每题 2.5 分，满分 100 分</p>');

    h.push('<table>');
    h.push('<tr><td class="k">姓　　名</td><td class="v">' + esc(e.name) +
      '</td><td class="k">班　　级</td><td class="v">' + esc(e.cls) + '</td></tr>');
    h.push('<tr><td class="k">学　　号</td><td class="v">' + esc(e.sid) +
      '</td><td class="k">考试用时</td><td class="v">' + fmtTime(S.elapsed) + '</td></tr>');
    h.push('<tr><td class="k">交卷时间</td><td class="v" colspan="3">' + esc(S.finishedAt) + '</td></tr>');
    h.push('</table>');

    h.push('<h2>一、成绩汇总</h2>');
    h.push('<table><tr><th>最终得分</th><th>试卷满分</th><th>答对</th><th>答错</th><th>未作答</th><th>正确率</th></tr>');
    h.push('<tr><td>' + score + '</td><td>100</td><td>' + R.right + '</td><td>' + R.wrong +
      '</td><td>' + R.blank + '</td><td>' + (R.right / TOTAL_Q * 100).toFixed(0) + '%</td></tr></table>');

    h.push('<h2>二、分题库得分</h2>');
    h.push('<table><tr><th>来源题库</th><th>抽题数</th><th>答对</th><th>答错</th><th>得分</th></tr>');
    var tR = 0, tW = 0, tS = 0;
    RULES.forEach(function (rule) {
      var b = R.byBank[rule.bank];
      if (!b) return;
      var meta = BANK_META[rule.bank] || { name: rule.bank };
      var s = b.right * PER_SCORE;
      tR += b.right; tW += b.wrong; tS += s;
      h.push('<tr><td>' + esc(meta.name) + '</td><td>' + b.total + '</td><td>' + b.right +
        '</td><td>' + b.wrong + '</td><td>' + (s % 1 === 0 ? s : s.toFixed(1)) + '</td></tr>');
    });
    h.push('<tr><td><b>合计</b></td><td><b>' + (tR + tW) + '</b></td><td><b>' + tR +
      '</b></td><td><b>' + tW + '</b></td><td><b>' + (tS % 1 === 0 ? tS : tS.toFixed(1)) + '</b></td></tr>');
    h.push('</table>');

    h.push('<h2>三、答题明细</h2>');
    h.push('<p class="note">全卷共 ' + TOTAL_Q + ' 题。绿色加粗为正确答案，红色加粗为误选项，' +
      '「你的答案」与「标准答案」不一致的题目即为错题。</p>');

    R.items.forEach(function (rec) {
      var it = rec.item;
      var meta = BANK_META[it.bank] || { name: it.bank };
      var opts = it.options.map(function (o) {
        var isAns = it.answer.indexOf(o[0]) > -1;
        var isPick = it.picked.indexOf(o[0]) > -1;
        var cls = isAns ? 'qo ok' : (isPick ? 'qo no' : 'qo');
        var mark = isAns ? '　【正确答案】' : (isPick ? '　【误选】' : '');
        return '<p class="' + cls + '">' + esc(o[0]) + '．' + esc(o[1]) + mark + '</p>';
      }).join('');
      var verdict = rec.ok ? '【答对】' : (rec.blank ? '【未作答】' : '【答错】');
      h.push('<div class="q">' +
        '<p class="qt">第 ' + rec.no + ' 题　' + (it.type === 'M' ? '［多选］' : '［单选］') +
        ' ' + esc(meta.name) + '　' + verdict + '</p>' +
        '<p class="qs">' + esc(it.stem) + '</p>' + opts +
        '<p class="qa">你的答案：' + esc(it.picked.length ? letters(it.picked) : '未作答') +
        '　　标准答案：' + esc(letters(it.answer)) + '</p>' +
        '</div>');
    });

    h.push('<p class="sign">考生签名：________________　　　　　日期：________________</p>');

    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><title>综合考核成绩单</title>' +
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom>' +
      '</w:WordDocument></xml><![endif]-->' +
      '<style>' + DOC_CSS + '</style></head><body>' + h.join('\n') + '</body></html>';
  }

  function downloadDoc() {
    if (!S.graded || !S.result) { toast('请先完成考核'); return; }
    var e = S.examinee;
    var name = '考核成绩单_' + e.name + '_' + e.sid + '_' + fmtStamp() + '.doc';
    download(name, buildDocHtml(), 'application/msword');
    toast('成绩单已下载：' + name);
  }

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', function (e) {
    if ($('modal-mask').classList.contains('open')) {
      if (e.key === 'Escape') closeModal(false);
      if (e.key === 'Enter') closeModal(true);
      return;
    }
    if (!$('screen-exam').classList.contains('active') || S.graded) return;
    var k = e.key;
    if (k === 'ArrowLeft')  { go(S.idx - 1); e.preventDefault(); return; }
    if (k === 'ArrowRight') { go(S.idx + 1); e.preventDefault(); return; }

    var idx = -1;
    if (/^[a-hA-H]$/.test(k)) idx = k.toUpperCase().charCodeAt(0) - 65;
    else if (/^[1-8]$/.test(k)) idx = parseInt(k, 10) - 1;
    if (idx < 0) return;
    var it = S.paper[S.idx];
    if (idx < it.options.length) { pick(it.options[idx][0]); e.preventDefault(); }
  });

  /* ---------- 按钮绑定 ---------- */
  $('btn-start').addEventListener('click', beginExam);
  $('btn-submit').addEventListener('click', submit);
  $('btn-submit-top').addEventListener('click', submit);
  $('btn-doc').addEventListener('click', downloadDoc);

  $('btn-abort').addEventListener('click', function () {
    confirmBox('退出考试', '退出后当前试卷的作答将会丢失，确定退出吗？', '退出', '继续答题')
      .then(function (ok) { if (ok) { stopTimer(); show('start'); renderHistory(); } });
  });

  $('btn-again').addEventListener('click', function () {
    beginExam();
    toast('已重新随机生成一套新试卷');
  });
  $('btn-home').addEventListener('click', function () { renderHistory(); show('start'); });
  $('btn-print').addEventListener('click', function () { window.print(); });

  $('filter-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    Array.prototype.forEach.call(this.children, function (c) { c.classList.remove('on'); });
    b.classList.add('on');
    S.filter = b.dataset.f;
    renderReview();
  });

  /* ---------- 启动 ---------- */
  renderStart();
})();
