/* ============================================================
   综合考核系统 —— 随机组卷 / 自动判分 / 错题回溯
   题库：军事技能训练理论 · 学生手册 · 安全知识
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 抽题规则 ---------- */
  /* 全卷 50 题：单选 30 + 多选 20；每题 2 分，满分 100 分。
     抽取方式：**按题库题量比例分配名额**（比例不变），并保证三个题库都有题；
     同时按学号记录「已做过的题」，**刷完一轮之前优先抽没做过的题**。 */
  var RULES = [
    { banks: ['mil', 'stu', 'saf'], fill: 0, multi: 20, single: 30, any: 0 },
  ];
  var PER_SCORE  = 2;                          // 每题 2 分（50 题 × 2 = 100）
  var FULL_SCORE = 100;                        // 满分 100 分
  var PASS_SCORE = 60;                         // 及格线
  var LIMIT_MIN  = 35;                         // 单次考核限时（分钟）
  var LIMIT_SEC  = LIMIT_MIN * 60;             // 换算成秒
  var TOTAL_Q    = RULES.reduce(function (n, r) {
    return n + (r.any || 0) + r.fill + r.multi + r.single;
  }, 0); // 40
  /* 实际题数：正式考核固定 50 题，错题练习则按错题数量 */
  function qTotal() { return (S.paper && S.paper.length) ? S.paper.length : TOTAL_Q; }

  var BANK_META  = window.BANK_META || {};
  var BANKS      = window.BANKS || {};

  /* ---------- 题库按需加载 ----------
     assets/banks.js 有 106KB，占首屏体积的一半。它只在「开始答题」之后才用得到，
     因此改成异步加载：首屏先把页面画出来，题库在后台并行下载，加载完回填并刷新首页统计。 */
  var banksReady = !!(window.BANKS && Object.keys(window.BANKS).length);
  var banksCbs = [];

  window.__banksReady = function () {
    BANKS = window.BANKS || {};
    BANK_META = window.BANK_META || {};
    banksReady = true;
    var cbs = banksCbs.slice();
    banksCbs.length = 0;
    cbs.forEach(function (f) { try { f(); } catch (e) {} });
    try { renderStart(); } catch (e) {}
  };

  /* 题库就绪后回调；超时则回调失败原因，避免考生卡在「正在准备」 */
  function whenBanksReady(cb, timeoutMs) {
    if (banksReady) { cb(null); return; }
    var done = false;
    banksCbs.push(function () { if (!done) { done = true; cb(null); } });
    setTimeout(function () {
      if (done) return;
      done = true;
      cb(banksReady ? null : new Error('题库加载超时，请检查网络后刷新页面重试'));
    }, timeoutMs || 20000);
  }

  /* 参与组卷的题库顺序（去重），结果页与成绩单按这个顺序列分题库得分 */
  var BANK_ORDER = (function () {
    var out = [];
    RULES.forEach(function (r) {
      (r.banks || [r.bank]).forEach(function (b) { if (out.indexOf(b) < 0) out.push(b); });
    });
    return out;
  })();

  /* 违规类型：一经触发立刻交卷，同时上报云端供教师端标红报警 */
  var VIOLATIONS = {
    leave:      '退出考试界面',      // 已下线，仅用于显示历史记录
    split:      '分屏 / 调整窗口',
    copy:       '复制粘贴',          // 已下线，仅用于显示历史记录
    screenshot: '截屏',
  };

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

  /* ---------- 填空题判分 ---------- */
  /* 规范化：全角转半角、去掉所有空白与标点，只留下「有意义的内容」。
     这样 23：30 / 23:30 / 23点30分 的写法差异不会影响判分。 */
  var PUNCT_RE = /[、，。；：,.;:·・'"“”‘’`()（）〈〉《》【】\[\]{}!！?？~～\-—_+=*/\\|&^%$#@<>]/g;
  function normFill(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, function (c) {           // 全角字符 → 半角
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .replace(/[\s\u3000\u00a0]/g, '')
      .replace(PUNCT_RE, '')
      .toLowerCase();
  }

  function isBlankRight(blank, input) {
    var n = normFill(input);
    if (!n) return false;
    var acc = blank.accept || [];
    for (var i = 0; i < acc.length; i++) {
      if (normFill(acc[i]) === n) return true;
    }
    var need = blank.need || [];
    if (need.length) {
      return need.every(function (t) { return n.indexOf(normFill(t)) > -1; });
    }
    return false;
  }

  /* 多空题：所有空都对才算答对（与多选题「必须完全一致」的口径保持一致） */
  function isFillRight(item) {
    if (!item.blanks.length) return false;
    return item.blanks.every(function (b, i) { return isBlankRight(b, item.inputs[i]); });
  }
  function fillAnswered(item) {
    return item.inputs.some(function (v) { return String(v || '').trim() !== ''; });
  }

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
  /* 把若干题库合并成一个抽题池；每题记住自己来自哪个库，便于结果页按库拆分得分 */
  function mergedPool(banks) {
    var out = [];
    banks.forEach(function (b) {
      (BANKS[b] || []).forEach(function (q) { out.push({ bank: b, q: q }); });
    });
    return out;
  }

  /* ---------- 题目唯一标识 ---------- */
  /* 用「题库 + 题干哈希」作为题目指纹，用于记录考生已经做过哪些题。 */
  function qhash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function qid(bank, q) { return bank + ':' + qhash(String(q.q)); }

  /* ---------- 「已做过的题」按学号持久化 ---------- */
  /* 存在本机（localStorage）；换设备或清缓存会重新计算一轮。 */
  var LS_SEEN = 'quiz.seen.';
  function loadSeen(sid) {
    var list = lsGet(LS_SEEN + sid, []);
    var set = {};
    (list || []).forEach(function (x) { set[x] = 1; });
    return set;
  }
  function saveSeen(sid, set) {
    var arr = Object.keys(set);
    if (arr.length > 4000) arr = arr.slice(arr.length - 4000);
    lsSet(LS_SEEN + sid, arr);
  }

  /* ---------- 错题库（按学号） ---------- */
  var LS_WRONG = 'quiz.wrong.';
  var WRONG_CAP = 300;                        // 错题库上限，避免 localStorage 过大
  function loadWrong(sid) {
    var list = lsGet(LS_WRONG + sid, []);
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }
  function saveWrong(sid, list) { lsSet(LS_WRONG + sid, list.slice(0, WRONG_CAP)); }
  function wrongCount(sid) { return sid ? loadWrong(sid).length : 0; }

  /* 交卷时更新错题库：答错的收录并累加次数，答对的移出（说明已掌握） */
  function updateWrongBook(items) {
    var sid = S.examinee && S.examinee.sid;
    if (!sid) return 0;
    var book = loadWrong(sid);
    var idx = {};
    book.forEach(function (x, i) { idx[x.id] = i; });
    items.forEach(function (rec) {
      var it = rec.item;
      if (!it || !it.id) return;
      if (rec.ok) {
        if (idx[it.id] != null) { book[idx[it.id]] = null; }
      } else {
        var prev = (idx[it.id] != null && book[idx[it.id]]) ? book[idx[it.id]] : null;
        var target = {
          id: it.id, bank: it.bank, type: it.type,
          stem: it.stem, options: it.options, answer: it.answer.slice(),
          lastPicked: it.picked ? it.picked.slice() : [],
          wrongCount: (prev ? prev.wrongCount : 0) + 1,
          lastAt: fmtDate(),
        };
        if (prev) book[idx[it.id]] = target;
        else { book.push(target); idx[it.id] = book.length - 1; }
      }
    });
    saveWrong(sid, book.filter(Boolean));
    return wrongCount(sid);
  }

  /* ---------- 按题库题量比例分配名额（最大余数法） ---------- */
  /* 保证：① 每个题库都有题；② 各库占比稳定 = 该库题量占总量之比。 */
  function bankQuota(type, total, banks) {
    var sizes = banks.map(function (b) {
      var n = (BANKS[b] || []).filter(function (q) {
        return type === 'M' ? q.t === 'M' : (q.t !== 'M' && q.t !== 'F');
      }).length;
      return { bank: b, n: n };
    });
    var sum = sizes.reduce(function (a, x) { return a + x.n; }, 0) || 1;
    var raw = sizes.map(function (x) {
      var exact = total * x.n / sum;
      return { bank: x.bank, n: x.n, base: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    var assigned = raw.reduce(function (a, x) { return a + x.base; }, 0);
    var order = raw.slice().sort(function (a, b) { return b.frac - a.frac; });
    for (var i = 0; assigned < total && i < order.length * 2; i++) {
      var t = order[i % order.length];
      if (t.base < t.n) { t.base++; assigned++; }
    }
    var out = {};
    raw.forEach(function (x) { out[x.bank] = Math.min(x.base, x.n); });
    return out;
  }

  /* 组卷：按题库配额抽题，优先抽「没做过的题」；
     若某题型没做过的已不够一套，则这一轮视为刷完，清空记录重新开始。 */
  function buildPaper(seen) {
    var paper = [];
    var banks = RULES[0].banks;
    var needS = RULES[0].single, needM = RULES[0].multi;

    var freshS = 0, freshM = 0;
    banks.forEach(function (b) {
      (BANKS[b] || []).forEach(function (q) {
        if (seen[qid(b, q)]) return;
        if (q.t === 'M') freshM++;
        else if (q.t !== 'F') freshS++;
      });
    });
    if (freshS < needS || freshM < needM) {
      Object.keys(seen).forEach(function (k) { delete seen[k]; });
      S.roundWrapped = true;
    }

    [['S', needS], ['M', needM]].forEach(function (pair) {
      var type = pair[0], total = pair[1];
      var quota = bankQuota(type, total, banks);
      Object.keys(quota).forEach(function (bank) {
        var want = quota[bank];
        if (!want) return;
        var pool = (BANKS[bank] || []).filter(function (q) {
          return type === 'M' ? q.t === 'M' : (q.t !== 'M' && q.t !== 'F');
        });
        var fresh = [], used = [];
        pool.forEach(function (q) { (seen[qid(bank, q)] ? used : fresh).push(q); });
        var picked = shuffle(fresh.slice()).slice(0, Math.min(want, fresh.length));
        if (picked.length < want) {
          picked = picked.concat(shuffle(used.slice()).slice(0, Math.min(want - picked.length, used.length)));
        }
        picked.forEach(function (q) { paper.push(makeItem(bank, q)); });
      });
    });

    if (paper.length !== needS + needM) {
      throw new Error('题库题量不足：需要 ' + (needS + needM) + ' 题，实际组出 ' + paper.length + ' 题。');
    }

    shuffle(paper);
    return paper;
  }

  function makeItem(bank, q) {
    if (q.t === 'F') {
      var bl = q.blanks || [];
      return {
        bank: bank,
        type: 'F',
        stem: q.q,
        blanks: bl.map(function (b) { return { ans: b.ans, accept: b.accept || [], need: b.need || [] }; }),
        inputs: bl.map(function () { return ''; }),
      };
    }
    return {
      id: qid(bank, q),      // 题目指纹，用于「已做过」与错题库
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
  function newPaper() {
    var sid = (S.examinee && S.examinee.sid) || '';
    var seen = loadSeen(sid);
    var paper, sig, tries = 0;
    do {
      paper = buildPaper(seen);
      sig = signature(paper);
      tries++;
    } while (sig === lastSig && tries < 8);
    lastSig = sig;
    S.seen = seen;                 // 交卷时把本卷题目并入
    return paper;
  }

  /* ---------- 状态 ---------- */
  var LS_ID = 'quiz.examinee';
  var LS_REC = 'quiz.records';

  var S = {
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
    seen: {},                 // 该学号已做过的题目指纹
    roundWrapped: false,      // 本次组卷是否刚开启新一轮
    strikes: {},              // 违规计数：{ split: n, screenshot: n }
    violation: null,          // { code, detail, at }
    timedOut: false,          // 是否因超时自动交卷
    warned: 0,                // 已提示过的剩余时间档位
    focusFill: false,
  };

  /* ---------- 首页 ---------- */
  /* 首页的「错题练习」按钮：按当前填写的学号显示错题数量 */
  function renderPracticeBtn() {
    var btn = $('btn-practice');
    if (!btn) return;
    var id = readIdentity();
    var n = (id && id.sid) ? wrongCount(id.sid) : 0;
    if (n > 0) {
      btn.hidden = false;
      btn.textContent = '错题练习（' + n + ' 题）';
    } else {
      btn.hidden = true;
    }
  }

  function renderStart() {
    if (!banksReady) {
      $('start-stats').innerHTML = '<div class="stat"><div class="k">正在准备</div>' +
        '<div class="v">题库加载中<em> 请稍候</em></div></div>';
      $('start-rules').innerHTML = '<li class="hint">正在加载题库…（不影响先填写考生信息）</li>';
      return;
    }
    var usedBanks = [];
    RULES.forEach(function (r) {
      (r.banks || [r.bank]).forEach(function (b) { if (usedBanks.indexOf(b) < 0) usedBanks.push(b); });
    });
    var bankTotal = usedBanks.reduce(function (n, b) { return n + (BANKS[b] || []).length; }, 0);
    var comp = RULES.reduce(function (a, r) {
      a.fill += r.fill; a.multi += r.multi; a.single += r.single; a.any += (r.any || 0); return a;
    }, { fill: 0, multi: 0, single: 0, any: 0 });
    var compTxt = [];
    if (comp.fill) compTxt.push('填空 ' + comp.fill);
    if (comp.multi) compTxt.push('多选 ' + (comp.any ? comp.multi + '~' + (comp.multi + comp.any) : comp.multi));
    if (comp.single) compTxt.push('单选 ' + (comp.any ? comp.single + '~' + (comp.single + comp.any) : comp.single));

    var cards = [
      { k: '全卷题量', v: TOTAL_Q, s: '题（' + compTxt.join(' · ') + '）' },
      { k: '每题分值', v: PER_SCORE, s: '分' },
      { k: '试卷满分', v: FULL_SCORE, s: '分' },
      { k: '考核限时', v: LIMIT_MIN, s: '分钟，到时自动交卷' },
      { k: '题库总量', v: bankTotal, s: '题（' + usedBanks.length + ' 个题库合并）' },
    ];
    $('start-stats').innerHTML = cards.map(function (c) {
      return '<div class="stat"><div class="k">' + esc(c.k) + '</div>' +
        '<div class="v">' + esc(c.v) + '<em> ' + esc(c.s) + '</em></div></div>';
    }).join('');

    var rows = RULES.map(function (r) {
      var banks = r.banks || [r.bank];
      var names = banks.map(function (b) { return (BANK_META[b] || {}).name || b; });
      var pool = mergedPool(banks).map(function (x) { return x.q; });
      var cnt = function (t) { return pool.filter(function (x) { return x.t === t; }).length; };
      var parts = [];
      if (r.fill)   parts.push('填空 <b>' + r.fill + '</b> 题');
      if (r.multi)  parts.push('多选 <b>' + r.multi + '</b> 题');
      if (r.single) parts.push('单选 <b>' + r.single + '</b> 题');
      if (r.any)    parts.push('单选/多选不限 <b>' + r.any + '</b> 题');
      var tot = (r.any || 0) + r.fill + r.multi + r.single;
      var singleN = pool.length - cnt('F') - cnt('M');
      var typ = [];
      if (cnt('F')) typ.push('填空 ' + cnt('F'));
      if (cnt('M')) typ.push('多选 ' + cnt('M'));
      if (singleN) typ.push('单选 ' + singleN);
      var who = names.length > 1
        ? '『' + names.join(' / ') + '』（共 ' + names.length + ' 个题库合并）'
        : '『' + names[0] + '』';
      return '<li><b>随机抽题</b>：不按题库分配名额，从 ' + esc(who) + '的合并题库中随机抽 ' +
        parts.join(' + ') + '（共 ' + tot + ' 题）　<span class="hint">（可选 ' + pool.length +
        ' 题：' + typ.join(' / ') + '）</span></li>';
    }).join('');
    $('start-rules').innerHTML = rows;
    renderPracticeBtn();
    renderHello();
    renderBankCards();

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
      '<th>得分</th><th>答对</th><th>答错</th><th>未答</th><th>用时</th><th>状态</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r) {
        var st = r.violation ? '<span class="badge fail">' + esc(VIOLATIONS[r.violation] || '违规') + '</span>'
          : (r.timeout ? '<span class="badge dup">超时</span>' : '<span class="badge pass">正常</span>');
        return '<tr><td class="num">' + esc(r.time) + '</td><td>' + esc(r.name) +
          '</td><td>' + esc(r.cls) + '</td><td class="who num">' + esc(r.sid) +
          '</td><td class="num">' + r.score + '</td><td class="num">' + r.right +
          '</td><td class="num">' + r.wrong + '</td><td class="num">' + r.blank +
          '</td><td class="num">' + esc(r.used) + '</td><td>' + st + '</td></tr>';
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
    var head = ['考试时间', '姓名', '班级', '学号', '得分', '答对', '答错', '未作答', '用时', '正确率', '状态'];
    var rows = list.map(function (r) {
      return [r.time, r.name, r.cls, r.sid, r.score, r.right, r.wrong, r.blank, r.used, r.rate,
        r.violation ? ('违规：' + (VIOLATIONS[r.violation] || r.violation)) : (r.timeout ? '超时自动交卷' : '正常')];
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

  /* ---------- 云端成绩上传 ---------- */
  var CC = window.CLOUD_CONFIG || null;      // assets/cloud-config.js 提供
  var LS_PEND = 'quiz.pending';              // 上传失败的暂存队列
  var cloudClient = null;

  /* 云 SDK 有 72KB，只在「交卷上传」时用得到，因此也从首屏挪走：按需注入 + 后台预热 */
  var sdkPromise = null;
  function ensureSdk() {
    var api = window.WorkBuddyCloud;
    if (api && typeof api.createWorkBuddyCloud === 'function') return Promise.resolve(true);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve) {
      var el = document.createElement('script');
      el.src = 'assets/workbuddy-cloud-sdk.js';
      el.async = true;
      el.onload = function () {
        var a = window.WorkBuddyCloud;
        resolve(!!(a && typeof a.createWorkBuddyCloud === 'function'));
      };
      el.onerror = function () { sdkPromise = null; resolve(false); };
      document.head.appendChild(el);
    });
    return sdkPromise;
  }

  function getCloud() {
    if (cloudClient) return cloudClient;
    if (!CC) return null;
    var api = window.WorkBuddyCloud;
    if (!api || typeof api.createWorkBuddyCloud !== 'function') return null;
    cloudClient = api.createWorkBuddyCloud({
      endpoint: CC.endpoint,
      oauthRelayBaseUrl: CC.oauthRelayBaseUrl,
      publishableKey: CC.publishableKey,
    });
    return cloudClient;
  }

  function buildPayload() {
    var R = S.result, e = S.examinee;
    return {
      name: e.name, cls: e.cls, sid: e.sid,
      score: Math.round(R.score * 100) / 100,
      right_cnt: R.right, wrong_cnt: R.wrong, blank_cnt: R.blank,
      used_sec: S.elapsed,
      bank_json: R.byBank,
      violation: S.violation ? S.violation.code : null,
      violation_detail: S.violation ? (S.violation.detail || '') : null,
      violated_at: S.violation ? S.violation.at.toISOString() : null,
      timed_out: !!S.timedOut,
      sound_monitored: false,
    };
  }

  function pendKey(p) { return p.sid + '|' + p.name + '|' + p.score + '|' + p.used_sec; }

  function addPending(p) {
    var list = lsGet(LS_PEND, []);
    var k = pendKey(p);
    for (var i = 0; i < list.length; i++) if (list[i].key === k) return;
    list.push({ key: k, payload: p });
    if (list.length > 50) list = list.slice(-50);
    lsSet(LS_PEND, list);
  }
  function dropPending(k) {
    lsSet(LS_PEND, lsGet(LS_PEND, []).filter(function (x) { return x.key !== k; }));
  }

  /* 单条写入云端；resolve 表示成功。
     注意：不能链 .select()——表上 RLS 只有 INSERT 策略、没有 SELECT 策略，
     带 RETURNING 的插入会被 PostgreSQL 判为违反行级安全策略。 */
  function insertRecord(payload) {
    return ensureSdk().then(function (ok) {
      if (!ok) throw new Error('cloud-sdk-unavailable');
      var cloud = getCloud();
      if (!cloud) throw new Error('cloud-sdk-unavailable');
      return cloud.database.from(CC.table).insert(payload);
    }).then(function (res) {
      if (res && res.error) throw res.error;
      return true;
    });
  }

  /* 把暂存队列里的记录逐条补传 */
  function flushPending() {
    var list = lsGet(LS_PEND, []);
    if (!list.length) return Promise.resolve(0);
    var ok = 0;
    return list.reduce(function (chain, entry) {
      return chain.then(function () {
        return insertRecord(entry.payload).then(function () {
          dropPending(entry.key); ok++;
        }).catch(function () { /* 留着下次再试 */ });
      });
    }, Promise.resolve()).then(function () { return ok; });
  }

  var uploadState = { status: 'idle', msg: '', sub: '' };

  function renderUpload() {
    var box = $('upload-line');
    if (!box) return;
    if (uploadState.status === 'idle') { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    var cls = uploadState.status === 'ok' ? 'ok' : (uploadState.status === 'err' ? 'err' : 'busy');
    var html = '<span class="dot"></span><span class="msg">' + esc(uploadState.msg) + '</span>';
    if (uploadState.sub) html += '<span class="sub">' + esc(uploadState.sub) + '</span>';
    if (uploadState.status === 'err') {
      html += '<button class="btn btn-ghost retry" id="btn-retry-upload">重试上传</button>';
    }
    box.className = 'upload-line ' + cls;
    box.innerHTML = html;
    var btn = $('btn-retry-upload');
    if (btn) btn.addEventListener('click', function () { submitUpload(false); });
  }

  var uploadBusy = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 上传重试：网络抖动或被平台限流时按指数退避自动重试。
     权限类错误（口令/策略拒绝）不重试，避免无意义地反复打服务器。 */
  function uploadWithRetry(payload, maxTries) {
    maxTries = maxTries || 3;
    var attempt = 0;
    function tryOnce() {
      attempt++;
      return insertRecord(payload).then(function () {
        return true;
      }).catch(function (err) {
        var code = String((err && err.code) || '');
        var msg = String((err && err.message) || '');
        var fatal = code.indexOf('42501') > -1 || msg.indexOf('cloud-sdk-unavailable') > -1;
        if (fatal || attempt >= maxTries) throw err;
        var wait = Math.min(8000, 800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 600);
        uploadState = {
          status: 'busy', msg: '正在上传成绩…',
          sub: '服务器繁忙，' + (wait / 1000).toFixed(1) + ' 秒后自动重试（第 ' + attempt + ' 次）',
        };
        renderUpload();
        return sleep(wait).then(tryOnce);
      });
    }
    return tryOnce();
  }

  /* spreadMs：随机错峰窗口。大量考生同时交卷时用它把写入摊开，
     避免同一秒的集中写入触发平台限流。 */
  function submitUpload(silent, spreadMs) {
    if (uploadBusy) return;
    if (!CC) return;
    uploadBusy = true;
    var payload = buildPayload();
    var k = pendKey(payload);
    if (!silent) {
      uploadState = { status: 'busy', msg: '正在上传成绩…', sub: '' };
      renderUpload();
    }
    var jitter = spreadMs ? Math.floor(Math.random() * spreadMs) : 0;

    (jitter > 0 ? sleep(jitter) : Promise.resolve()).then(function () {
      return uploadWithRetry(payload, 3);
    }).then(function () {
      dropPending(k);
      return flushPending();
    }).then(function (extra) {
      uploadState = {
        status: 'ok', msg: '成绩已上传到教师端',
        sub: extra ? ('含补传 ' + extra + ' 条历史记录') : ('学号 ' + payload.sid + '，教师端可实时查看'),
      };
    }).catch(function (err) {
      addPending(payload);
      var code = String((err && err.code) || '');
      var msg = String((err && err.message) || '');
      var why = code.indexOf('42501') > -1 ? '服务端拒绝了写入'
        : (msg.indexOf('cloud-sdk-unavailable') > -1 ? '云服务组件未加载，请检查网络后刷新页面'
          : '网络或服务器繁忙（已自动重试 3 次）');
      uploadState = {
        status: 'err', msg: '成绩上传失败',
        sub: why + '；成绩已在本机暂存，可点击「重试上传」，不影响本次得分与成绩单下载。',
      };
    }).then(function () {
      uploadBusy = false;
      renderUpload();
    });
  }

  /* 成绩单始终可下载：本地记录 + 云端记录互为备份 */

  /* ---------- 屏幕切换 ---------- */
  function show(name) {
    ['screen-login', 'screen-start', 'screen-exam', 'screen-result'].forEach(function (id) {
      $(id).classList.toggle('active', id === 'screen-' + name);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ============================================================
     考生登录（学号 + 姓名）
     · 首次登录自动登记；之后同一学号必须姓名一致，否则拒绝
     · 登录态存在本机，下次打开自动进入
     ============================================================ */
  var LS_LOGIN = 'quiz.login';
  function getLogin() {
    var v = lsGet(LS_LOGIN, null);
    return (v && v.sid && v.name) ? v : null;
  }
  function setLogin(sid, name) { lsSet(LS_LOGIN, { sid: sid, name: name, at: Date.now() }); }
  function clearLogin() { try { localStorage.removeItem(LS_LOGIN); } catch (e) {} }

  function showLoginError(msg) {
    var el = $('login-msg');
    if (!el) { toast(msg); return; }
    el.textContent = msg;
    el.hidden = false;
  }
  function clearLoginError() {
    var el = $('login-msg');
    if (el) { el.hidden = true; el.textContent = ''; }
  }

  function doLogin() {
    var sid = String(($('login-id') || {}).value || '').trim();
    var name = String(($('login-name') || {}).value || '').trim();
    var btn = $('btn-login');
    clearLoginError();
    if (sid.length < 4 || sid.length > 24) { showLoginError('学号需 4-24 位'); return; }
    if (!name) { showLoginError('请填写姓名'); return; }
    if (name.length > 20) { showLoginError('姓名最多 20 字'); return; }

    btn.disabled = true;
    btn.textContent = '登录中…';
    ensureSdk().then(function (ok) {
      if (!ok) throw new Error('cloud-sdk-unavailable');
      var cloud = getCloud();
      if (!cloud || !CC || !CC.studentLoginRpc) throw new Error('cloud-sdk-unavailable');
      return cloud.database.rpc(CC.studentLoginRpc, { p_sid: sid, p_name: name });
    }).then(function (res) {
      if (res && res.error) throw res.error;
      var r = Array.isArray(res.data) ? res.data[0] : res.data;
      r = r || {};
      if (!r.ok) {
        btn.disabled = false; btn.textContent = '登录并进入';
        showLoginError(r.msg || '登录失败，请重试');
        return;
      }
      setLogin(r.sid || sid, r.name || name);
      enterAfterLogin(!!r.first);
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = '登录并进入';
      var m = String((err && err.message) || '');
      showLoginError(m.indexOf('cloud-sdk') > -1
        ? '网络异常，无法连接服务器，请稍后重试'
        : '登录失败，请检查网络后重试');
    });
  }

  /* 登录成功：填充考生信息并进入首页 */
  function enterAfterLogin(isFirst) {
    var lg = getLogin();
    if (!lg) return;
    S.examinee = { sid: lg.sid, name: lg.name, cls: (S.examinee && S.examinee.cls) || '' };
    if ($('in-id')) { $('in-id').value = lg.sid; $('in-id').readOnly = true; }
    if ($('in-name')) { $('in-name').value = lg.name; $('in-name').readOnly = true; }
    if ($('in-class') && !$('in-class').value) {
      var last = lsGet(LS_ID, null);
      if (last && last.cls) $('in-class').value = last.cls;
    }
    var btn = $('btn-login');
    if (btn) { btn.disabled = false; btn.textContent = '登录并进入'; }
    show('start');
    switchPane('home');
    renderHello();
    renderBankCards();
    renderPracticeBtn();
    if (isFirst) toast('首次登录，已为您登记：' + lg.name + '（' + lg.sid + '）');
  }

  function doLogout() {
    clearLogin();
    if ($('in-id')) { $('in-id').value = ''; $('in-id').readOnly = false; }
    if ($('in-name')) { $('in-name').value = ''; $('in-name').readOnly = false; }
    if ($('login-id')) $('login-id').value = '';
    if ($('login-name')) $('login-name').value = '';
    clearLoginError();
    show('login');
  }

  /* 启动时决定先显示哪一屏 */
  function bootAuth() {
    var lg = getLogin();
    if (lg) {
      enterAfterLogin(false);
    } else {
      show('login');
    }
  }

  /* ============================================================
     考场检测规则（按需求仅保留：分屏 / 截图）
     · 分屏：桌面看「窗口宽度占屏幕比例」、小屏看「可视高度占屏幕比例」，
             持续 1.5 秒即判定（输入法弹出等场景有宽限，避免误判）
     · 截图：捕获 PrintScreen 按键
     · 两者均为「前 3 次警告、第 4 次立即交卷」
     （退出界面、复制粘贴、声音、人脸检测均已下线）
     ============================================================ */
  var GUARD = {
    armed: false, fired: false,
    suppressUntil: 0,        // 开考缓冲：这段时间内失焦/尺寸变化不算违规
    fsOk: false,
    splitSince: 0,           // 桌面端分屏计时
    msplitSince: 0,          // 小屏分屏计时（必须与上面分开，否则互相清零）
    strikeGraceUntil: 0,     // 警告后的宽限截止时间
    watchTimer: null,
  };
  var SPLIT_MIN_SCREEN  = 1100;   // 屏幕窄于此值改走「可视高度」规则
  var SPLIT_RATIO       = 0.85;   // 桌面：窗口宽度 < 屏幕 85%
  var MOBILE_SPLIT_RATIO = 0.6;   // 小屏：可视高度 < 屏幕 60%
  var TYPING_GRACE = 2500;        // 刚碰过输入框后的宽限（输入法会压矮视口）
  var lastTypingAt = 0;

  /* 前 3 次警告、第 4 次交卷：n < limit 时才警告 */
  var STAGED_LIMIT = { split: 4, screenshot: 4 };
  var STRIKE_GRACE = 3000;

  function isSmallScreen() {
    var sw = (window.screen &&
      Math.max(window.screen.availWidth || 0, window.screen.width || 0)) || 0;
    return sw > 0 && sw < SPLIT_MIN_SCREEN;
  }
  function noteTyping() { lastTypingAt = Date.now(); }
  function inInput(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
  }
  function suppressGuard(ms) { GUARD.suppressUntil = Date.now() + ms; }
  function guardActive() {
    return GUARD.armed && !GUARD.fired && !S.graded && Date.now() >= GUARD.suppressUntil;
  }
  function inStrikeGrace() { return Date.now() < (GUARD.strikeGraceUntil || 0); }

  /* 警告弹窗：写明第几次、还剩几次机会 */
  function warnStudent(code, detail, n, limit) {
    var el = $('warning-mask');
    if (!el) { toast('警告：' + (VIOLATIONS[code] || code) + '（第 ' + n + ' 次）'); return; }
    $('warning-title').textContent = '第 ' + n + ' 次警告：' + (VIOLATIONS[code] || code);
    var left = limit - n;
    var tail = left > 0
      ? '还有 <b>' + left + '</b> 次机会；再犯将自动交卷。'
      : '<b>这是最后一次警告，下次将立即自动交卷。</b>';
    $('warning-text').innerHTML = esc(detail) + '<br>这是第 <b>' + n + '</b> 次，' + tail;
    el.hidden = false;
  }

  function trip(code, detail) {
    if (!guardActive()) return false;
    var limit = STAGED_LIMIT[code];
    if (limit) {
      var n = (S.strikes[code] || 0) + 1;
      S.strikes[code] = n;
      if (n < limit) {
        GUARD.strikeGraceUntil = Date.now() + STRIKE_GRACE;
        GUARD.splitSince = 0;
        GUARD.msplitSince = 0;
        warnStudent(code, detail, n, limit);
        return false;
      }
    }
    GUARD.fired = true;
    S.violation = { code: code, detail: detail, at: new Date() };
    try { grade({ violation: S.violation }); } catch (e) {}
    showViolationMask();
    return true;
  }

  function showViolationMask() {
    var mask = $('violation-mask');
    if (!mask) return;
    var v = S.violation || {};
    $('violation-text').innerHTML =
      '<b>' + esc(VIOLATIONS[v.code] || v.code || '违规行为') + '</b>' +
      (v.detail ? '：' + esc(v.detail) : '') +
      '<br><span class="hint">系统已立即交卷，并把本次违规上报教师端（成绩单状态标记为违规）。</span>';
    mask.hidden = false;
  }

  function armGuard() {
    GUARD.armed = true;
    GUARD.fired = false;
    GUARD.splitSince = 0;
    GUARD.msplitSince = 0;
    GUARD.strikeGraceUntil = 0;
    S.violation = null;
    S.strikes = {};
    S.timedOut = false;
  }
  function disarmGuard() {
    GUARD.armed = false;
    clearInterval(GUARD.watchTimer);
    GUARD.watchTimer = null;
  }

  /* ---- 全屏 ---- */
  function requestExamFullscreen() {
    var el = document.documentElement;
    if (!el.requestFullscreen) { GUARD.fsOk = false; return Promise.resolve(false); }
    return Promise.resolve(el.requestFullscreen()).then(function () {
      GUARD.fsOk = true; return true;
    }).catch(function () { GUARD.fsOk = false; return false; });
  }
  function exitExamFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen(); } catch (e) {}
    }
  }

  /* ---- 截图：PrintScreen ---- */
  document.addEventListener('keydown', function (e) {
    if (!guardActive()) return;
    if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
      trip('screenshot', '按下截屏键 PrintScreen');
    }
  }, true);

  /* ---- 分屏巡检 ---- */
  function checkSplit() {
    if (!guardActive()) { GUARD.splitSince = 0; return; }
    if (inStrikeGrace()) { GUARD.splitSince = 0; return; }
    if (isSmallScreen()) { GUARD.splitSince = 0; return; }
    var sw = (window.screen && window.screen.availWidth) || 0;
    var w = window.outerWidth || window.innerWidth || 0;
    if (sw < SPLIT_MIN_SCREEN || !w) { GUARD.splitSince = 0; return; }
    if (w < sw * SPLIT_RATIO) {
      if (!GUARD.splitSince) GUARD.splitSince = Date.now();
      else if (Date.now() - GUARD.splitSince >= 1000) {
        trip('split', '窗口宽度仅占屏幕的 ' + Math.round(w / sw * 100) + '%（疑似分屏）');
      }
    } else { GUARD.splitSince = 0; }
  }
  function checkMobileSplit() {
    if (!guardActive()) { GUARD.msplitSince = 0; return; }
    if (inStrikeGrace()) { GUARD.msplitSince = 0; return; }
    if (!isSmallScreen()) { GUARD.msplitSince = 0; return; }
    var sh = (window.screen && window.screen.height) || 0;
    var ih = window.innerHeight || 0;
    if (!sh || !ih) { GUARD.msplitSince = 0; return; }
    if (Date.now() - lastTypingAt < TYPING_GRACE) { GUARD.msplitSince = 0; return; }
    if (ih < sh * MOBILE_SPLIT_RATIO) {
      if (!GUARD.msplitSince) GUARD.msplitSince = Date.now();
      else if (Date.now() - GUARD.msplitSince >= 1000) {
        trip('split', '可视高度仅占屏幕的 ' + Math.round(ih / sh * 100) + '%（疑似分屏或悬浮窗）');
      }
    } else { GUARD.msplitSince = 0; }
  }
  function checkAllSplit() { checkSplit(); checkMobileSplit(); }
  window.addEventListener('resize', checkAllSplit);
  window.addEventListener('orientationchange', function () { noteTyping(); setTimeout(checkAllSplit, 800); });
  /* 开考即巡检一次：如果考生「一开始就处于分屏」，不必等第一次轮询就开始计时 */
  function startGuardWatch() {
    clearInterval(GUARD.watchTimer);
    checkAllSplit();
    GUARD.watchTimer = setInterval(checkAllSplit, 800);
  }
  ['focusin', 'focusout', 'input'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (inInput(e.target)) noteTyping(); }, true);
  });

  /* ---- 考场状态条 ---- */
  function renderGuardStatus() {
    var el = $('guard-status');
    if (!el) return;
    var items = [
      [isSmallScreen() ? '分屏/悬浮窗拦截' : '全屏与分屏拦截', true],
      ['截屏拦截', true],
    ];
    el.innerHTML = items.map(function (it) {
      return '<span class="gitem on">✔ ' + esc(it[0]) + '</span>';
    }).join('');
  }

  /* ---------- 开始考试 ---------- */
  function withTimeout(p, ms, fallback) {
    return Promise.race([
      Promise.resolve(p).catch(function () { return fallback; }),
      new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); }),
    ]);
  }

  /* ============================================================
     首页页签（首页 / 错题本 / 统计）
     ============================================================ */
  function switchPane(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
      b.classList.toggle('on', b.dataset.pane === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
      p.classList.toggle('on', p.id === 'pane-' + name);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (name === 'wrong') renderWrongPane();
    if (name === 'stat') renderStatPane();
  }

  /* 各题库的题量统计 */
  function bankStat(key) {
    var banks = key === 'all' ? RULES[0].banks : [key];
    var single = 0, multi = 0;
    banks.forEach(function (b) {
      (BANKS[b] || []).forEach(function (q) {
        if (q.t === 'M') multi++; else if (q.t !== 'F') single++;
      });
    });
    return { single: single, multi: multi, total: single + multi };
  }

  /* 已刷题数（该题库中出现在「已做过」集合里的题数） */
  function bankDone(key, seen) {
    var banks = key === 'all' ? RULES[0].banks : [key];
    var n = 0;
    banks.forEach(function (b) {
      (BANKS[b] || []).forEach(function (q) { if (seen[qid(b, q)]) n++; });
    });
    return n;
  }

  function bankCardHtml(key, title, seen) {
    var st = bankStat(key);
    var done = bankDone(key, seen);
    var pct = st.total ? Math.round(done / st.total * 100) : 0;
    return '<button class="bank-card" data-bank="' + key + '">' +
      '<b>' + esc(title) + '</b>' +
      '<div class="bc-meta">单选 ' + st.single + ' · 多选 ' + st.multi + ' · 共 ' +
        st.total + ' 题 　|　 <span class="bc-done">已刷 ' + done + '</span></div>' +
      '<div class="bc-bar"><i class="bc-fill" style="width:' + pct + '%"></i></div>' +
      '</button>';
  }

  /* 问候条：姓名 / 学号 / 班级 */
  function renderHello() {
    var lg = getLogin();
    var el = $('hello-name');
    if (el) el.textContent = lg ? (lg.name || '同学') : '同学';
    var sub = $('hello-sub');
    if (sub) {
      var cls = ($('in-class') || {}).value || '';
      var parts = [];
      if (lg && lg.sid) parts.push('学号 ' + lg.sid);
      if (cls) parts.push(cls);
      var n = lg ? wrongCount(lg.sid) : 0;
      parts.push(n ? ('错题 ' + n + ' 题') : '暂无错题');
      sub.textContent = parts.join(' · ');
    }
  }

  function renderBankCards() {
    var el = $('bank-grid');
    if (!el) return;
    var lg = getLogin();
    var seen = lg ? loadSeen(lg.sid) : {};
    var html = bankCardHtml('all', '全部混刷', seen);
    RULES[0].banks.forEach(function (b) {
      html += bankCardHtml(b, (BANK_META[b] || {}).name || b, seen);
    });
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.bank-card'), function (c) {
      c.addEventListener('click', function () { beginBankPractice(c.dataset.bank); });
    });
  }

  /* 错题本页 */
  function renderWrongPane() {
    var lg = getLogin();
    var book = lg ? loadWrong(lg.sid) : [];
    var hint = $('wrong-head-hint');
    if (hint) hint.textContent = book.length ? ('共 ' + book.length + ' 题') : '';
    var list = $('wrong-list');
    if (!list) return;
    if (!book.length) {
      list.innerHTML = '<div class="wrong-empty">还没有错题。完成一次考核后，答错的题会自动收录到这里。</div>';
      var bp0 = $('btn-practice'); if (bp0) bp0.disabled = true;
      return;
    }
    var bp = $('btn-practice'); if (bp) { bp.disabled = false; bp.textContent = '开始练习错题（' + book.length + ' 题）'; }
    list.innerHTML = book.map(function (w, i) {
      var bankName = (BANK_META[w.bank] || {}).name || w.bank;
      var yourAns = (w.lastPicked && w.lastPicked.length) ? w.lastPicked.join('') : '未作答';
      return '<div class="wrong-item">' +
        '<div class="wq">' + (i + 1) + '. ' + esc(w.stem) + '</div>' +
        '<div class="wmeta">' +
          '<span class="bk">' + esc(bankName) + ' · ' + (w.type === 'M' ? '多选' : '单选') + '</span>' +
          '<span class="no">你的答案：' + esc(yourAns) + '</span>' +
          '<span class="ok">正确答案：' + esc(w.answer.join('')) + '</span>' +
          '<span class="cnt">错 ' + (w.wrongCount || 1) + ' 次</span>' +
        '</div></div>';
    }).join('');
  }

  /* 统计页 */
  function renderStatPane() {
    var lg = getLogin();
    var sid = lg ? lg.sid : '';
    var seen = sid ? loadSeen(sid) : {};
    var book = sid ? loadWrong(sid) : [];
    var recs = lsGet(LS_REC, []).filter(function (r) { return !sid || r.sid === sid; });

    var total = 0;
    RULES[0].banks.forEach(function (b) { total += (BANKS[b] || []).filter(function (q) { return q.t !== 'F'; }).length; });
    var done = bankDone('all', seen);

    var sum = 0, pass = 0;
    recs.forEach(function (r) { sum += Number(r.score) || 0; if ((Number(r.score) || 0) >= PASS_SCORE) pass++; });
    var avg = recs.length ? (sum / recs.length) : 0;
    var rate = recs.length ? Math.round(pass / recs.length * 100) : 0;

    var cards = $('stat-cards');
    if (cards) {
      cards.innerHTML = [
        ['已刷题数', done + '<em> / ' + total + '</em>'],
        ['题库进度', (total ? Math.round(done / total * 100) : 0) + '<em> %</em>'],
        ['考核次数', recs.length + '<em> 次</em>'],
        ['平均分', (recs.length ? avg.toFixed(1) : '—') + '<em> 分</em>'],
        ['及格率', recs.length ? rate + '<em> %</em>' : '—'],
        ['错题数', book.length + '<em> 题</em>'],
      ].map(function (x) {
        return '<div class="stat-card"><div class="k">' + esc(x[0]) + '</div><div class="v">' + x[1] + '</div></div>';
      }).join('');
    }

    var sb = $('stat-banks');
    if (sb) {
      var h = bankCardHtml('all', '全部题库', seen);
      RULES[0].banks.forEach(function (b) { h += bankCardHtml(b, (BANK_META[b] || {}).name || b, seen); });
      sb.innerHTML = h;
      Array.prototype.forEach.call(sb.querySelectorAll('.bank-card'), function (c) {
        c.addEventListener('click', function () { beginBankPractice(c.dataset.bank); });
      });
    }

    var top = $('stat-top');
    if (top) {
      var sorted = book.slice().sort(function (a, b) { return (b.wrongCount || 1) - (a.wrongCount || 1); }).slice(0, 10);
      if (!sorted.length) {
        top.innerHTML = '<div class="wrong-empty">暂无错题。</div>';
      } else {
        top.innerHTML = sorted.map(function (w, i) {
          var bankName = (BANK_META[w.bank] || {}).name || w.bank;
          return '<div class="wrong-item">' +
            '<div class="wq">' + (i + 1) + '. ' + esc(w.stem) + '</div>' +
            '<div class="wmeta"><span class="bk">' + esc(bankName) + '</span>' +
            '<span class="cnt">错 ' + (w.wrongCount || 1) + ' 次</span>' +
            '<span class="ok">正确答案：' + esc(w.answer.join('')) + '</span></div></div>';
        }).join('');
      }
    }
  }

  /* ---------- 题库练习 ---------- */
  var PRACTICE_SIZE = 50;
  function startPractice(paper, label) {
    S.practice = true;
    S.paper = paper;
    S.idx = 0; S.graded = false; S.filter = 'wrong';
    S.startAt = Date.now(); S.elapsed = 0; S.finishedAt = '';
    S.violation = null; S.timedOut = false; S.wrongLeft = 0;
    uploadState = { status: 'idle', msg: '', sub: '' };
    $('pill-who').textContent = S.examinee.name + ' · ' + label + '（' + paper.length + ' 题）';
    $('btn-submit').disabled = false;
    $('btn-submit-top').disabled = false;
    startTimer();
    show('exam');
    renderExam();
    ensureSdk();
  }

  function beginBankPractice(key) {
    var lg = getLogin();
    if (!lg) { toast('请先登录'); return; }
    S.examinee = { sid: lg.sid, name: lg.name, cls: ($('in-class') || {}).value || '' };
    var banks = key === 'all' ? RULES[0].banks : [key];
    var seen = loadSeen(lg.sid);
    var pool = [];
    banks.forEach(function (b) {
      (BANKS[b] || []).forEach(function (q) { if (q.t !== 'F') pool.push({ bank: b, q: q }); });
    });
    if (!pool.length) { toast('该题库暂无题目'); return; }
    var fresh = pool.filter(function (x) { return !seen[qid(x.bank, x.q)]; });
    // 优先刷没做过的；没做过的不足一套时，把剩下的全部出出来（刷完这一轮）
    var use = fresh.length >= PRACTICE_SIZE ? fresh : (fresh.length ? fresh : pool);
    var picked = shuffle(use.slice()).slice(0, Math.min(PRACTICE_SIZE, use.length));
    var paper = picked.map(function (x) { return makeItem(x.bank, x.q); });
    shuffle(paper);
    var title = key === 'all' ? '全部混刷' : ((BANK_META[key] || {}).name || key);
    startPractice(paper, '练习 · ' + title);
  }

  /* ---------- 错题库清单 ---------- */
  function openWrongBook() {
    var id = readIdentity();
    if (!id) { toast('请先填写姓名、班级、学号'); return; }
    var book = loadWrong(id.sid);
    if (!book.length) { toast('错题库还是空的，先完成一次考核吧'); return; }

    var box = $('wrong-mask');
    if (!box) return;
    $('wrong-n').textContent = '（' + book.length + ' 题）';
    $('wrong-list').innerHTML = book.map(function (w, i) {
      var bankName = (BANK_META[w.bank] || {}).name || w.bank;
      var typeName = w.type === 'M' ? '多选' : '单选';
      var yourAns = (w.lastPicked && w.lastPicked.length) ? w.lastPicked.join('') : '未作答';
      return '<div class="wrong-item">' +
        '<div class="wq">' + (i + 1) + '. ' + esc(w.stem) + '</div>' +
        '<div class="wmeta">' +
          '<span class="bk">' + esc(bankName) + ' · ' + typeName + '</span>' +
          '<span class="no">你的答案：' + esc(yourAns) + '</span>' +
          '<span class="ok">正确答案：' + esc(w.answer.join('')) + '</span>' +
          '<span class="cnt">错 ' + (w.wrongCount || 1) + ' 次</span>' +
        '</div>' +
        '</div>';
    }).join('');
    $('wrong-start').textContent = '开始练习（' + book.length + ' 题）';
    box.hidden = false;
  }
  function closeWrongBook() { var b = $('wrong-mask'); if (b) b.hidden = true; }

  /* ---------- 错题练习 ---------- */
  function beginWrongPractice() {
    var id = readIdentity();
    if (!id) { toast('请先填写姓名、班级、学号'); return; }
    S.examinee = id;
    lsSet(LS_ID, id);
    var book = loadWrong(id.sid);
    if (!book.length) { toast('错题库还是空的，先完成一次考核吧'); return; }

    S.practice = true;
    S.paper = book.map(function (w) {
      return {
        id: w.id, bank: w.bank, type: w.type, stem: w.stem,
        options: w.options, answer: w.answer.slice(), picked: [],
      };
    });
    shuffle(S.paper);
    S.idx = 0; S.graded = false; S.filter = 'wrong';
    S.startAt = Date.now(); S.elapsed = 0; S.finishedAt = '';
    S.violation = null; S.timedOut = false; S.wrongLeft = 0;
    uploadState = { status: 'idle', msg: '', sub: '' };
    $('pill-who').textContent = id.name + ' · 错题练习（' + S.paper.length + ' 题）';
    $('btn-submit').disabled = false;
    $('btn-submit-top').disabled = false;
    startTimer();
    show('exam');
    renderExam();
    ensureSdk();
  }

  function beginExam() {
    var id = readIdentity();
    if (!id) return;                       // 信息不完整，阻止进入考试
    if ($('agree-rules') && !$('agree-rules').checked) {
      $('agree-msg').hidden = false;
      toast('请先阅读并勾选考试须知');
      return;
    }
    if ($('agree-msg')) $('agree-msg').hidden = true;
    S.examinee = id;
    lsSet(LS_ID, id);

    var btn = $('btn-start');
    if (!banksReady) {
      // 题库是异步加载的，通常早已就绪；万一点得太快就等一下
      btn.disabled = true;
      btn.textContent = '正在准备题库…';
      whenBanksReady(function (err) {
        btn.disabled = false;
        btn.textContent = '开始答题';
        if (err) { toast(err.message); return; }
        beginExam2();
      });
      return;
    }
    beginExam2();
  }

  function beginExam2() {
    runExamSetup();
  }

  function runExamSetup() {
    var btn = $('btn-start');
    btn.disabled = true;
    btn.textContent = '正在准备考场…';
    suppressGuard(20000);                  // 全屏授权期间的尺寸变化不算违规
    requestExamFullscreen().then(function () {
      btn.disabled = false;
      btn.textContent = '开始答题';
      startExam();
      startGuardWatch();
      suppressGuard(700);                  // 仅留 0.7 秒给全屏切换，避免「开考就分屏」被漏检
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '开始答题';
      startExam();
    });
  }

  function startExam() {
    S.paper = newPaper();
    S.idx = 0;
    S.graded = false;
    S.filter = 'wrong';
    S.startAt = Date.now();
    S.elapsed = 0;
    S.finishedAt = '';
    Array.prototype.forEach.call($('filter-seg').children, function (c) {
      c.classList.toggle('on', c.dataset.f === 'wrong');
    });
    $('btn-submit').disabled = false;
    $('btn-submit-top').disabled = false;
    uploadState = { status: 'idle', msg: '', sub: '' };
    renderUpload();
    $('pill-who').textContent = S.examinee.name + ' · ' + S.examinee.cls + ' · ' + S.examinee.sid;
    armGuard();                   // 启用分屏 / 截图检测
    startTimer();
    show('exam');
    renderExam();
    renderGuardStatus();
    if ($('violation-mask')) $('violation-mask').hidden = true;
    if ($('warning-mask')) $('warning-mask').hidden = true;
    ensureSdk();                  // 后台静默拉取云 SDK，等 35 分钟后交卷时早已就绪
  }

  /* ---------- 倒计时（限时 1 小时，归零自动交卷） ---------- */
  function secondsLeft() {
    return Math.max(0, LIMIT_SEC - Math.floor((Date.now() - S.startAt) / 1000));
  }

  function startTimer() {
    clearInterval(S.timer);
    if (S.practice) {                       // 错题练习不限时、不自动交卷
      var p0 = $('pill-timer');
      if (p0) { p0.className = 'pill'; p0.innerHTML = '<b>错题练习</b>'; }
      var b0 = $('time-banner');
      if (b0) b0.hidden = true;
      return;
    }
    updateTimer();
    S.timer = setInterval(function () {
      updateTimer();
      if (secondsLeft() <= 0) {
        stopTimer();
        if (!S.graded) grade({ timeout: true });
      }
    }, 1000);
  }

  function updateTimer() {
    var left = secondsLeft();
    S.elapsed = LIMIT_SEC - left;
    var pill = $('pill-timer');
    pill.className = 'pill' + (left <= 300 ? ' pill-danger' : (left <= 600 ? ' pill-warn' : ''));
    pill.innerHTML = '剩余 <b>' + fmtTime(left) + '</b>';

    var banner = $('time-banner');
    if (banner) {
      if (left <= 600) {
        banner.hidden = false;
        banner.textContent = '⏰ 距离交卷还剩 ' + fmtTime(left) + '，到时将自动交卷。';
      } else {
        banner.hidden = true;
      }
    }
    var level = left <= 60 ? 60 : (left <= 300 ? 300 : (left <= 600 ? 600 : 0));
    if (level && level !== S.warned) {
      S.warned = level;
      toast('剩余时间不足 ' + (level / 60) + ' 分钟');
    }
  }
  function stopTimer() { clearInterval(S.timer); S.timer = null; }

  /* ---------- 渲染答题页 ---------- */
  /* 填空题题干：把 ____ 换成行内输入框，保持句子连贯 */
  function fillStemHtml(item) {
    var parts = String(item.stem).split('____');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      out += esc(parts[i]);
      if (i < parts.length - 1) {
        var a = item.blanks[i] && item.blanks[i].ans ? String(item.blanks[i].ans) : '';
        var w = Math.max(4, Math.min(16, a.length + 2));
        out += '<input class="fillin" type="text" data-blank="' + i + '" size="' + w + '"' +
          ' autocomplete="off" autocapitalize="off" spellcheck="false"' +
          ' value="' + esc(item.inputs[i] || '') + '" placeholder="第 ' + (i + 1) + ' 空">';
      }
    }
    return out;
  }

  function isAnswered(it) {
    if (it.type === 'F') return fillAnswered(it);
    return it.picked.length > 0;
  }

  function renderExam() {
    var item = S.paper[S.idx];
    if (!item) return;
    var meta = BANK_META[item.bank] || { short: item.bank };
    var isMulti = item.type === 'M';
    var isFill = item.type === 'F';

    var typeLabel = isFill ? '填空' : (isMulti ? '多选' : '单选');
    var typeCls = isFill ? 'tag-fill' : (isMulti ? 'tag-multi' : 'tag-single');

    var html = '';
    html += '<div class="qhead">';
    html += '<span class="qno">第 ' + (S.idx + 1) + ' 题 / ' + qTotal() + '</span>';
    html += '<span class="tag ' + typeCls + '">' + typeLabel + '</span>';
    html += '<span class="tag tag-bank">' + esc(meta.short) + '</span>';
    if (isFill) html += '<span class="tag tag-bank">共 ' + item.blanks.length + ' 空</span>';
    html += '</div>';

    if (isFill) {
      html += '<div class="qstem fill-stem">' + fillStemHtml(item) + '</div>';
      html += '<p class="fill-tip">只填写空格处的内容，不要抄写题干；' +
        (item.blanks.length > 1 ? '本题共 ' + item.blanks.length + ' 空，<b>全部答对才得分</b>；' : '') +
        '标点、全半角、写法差异不影响判分。</p>';
    } else {
      html += '<div class="qstem">' + esc(item.stem) + '</div>';
      html += '<div class="opts">';
      item.options.forEach(function (o) {
        var on = item.picked.indexOf(o[0]) > -1;
        html += '<button type="button" class="opt' + (on ? ' on' : '') + '" data-opt="' + esc(o[0]) + '">' +
          '<span class="box' + (isMulti ? '' : ' round') + '">' + esc(o[0]) + '</span>' +
          '<span class="txt">' + esc(o[1]) + '</span></button>';
      });
      html += '</div>';
    }

    html += '<div class="qnav">' +
      '<button class="btn btn-ghost" id="btn-prev"' + (S.idx === 0 ? ' disabled' : '') + '>上一题</button>' +
      '<span class="hint">' + (isFill ? '填空题：直接输入答案' : (isMulti ? '多选题：可选择多个选项' : '单选题：选择 1 个选项')) + '</span>' +
      '<div class="spacer"></div>' +
      '<span class="hint">' + (isFill ? '用鼠标或 <kbd>Tab</kbd> 在空格间切换'
        : '按 <kbd>A</kbd>~<kbd>H</kbd> 或 <kbd>1</kbd>~<kbd>8</kbd> 选择') +
      '，<kbd>←</kbd><kbd>→</kbd> 翻页</span>' +
      '<button class="btn ' + (S.idx === qTotal() - 1 ? 'btn-ghost' : 'btn-primary') + '" id="btn-next">' +
      (S.idx === qTotal() - 1 ? '最后一题' : '下一题') + '</button>' +
      '</div>';

    $('qcard').innerHTML = html;

    if (isFill) {
      var inputs = $('qcard').querySelectorAll('.fillin');
      Array.prototype.forEach.call(inputs, function (inp) {
        inp.addEventListener('input', function () {
          var k = parseInt(this.dataset.blank, 10);
          item.inputs[k] = this.value;
          renderCards();
          renderProgress();
        });
      });
      var first = inputs[0];
      if (first && S.focusFill) { try { first.focus(); } catch (e) {} }
      S.focusFill = false;
    } else {
      $('qcard').querySelector('.opts').addEventListener('click', function (e) {
        var btn = e.target.closest('.opt'); if (!btn) return;
        pick(btn.dataset.opt);
      });
    }

    $('btn-prev').addEventListener('click', function () { go(S.idx - 1); });
    $('btn-next').addEventListener('click', function () { go(S.idx + 1); });

    renderCards();
    renderProgress();
  }

  function renderCards() {
    $('cards').innerHTML = S.paper.map(function (it, i) {
      var cls = 'cell' + (isAnswered(it) ? ' done' : '') + (i === S.idx ? ' cur' : '');
      return '<button class="' + cls + '" data-i="' + i + '">' + (i + 1) + '</button>';
    }).join('');
  }

  function renderProgress() {
    var done = S.paper.filter(isAnswered).length;
    $('pill-progress').innerHTML = '已答 <b>' + done + '</b>/' + qTotal();
    $('bar-fill').style.width = (done / qTotal() * 100) + '%';
  }

  $('cards').addEventListener('click', function (e) {
    var b = e.target.closest('.cell'); if (!b) return;
    go(parseInt(b.dataset.i, 10));
  });

  function pick(label) {
    var item = S.paper[S.idx];
    if (S.graded || !item || item.type === 'F') return;
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
    if (i < 0 || i >= qTotal()) return;
    S.idx = i;
    renderExam();
  }

  /* ---------- 交卷与判分 ---------- */
  function submit() {
    var blank = S.paper.filter(function (it) { return !isAnswered(it); }).length;
    var tip = blank
      ? '还有 <b>' + blank + '</b> 道题未作答，未作答的题目将按答错计分。<br>确定现在交卷吗？'
      : '确定交卷并判分吗？';
    confirmBox('交卷确认', tip, '确定交卷', '继续答题').then(function (ok) {
      if (ok) grade();
    });
  }

  function isItemRight(it) {
    if (it.type === 'F') return isFillRight(it);
    return it.picked.length > 0 && sameSet(it.picked, it.answer);
  }

  function grade(opts) {
    if (S.graded) return;
    opts = opts || {};
    stopTimer();
    disarmGuard();
    exitExamFullscreen();
    S.elapsed = Math.floor((Date.now() - S.startAt) / 1000);
    if (S.elapsed > LIMIT_SEC) S.elapsed = LIMIT_SEC;
    S.finishedAt = fmtDate();
    S.graded = true;
    if (opts.violation) S.violation = opts.violation;
    if (opts.timeout) S.timedOut = true;

    var right = 0, wrong = 0, blank = 0, items = [];
    var byBank = {};
    S.paper.forEach(function (it, i) {
      var ok = isItemRight(it);
      var blankQ = !isAnswered(it);
      if (ok) right++; else { wrong++; if (blankQ) blank++; }
      items.push({ no: i + 1, item: it, ok: ok, blank: blankQ });

      var b = byBank[it.bank] || (byBank[it.bank] = { total: 0, right: 0, wrong: 0 });
      b.total++;
      if (ok) b.right++; else b.wrong++;
    });

    if (!S.practice) {
      // 记录「已做过」：本卷全部题目并入该学号的已做集合
      var sid = S.examinee.sid;
      var seen = S.seen || {};
      S.paper.forEach(function (it) { if (it.id) seen[it.id] = 1; });
      saveSeen(sid, seen);
    }
    S.wrongLeft = updateWrongBook(items);     // 错题库：答错收录、答对移出

    var score = right * PER_SCORE;
    S.result = {
      score: score, right: right, wrong: wrong, blank: blank,
      items: items, byBank: byBank,
    };

    if (!S.practice) saveRecord({
      time: S.finishedAt,
      name: S.examinee.name, cls: S.examinee.cls, sid: S.examinee.sid,
      score: Math.round(score * 100) / 100, right: right, wrong: wrong, blank: blank,
      used: fmtTime(S.elapsed), rate: Math.round(right / qTotal() * 100) + '%',
      violation: S.violation ? S.violation.code : '',
      timeout: !!S.timedOut,
    });

    renderResult();
    show('result');
    // 交卷即上传。违规要尽快送达教师端（错峰窗口小）；超时自动交卷是大面积同时发生，
    // 用较大的随机错峰把写入摊开，避免同一秒的集中写入触发平台限流。
    // 错峰窗口按「可能同时交卷的人数」放大：
    //   冲突交卷：个案 → 0.8 秒；正常交卷：学生陆续完成 → 4 秒；
    //   超时交卷：**所有人同时到点**，是最集中的写入峰值 → 放宽到 60 秒，
    //            1000 人时约 17 条/秒，远低于平台限流阈值；晚 1 分钟上传不影响成绩。
    if (!S.practice) submitUpload(false, S.violation ? 800 : (S.timedOut ? 60000 : 4000));
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

    /* 违规 / 超时提示条 */
    var vb = $('result-violation');
    if (vb) {
      if (S.violation) {
        vb.hidden = false;
        vb.className = 'result-alert bad';
        vb.innerHTML = '<b>本次考核已被判定为违规</b>　' +
          esc(VIOLATIONS[S.violation.code] || S.violation.code) +
          (S.violation.detail ? '：' + esc(S.violation.detail) : '') +
          '<br><span class="hint">记录已实时上报教师端，教师名单中该条成绩会标红显示。</span>';
      } else if (S.timedOut) {
        vb.hidden = false;
        vb.className = 'result-alert warn';
        vb.innerHTML = '<b>答题时间已用完，系统自动交卷</b>' +
          '<br><span class="hint">限时 ' + LIMIT_MIN + ' 分钟，超时自动交卷不属于违规行为。</span>';
      } else {
        vb.hidden = true;
        vb.innerHTML = '';
      }
    }

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
      '<div class="s"><b>' + (R.right / qTotal() * 100).toFixed(0) + '%</b><span>正确率</span></div>';

    renderBankTable();

    $('review-count').textContent = '共答错 ' + R.wrong + ' 题' + (R.blank ? '（其中未作答 ' + R.blank + ' 题）' : '');
    renderReview();
  }

  /* 分题库得分表 */
  function renderBankTable() {
    var byBank = S.result.byBank;
    var order = BANK_ORDER;
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
      var isFill = it.type === 'F';
      var isMulti = it.type === 'M';
      var typeLabel = isFill ? '填空' : (isMulti ? '多选' : '单选');
      var typeCls = isFill ? 'tag-fill' : (isMulti ? 'tag-multi' : 'tag-single');

      var head = '<div class="rhead">' +
        '<span class="qno">第 ' + rec.no + ' 题</span>' +
        '<span class="tag ' + typeCls + '">' + typeLabel + '</span>' +
        '<span class="tag tag-bank">' + esc(meta.name) + '</span>' +
        '<span class="verdict-chip ' + (rec.ok ? 'good' : 'bad') + '">' +
        (rec.ok ? '答对' : (rec.blank ? '未作答' : '答错')) + '</span>' +
        '</div>';

      if (isFill) {
        var filled = String(it.stem);
        it.blanks.forEach(function (b) { filled = filled.replace('____', '【' + b.ans + '】'); });
        var blanks = it.blanks.map(function (b, bi) {
          var raw = String(it.inputs[bi] || '').trim();
          var okB = isBlankRight(b, it.inputs[bi]);
          return '<div class="rblank ' + (okB ? 'correct' : 'chosen-wrong') + '">' +
            '<span class="lb">第 ' + (bi + 1) + ' 空</span>' +
            '<span class="yv">你的答案：<b>' + esc(raw || '未作答') + '</b></span>' +
            '<span class="rb ' + (okB ? 'ok' : 'no') + '">' + (okB ? '正确' : '错误') + '</span>' +
            '</div>';
        }).join('');
        var std = it.blanks.map(function (b) { return b.ans; }).join('　|　');
        return '<div class="review ' + (rec.ok ? 'right' : 'wrong') + '">' + head +
          '<div class="stem">' + esc(it.stem) + '</div>' +
          '<div class="rblanks">' + blanks + '</div>' +
          '<div class="answers">' +
          '<span class="kv hit">标准答案：<b>' + esc(std) + '</b></span>' +
          '</div>' +
          '<div class="fill-ref">参考答案：' + esc(filled) + '</div>' +
          '</div>';
      }

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

      return '<div class="review ' + (rec.ok ? 'right' : 'wrong') + '">' + head +
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
    h.push('<p class="sub">军事技能训练理论 · 学生手册 · 安全知识　　全卷 ' + TOTAL_Q +
      ' 题，每题 ' + PER_SCORE + ' 分，满分 ' + FULL_SCORE + ' 分</p>');

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
      '</td><td>' + R.blank + '</td><td>' + (R.right / qTotal() * 100).toFixed(0) + '%</td></tr></table>');
    h.push('<p class="note">考核限时 ' + LIMIT_MIN + ' 分钟，实际用时 ' + fmtTime(S.elapsed) + '。' +
      (S.violation
        ? '<b>考核状态：违规（' + esc(VIOLATIONS[S.violation.code] || S.violation.code) + '）</b>，系统已立即交卷。'
        : (S.timedOut ? '<b>考核状态：超时自动交卷</b>。' : '考核状态：正常交卷。')) +
      '</p>');

    h.push('<h2>二、分题库得分</h2>');
    h.push('<table><tr><th>来源题库</th><th>抽题数</th><th>答对</th><th>答错</th><th>得分</th></tr>');
    var tR = 0, tW = 0, tS = 0;
    BANK_ORDER.forEach(function (key) {
      var b = R.byBank[key];
      if (!b) return;
      var meta = BANK_META[key] || { name: key };
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
      var verdict = rec.ok ? '【答对】' : (rec.blank ? '【未作答】' : '【答错】');
      var typeTxt = it.type === 'F' ? '［填空］' : (it.type === 'M' ? '［多选］' : '［单选］');

      if (it.type === 'F') {
        var lines = it.blanks.map(function (b, bi) {
          var raw = String(it.inputs[bi] || '').trim();
          var okB = isBlankRight(b, it.inputs[bi]);
          return '<p class="qo ' + (okB ? 'ok' : 'no') + '">第 ' + (bi + 1) + ' 空：' +
            esc(raw || '未作答') + '　→　标准答案 ' + esc(b.ans) + (okB ? '　√' : '　×') + '</p>';
        }).join('');
        var ref = String(it.stem);
        it.blanks.forEach(function (b) { ref = ref.replace('____', '【' + b.ans + '】'); });
        h.push('<div class="q">' +
          '<p class="qt">第 ' + rec.no + ' 题　' + typeTxt + ' ' + esc(meta.name) + '　' + verdict + '</p>' +
          '<p class="qs">' + esc(it.stem) + '</p>' + lines +
          '<p class="qa">参考答案：' + esc(ref) + '</p>' +
          '</div>');
        return;
      }

      var opts = it.options.map(function (o) {
        var isAns = it.answer.indexOf(o[0]) > -1;
        var isPick = it.picked.indexOf(o[0]) > -1;
        var cls = isAns ? 'qo ok' : (isPick ? 'qo no' : 'qo');
        var mark = isAns ? '　【正确答案】' : (isPick ? '　【误选】' : '');
        return '<p class="' + cls + '">' + esc(o[0]) + '．' + esc(o[1]) + mark + '</p>';
      }).join('');
      h.push('<div class="q">' +
        '<p class="qt">第 ' + rec.no + ' 题　' + typeTxt +
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
  function inTextField(t) {
    if (!t) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }

  document.addEventListener('keydown', function (e) {
    if ($('modal-mask').classList.contains('open')) {
      if (e.key === 'Escape') closeModal(false);
      if (e.key === 'Enter') closeModal(true);
      return;
    }
    if (!$('screen-exam').classList.contains('active') || S.graded) return;
    if (inTextField(e.target)) return;        // 填空输入框内让方向键/字母正常输入

    var k = e.key;
    if (k === 'ArrowLeft')  { go(S.idx - 1); e.preventDefault(); return; }
    if (k === 'ArrowRight') { go(S.idx + 1); e.preventDefault(); return; }

    var it = S.paper[S.idx];
    if (!it || it.type === 'F' || !it.options) return;
    var idx = -1;
    if (/^[a-hA-H]$/.test(k)) idx = k.toUpperCase().charCodeAt(0) - 65;
    else if (/^[1-8]$/.test(k)) idx = parseInt(k, 10) - 1;
    if (idx < 0) return;
    if (idx < it.options.length) { pick(it.options[idx][0]); e.preventDefault(); }
  });

  /* ---------- 按钮绑定 ---------- */
  if ($('warning-ok')) {
    $('warning-ok').addEventListener('click', function () { $('warning-mask').hidden = true; });
  }
  if ($('violation-ok')) {
    $('violation-ok').addEventListener('click', function () { $('violation-mask').hidden = true; });
  }

  if ($('btn-login')) $('btn-login').addEventListener('click', doLogin);
  ['login-id', 'login-name'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
    if (el) el.addEventListener('input', clearLoginError);
  });
  if ($('btn-logout')) $('btn-logout').addEventListener('click', doLogout);

  /* 顶部导航与功能卡 */
  Array.prototype.forEach.call(document.querySelectorAll('[data-pane]'), function (b) {
    if (b.classList.contains('nav-btn') || b.classList.contains('tool')) {
      b.addEventListener('click', function () { switchPane(b.dataset.pane); });
    }
  });
  if ($('tool-star')) {
    $('tool-star').addEventListener('click', function () {
      toast('标星收藏即将上线：可以先在错题本里刷错题');
      switchPane('wrong');
    });
  }
  if ($('tool-check')) {
    $('tool-check').addEventListener('click', function () {
      var bad = 0, total = 0, dups = 0, seenQ = {};
      RULES[0].banks.forEach(function (b) {
        (BANKS[b] || []).forEach(function (q) {
          total++;
          if (!q.q || !q.o || !q.a || !q.a.length) bad++;
          var k = b + '|' + q.q;
          if (seenQ[k]) dups++; else seenQ[k] = 1;
        });
      });
      toast('题库自检：共 ' + total + ' 题，字段异常 ' + bad + ' 题，重复题干 ' + dups + ' 题');
    });
  }

  $('btn-start').addEventListener('click', beginExam);
  if ($('btn-practice')) $('btn-practice').addEventListener('click', beginWrongPractice);
  if ($('wrong-close')) $('wrong-close').addEventListener('click', closeWrongBook);
  if ($('wrong-cancel')) $('wrong-cancel').addEventListener('click', closeWrongBook);
  if ($('wrong-start')) {
    $('wrong-start').addEventListener('click', function () {
      closeWrongBook();
      beginWrongPractice();
    });
  }
  if ($('wrong-mask')) {
    $('wrong-mask').addEventListener('click', function (e) {
      if (e.target === this) closeWrongBook();
    });
  }
  $('btn-submit').addEventListener('click', submit);
  $('btn-submit-top').addEventListener('click', submit);
  $('btn-doc').addEventListener('click', downloadDoc);

  ['in-name', 'in-class', 'in-id'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', function () { renderPracticeBtn(); });
  });

  if ($('agree-rules')) {
    $('agree-rules').addEventListener('change', function () {
      if (this.checked && $('agree-msg')) $('agree-msg').hidden = true;
    });
  }

  $('btn-abort').addEventListener('click', function () {
    confirmBox('退出考试', '退出后当前试卷的作答将会丢失，确定退出吗？', '退出', '继续答题')
      .then(function (ok) { if (ok) { stopTimer(); show('start'); renderHistory(); } });
  });

  $('btn-again').addEventListener('click', function () {
    beginExam();
    toast('已重新随机生成一套新试卷');
  });
  $('btn-home').addEventListener('click', function () {
    renderHistory();
    show('start');
    switchPane('home');
    renderHello();
    renderBankCards();
    renderPracticeBtn();
  });
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
  bootAuth();                   // 未登录先显示登录页，已登录直接进首页
  flushPending();               // 启动时补传上次未成功的成绩
})();
