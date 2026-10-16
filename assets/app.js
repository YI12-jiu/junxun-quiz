/* ============================================================
   综合考核系统 —— 随机组卷 / 自动判分 / 错题回溯
   题库：军事技能训练理论 · 学生手册 · 安全知识
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 抽题规则（恢复为最初的规则） ---------- */
  /* 全卷 40 题：安全知识 4 题（单选/多选不限）+ 军事技能训练理论 23 题（其中多选 6）
     + 学生手册 13 题（其中多选 4）；每题 2.5 分，满分 100 分。
     填空题已按要求下线 —— assets/banks_fill.js 与判分代码仍保留，
     需要重新启用时在下面加回 { bank: 'zib', fill: 10, ... } 并在 index.html 引入该文件即可。 */
  var RULES = [
    { bank: 'saf', fill: 0, multi: 0, single: 0,  any: 4 },  // 安全知识：4 题，题型不限
    { bank: 'mil', fill: 0, multi: 6, single: 17, any: 0 },  // 军事技能训练理论：23 题，其中多选 6
    { bank: 'stu', fill: 0, multi: 4, single: 9,  any: 0 },  // 学生手册：13 题，其中多选 4
  ];
  var PER_SCORE  = 2.5;                        // 每题 2.5 分
  var FULL_SCORE = 100;                        // 满分 100 分
  var PASS_SCORE = 60;                         // 及格线
  var LIMIT_SEC  = 60 * 60;                    // 单次考核限时：1 小时
  var TOTAL_Q    = RULES.reduce(function (n, r) {
    return n + (r.any || 0) + r.fill + r.multi + r.single;
  }, 0); // 40
  var BANK_META  = window.BANK_META || {};
  var BANKS      = window.BANKS || {};

  /* 违规类型：一经触发立刻交卷，同时上报云端供教师端标红报警 */
  var VIOLATIONS = {
    leave:      '退出考试界面',
    screenshot: '截屏',
    split:      '分屏 / 调整窗口',
    copy:       '复制粘贴',
    sound:      '环境声音',
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
  function buildPaper(mode) {
    var paper = [];
    RULES.forEach(function (rule) {
      var pool    = BANKS[rule.bank] || [];
      var fills   = pool.filter(function (x) { return x.t === 'F'; });
      var multis  = pool.filter(function (x) { return x.t === 'M'; });
      var singles = pool.filter(function (x) { return x.t !== 'M' && x.t !== 'F'; });

      var picked = [];
      if (rule.any) {                                  // 题型不限：从该库全部题目里随机抽
        var rest = pool.filter(function (x) { return x.t !== 'F'; });
        picked = picked.concat(shuffle(rest.slice()).slice(0, Math.min(rule.any, rest.length)));
      }
      if (rule.fill)   picked = picked.concat(shuffle(fills.slice()).slice(0, Math.min(rule.fill, fills.length)));
      if (rule.multi)  picked = picked.concat(shuffle(multis.slice()).slice(0, Math.min(rule.multi, multis.length)));
      if (rule.single) picked = picked.concat(shuffle(singles.slice()).slice(0, Math.min(rule.single, singles.length)));

      var want = (rule.any || 0) + rule.fill + rule.multi + rule.single;
      if (picked.length !== want) {
        throw new Error('题库题量不足：「' + ((BANK_META[rule.bank] || {}).name || rule.bank) +
          '」需要 ' + want + ' 题（题型不限 ' + (rule.any || 0) + ' / 填空 ' + rule.fill +
          ' / 多选 ' + rule.multi + ' / 单选 ' + rule.single +
          '），实际只抽到 ' + picked.length + ' 题；该库现有填空 ' + fills.length +
          ' 题、多选 ' + multis.length + ' 题、单选 ' + singles.length + ' 题。');
      }
      shuffle(picked).forEach(function (q) { paper.push(makeItem(rule.bank, q)); });
    });

    if (mode === 'grouped') {
      var order = ['zib', 'saf', 'mil', 'stu'];
      paper.sort(function (a, b) { return order.indexOf(a.bank) - order.indexOf(b.bank); });
    } else {
      shuffle(paper);
    }
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
    violation: null,          // { code, detail, at }
    timedOut: false,          // 是否因超时自动交卷
    warned: 0,                // 已提示过的剩余时间档位
    focusFill: false,
  };

  /* ---------- 首页 ---------- */
  function renderStart() {
    var bankTotal = RULES.reduce(function (n, r) { return n + (BANKS[r.bank] || []).length; }, 0);
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
      { k: '考核限时', v: 60, s: '分钟，到时自动交卷' },
      { k: '题库总量', v: bankTotal, s: '题（' + RULES.length + ' 个题库合并）' },
    ];
    $('start-stats').innerHTML = cards.map(function (c) {
      return '<div class="stat"><div class="k">' + esc(c.k) + '</div>' +
        '<div class="v">' + esc(c.v) + '<em> ' + esc(c.s) + '</em></div></div>';
    }).join('');

    var rows = RULES.map(function (r) {
      var m = BANK_META[r.bank] || { name: r.bank };
      var pool = BANKS[r.bank] || [];
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
      return '<li><b>' + esc(m.name) + '</b>：随机抽 ' + parts.join(' + ') +
        '（共 ' + tot + ' 题）　<span class="hint">（题库 ' + pool.length +
        ' 题：' + typ.join(' / ') + '）</span></li>';
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
      sound_monitored: !!GUARD.soundOk,
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
    var cloud = getCloud();
    if (!cloud) return Promise.reject(new Error('cloud-sdk-unavailable'));
    return Promise.resolve(cloud.database.from(CC.table).insert(payload))
      .then(function (res) {
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

  function submitUpload(silent) {
    if (uploadBusy) return;
    if (!CC) return;
    uploadBusy = true;
    var payload = buildPayload();
    var k = pendKey(payload);
    if (!silent) {
      uploadState = { status: 'busy', msg: '正在上传成绩…', sub: '' };
      renderUpload();
    }
    insertRecord(payload).then(function () {
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
        : (msg.indexOf('cloud-sdk-unavailable') > -1 ? '云服务组件未加载，请检查网络后刷新页面' : '网络异常或服务暂时不可用');
      uploadState = {
        status: 'err', msg: '成绩上传失败',
        sub: why + '；已在本机暂存，可点击「重试上传」，不影响本次得分与成绩单下载。',
      };
    }).then(function () {
      uploadBusy = false;
      renderUpload();
    });
  }

  /* 成绩单始终可下载：本地记录 + 云端记录互为备份 */

  /* ---------- 屏幕切换 ---------- */
  function show(name) {
    ['screen-start', 'screen-exam', 'screen-result'].forEach(function (id) {
      $(id).classList.toggle('active', id === 'screen-' + name);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ============================================================
     考场行为管控
     五类违规：退出界面 / 截屏 / 分屏 / 复制粘贴 / 环境声音
     任一触发 → 立即交卷 + 结果页醒目提示 + 成绩随记录上报云端（教师端标红报警）
     ============================================================ */
  var GUARD = {
    armed: false,          // 是否处于管控中（进入考试后开启）
    fired: false,          // 本次考核是否已触发违规
    suppressUntil: 0,      // 抑制窗口：全屏/授权弹窗自身造成的失焦不算违规
    fsOk: false,           // 浏览器是否支持并成功进入全屏
    soundOk: false,        // 是否成功开启麦克风声音监测
    soundHits: 0,
    soundDb: -100,         // 当前环境声音电平（dBFS）
    soundPeakDb: -100,     // 本次考核测到的最高电平
    soundTimer: null,
    soundBuf: null,
    audioCtx: null,
    micStream: null,
    splitSince: 0,
    watchTimer: null,
  };

  /* ---------- 环境声音限值 ----------
     浏览器只能测「相对满量程电平」（dBFS），无法测真实声压级（dB SPL 需要校准过的麦克风），
     所以这里的「25 分贝」实现为：瞬时声级超过 -25 dBFS 即视为超标。
     参考：安静房间约 -55 dBFS，小声交谈约 -40 dBFS，正常说话约 -25 ~ -30 dBFS，数值越大越吵。
     超标需连续保持 SOUND_HOLD 次采样才判违规，避免单次爆音（关门、咳嗽）误伤。 */
  var SOUND_DB_LIMIT = -25;    // 限值（dBFS），超过即违规
  var SOUND_HOLD     = 5;      // 连续超标次数（每 100ms 一次，约 0.5 秒）
  var SOUND_FLOOR    = -100;   // 电平下限，避免 log(0)
  var SPLIT_MIN_SCREEN = 1100; // 屏幕窄于此值时不判定分屏（避免小屏误报）

  /* 设定抑制窗口：ms 毫秒内不判定违规。
     注意必须「直接覆盖」而不是取最大值——开考前的准备窗口（20 秒）会被进入考试后的
     1.5 秒缓冲覆盖掉，否则考试开始后的前 20 秒管控形同虚设。 */
  function suppressGuard(ms) {
    GUARD.suppressUntil = Date.now() + ms;
  }
  function guardActive() {
    return GUARD.armed && !GUARD.fired && !S.graded && Date.now() >= GUARD.suppressUntil;
  }

  function trip(code, detail) {
    if (!guardActive()) return false;
    GUARD.fired = true;
    S.violation = { code: code, detail: detail, at: new Date() };
    try { grade({ violation: S.violation }); } catch (e) {}
    showViolationMask();
    return true;
  }

  function armGuard() {
    GUARD.armed = true;
    GUARD.fired = false;
    GUARD.splitSince = 0;
    GUARD.soundHits = 0;
    GUARD.soundDb = SOUND_FLOOR;
    GUARD.soundPeakDb = SOUND_FLOOR;
    S.violation = null;
    S.timedOut = false;
    S.warned = 0;
  }
  function disarmGuard() {
    GUARD.armed = false;
    stopSoundMonitor();
    clearInterval(GUARD.watchTimer);
    GUARD.watchTimer = null;
  }

  /* ---- 全屏 ---- */
  function requestExamFullscreen() {
    var el = document.documentElement;
    if (!el.requestFullscreen) { GUARD.fsOk = false; return Promise.resolve(false); }
    return Promise.resolve(el.requestFullscreen()).then(function () {
      GUARD.fsOk = true;
      return true;
    }).catch(function () { GUARD.fsOk = false; return false; });
  }
  function exitExamFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen(); } catch (e) {}
    }
  }

  /* ---- 环境声音（麦克风 + Web Audio） ---- */
  function startSoundMonitor() {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { GUARD.soundOk = false; return Promise.resolve(false); }
    return Promise.resolve(md.getUserMedia({ audio: true })).then(function (stream) {
      GUARD.micStream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { GUARD.soundOk = false; return false; }
      var ctx = new Ctx();
      if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      GUARD.audioCtx = ctx;
      GUARD.soundBuf = new Uint8Array(analyser.fftSize);
      GUARD.soundOk = true;
      GUARD.soundTimer = setInterval(function () {
        if (!guardActive() || !GUARD.soundBuf) return;
        analyser.getByteTimeDomainData(GUARD.soundBuf);
        var sum = 0;
        for (var i = 0; i < GUARD.soundBuf.length; i++) {
          var v = (GUARD.soundBuf[i] - 128) / 128;
          sum += v * v;
        }
        var rms = Math.sqrt(sum / GUARD.soundBuf.length);
        var db = rms > 0 ? 20 * Math.log10(rms) : SOUND_FLOOR;
        if (!isFinite(db) || db < SOUND_FLOOR) db = SOUND_FLOOR;
        GUARD.soundDb = db;
        if (db > GUARD.soundPeakDb) GUARD.soundPeakDb = db;
        renderSoundMeter();

        if (db > SOUND_DB_LIMIT) GUARD.soundHits++;
        else if (GUARD.soundHits > 0) GUARD.soundHits--;
        if (GUARD.soundHits >= SOUND_HOLD) {
          trip('sound', '环境声音 ' + db.toFixed(1) + ' dB，超过限值 ' + SOUND_DB_LIMIT +
            ' dB 并持续约 ' + (SOUND_HOLD / 10).toFixed(1) + ' 秒');
        }
      }, 100);
      return true;
    }).catch(function () { GUARD.soundOk = false; return false; });
  }

  /* 实时声级显示：让考生自己看得见当前电平与限值的差距 */
  function renderSoundMeter() {
    var el = $('sound-meter');
    if (!el) return;
    var db = GUARD.soundDb;
    var over = db > SOUND_DB_LIMIT;
    el.className = 'gmeter' + (over ? ' over' : '');
    el.textContent = '环境声音 ' + (db <= SOUND_FLOOR ? '--' : db.toFixed(1)) +
      ' dB　限值 ' + SOUND_DB_LIMIT + ' dB';
  }
  function stopSoundMonitor() {
    clearInterval(GUARD.soundTimer);
    GUARD.soundTimer = null;
    try { if (GUARD.micStream) GUARD.micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (GUARD.audioCtx && GUARD.audioCtx.close) GUARD.audioCtx.close(); } catch (e) {}
    GUARD.micStream = null;
    GUARD.audioCtx = null;
  }

  /* ---- 事件监听（常驻注册，靠 guardActive() 判断是否生效） ---- */
  document.addEventListener('visibilitychange', function () {
    if (!guardActive()) return;
    if (document.hidden) trip('leave', '切换到其他标签页 / 最小化了窗口');
  });

  window.addEventListener('blur', function () {
    if (!guardActive()) return;
    trip('leave', '考试窗口失去焦点（切到了别的窗口或程序）');
  });

  window.addEventListener('pagehide', function () {
    if (!guardActive()) return;
    trip('leave', '离开了考试页面');
  });

  document.addEventListener('fullscreenchange', function () {
    if (!guardActive() || !GUARD.fsOk) return;
    if (!document.fullscreenElement) trip('split', '退出了全屏（可能进入了分屏或调整了窗口）');
  });

  document.addEventListener('keydown', function (e) {
    if (!guardActive()) return;
    if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
      trip('screenshot', '按下截屏键 PrintScreen');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      var k = String(e.key || '').toLowerCase();
      if (k === 'c' || k === 'x' || k === 'v') {
        trip('copy', '使用快捷键 ' + (e.metaKey ? 'Cmd' : 'Ctrl') + '+' + k.toUpperCase());
      }
    }
  }, true);

  ['copy', 'cut', 'paste'].forEach(function (ev) {
    var label = { copy: '复制', cut: '剪切', paste: '粘贴' }[ev];
    document.addEventListener(ev, function (e) {
      if (e.preventDefault) e.preventDefault();
      if (!guardActive()) return;
      trip('copy', '触发了' + label + '操作');
    }, true);
  });

  document.addEventListener('contextmenu', function (e) {
    if (e.preventDefault) e.preventDefault();
    if (!guardActive()) return;
    trip('copy', '打开了右键菜单');
  }, true);

  /* ---- 周期性巡检：分屏 / 全屏状态 ---- */
  function checkSplit() {
    if (!guardActive()) { GUARD.splitSince = 0; return; }
    var sw = (window.screen && window.screen.availWidth) || 0;
    var w = window.outerWidth || window.innerWidth || 0;
    if (sw < SPLIT_MIN_SCREEN || !w) { GUARD.splitSince = 0; return; }
    if (w < sw * 0.85) {
      if (!GUARD.splitSince) GUARD.splitSince = Date.now();
      else if (Date.now() - GUARD.splitSince > 1500) {
        trip('split', '窗口宽度仅占屏幕的 ' + Math.round(w / sw * 100) + '%（疑似分屏）');
      }
    } else {
      GUARD.splitSince = 0;
    }
  }
  window.addEventListener('resize', checkSplit);
  function startGuardWatch() {
    clearInterval(GUARD.watchTimer);
    GUARD.watchTimer = setInterval(checkSplit, 1000);
  }

  /* ---------- 开始考试 ---------- */
  function withTimeout(p, ms, fallback) {
    return Promise.race([
      Promise.resolve(p).catch(function () { return fallback; }),
      new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); }),
    ]);
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
    btn.disabled = true;
    btn.textContent = '正在准备考场…';
    suppressGuard(20000);                  // 全屏 + 麦克风授权期间自身造成的失焦不算违规

    requestExamFullscreen().then(function () {
      return withTimeout(startSoundMonitor(), 15000, false);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '开始答题';
      startExam();
      startGuardWatch();
      suppressGuard(1500);                 // 进入考试后留 1.5 秒缓冲，避免首帧误判
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '开始答题';
      startExam();
    });
  }

  function startExam() {
    S.paper = newPaper(S.mode);
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
    $('violation-mask').hidden = true;
    renderGuardStatus();
    $('pill-who').textContent = S.examinee.name + ' · ' + S.examinee.cls + ' · ' + S.examinee.sid;
    armGuard();
    startTimer();
    show('exam');
    renderExam();
  }

  /* ---------- 倒计时（限时 1 小时，归零自动交卷） ---------- */
  function secondsLeft() {
    return Math.max(0, LIMIT_SEC - Math.floor((Date.now() - S.startAt) / 1000));
  }

  function startTimer() {
    clearInterval(S.timer);
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

  /* 考场状态条：说明当前哪几项管控已生效 */
  function renderGuardStatus() {
    var el = $('guard-status');
    if (!el) return;
    var items = [
      ['退出/切屏拦截', true],
      ['截屏拦截', true],
      ['全屏与分屏拦截', GUARD.fsOk],
      ['复制粘贴拦截', true],
      ['环境声音监测', GUARD.soundOk],
    ];
    el.innerHTML = items.map(function (it) {
      return '<span class="gitem ' + (it[1] ? 'on' : 'off') + '">' + (it[1] ? '✔' : '✖') + ' ' + esc(it[0]) + '</span>';
    }).join('') +
      (GUARD.soundOk
        ? '<span class="gmeter" id="sound-meter">环境声音 -- dB　限值 ' + SOUND_DB_LIMIT + ' dB</span>'
        : '<span class="gnote">未取得麦克风授权，本次不监测环境声音（成绩单会如实标注）</span>');
    if (GUARD.soundOk) renderSoundMeter();
  }

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
    html += '<span class="qno">第 ' + (S.idx + 1) + ' 题 / ' + TOTAL_Q + '</span>';
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
      '<button class="btn ' + (S.idx === TOTAL_Q - 1 ? 'btn-ghost' : 'btn-primary') + '" id="btn-next">' +
      (S.idx === TOTAL_Q - 1 ? '最后一题' : '下一题') + '</button>' +
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
    $('pill-progress').innerHTML = '已答 <b>' + done + '</b>/' + TOTAL_Q;
    $('bar-fill').style.width = (done / TOTAL_Q * 100) + '%';
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
    if (i < 0 || i >= TOTAL_Q) return;
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
      violation: S.violation ? S.violation.code : '',
      timeout: !!S.timedOut,
    });

    renderResult();
    show('result');
    submitUpload(false);          // 交卷即上传（违规记录同样立即上报，教师端随即报警）
  }

  /* ---------- 违规提示 ---------- */
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
          '<br><span class="hint">限时 60 分钟，超时自动交卷不属于违规行为。</span>';
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
    h.push('<p class="note">考核限时 60 分钟，实际用时 ' + fmtTime(S.elapsed) + '。' +
      (S.violation
        ? '<b>考核状态：违规（' + esc(VIOLATIONS[S.violation.code] || S.violation.code) + '）</b>，系统已立即交卷。'
        : (S.timedOut ? '<b>考核状态：超时自动交卷</b>。' : '考核状态：正常交卷。')) +
      '　环境声音监测：' + (GUARD.soundOk
        ? '已开启（限值 ' + SOUND_DB_LIMIT + ' dB，本次最高 ' +
          (GUARD.soundPeakDb <= SOUND_FLOOR ? '--' : GUARD.soundPeakDb.toFixed(1)) + ' dB）'
        : '未开启（未取得麦克风授权）') + '。</p>');

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
    if ($('violation-mask') && !$('violation-mask').hidden) {
      if (e.key === 'Escape' || e.key === 'Enter') $('violation-mask').hidden = true;
      return;
    }
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
  $('btn-start').addEventListener('click', beginExam);
  $('btn-submit').addEventListener('click', submit);
  $('btn-submit-top').addEventListener('click', submit);
  $('btn-doc').addEventListener('click', downloadDoc);

  if ($('violation-ok')) {
    $('violation-ok').addEventListener('click', function () { $('violation-mask').hidden = true; });
  }
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
  flushPending();               // 启动时补传上次未成功的成绩
})();
