/* ============================================================
   教师端成绩汇总看板
   数据来源：云数据库 exam_records（考生交卷时自动上传）
   读取/删除均通过带口令校验的服务端函数完成，口令不出现在前端代码里。
   ============================================================ */
(function () {
  'use strict';

  var CC = window.CLOUD_CONFIG || null;
  var LS_KEY = 'quiz.teacherkey';
  var FULL_SCORE = 100, PASS_SCORE = 60, TOTAL_Q = 40, PER_SCORE = 2.5;
  var AUTO_MS = 30000;                 // 看板自动刷新间隔

  /* ---------- 基础工具 ---------- */
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k, dft) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dft; } catch (e) { return dft; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* 权限类错误：平台会把 PostgreSQL 错误码包装为 DATABASE_42501，两种形态都要认 */
  function isDenied(err) {
    return !!err && String(err.code || '').indexOf('42501') > -1;
  }

  function fmtNum(n) { return n % 1 === 0 ? String(n) : n.toFixed(1); }

  function fmtSec(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function fmtLocal(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

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

  function download(filename, content, mime) {
    var blob = new Blob(['\ufeff' + content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------- 云客户端 ---------- */
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

  /* ---------- 状态 ---------- */
  var S = {
    key: '',
    rows: [],
    viewAll: [],                     // 筛选后（未去重）
    view: [],                        // 筛选 + 去重，用于明细与导出
    filterCls: '',
    filterText: '',
    sort: 'time-desc',
    dedupe: true,
    lastSync: '',
    timer: null,
    loading: false,
  };

  function show(name) {
    ['screen-gate', 'screen-board'].forEach(function (id) {
      $(id).classList.toggle('active', id === 'screen-' + name);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ---------- 口令校验 ---------- */
  function checkKey(key) {
    var cloud = getCloud();
    if (!cloud) return Promise.reject(new Error('cloud-sdk-unavailable'));
    return Promise.resolve(cloud.database.rpc('teacher_key_ok', { p_key: key }))
      .then(function (res) {
        if (res && res.error) throw res.error;
        return res && res.data === true;
      });
  }

  function unlock(passedKey) {
    var key = passedKey != null ? passedKey : $('in-key').value.trim();
    var msg = $('gate-msg');
    if (!key) {
      msg.hidden = false; msg.classList.remove('ok');
      msg.textContent = '请输入教师口令。';
      return;
    }
    var btn = $('btn-unlock');
    btn.disabled = true;
    msg.hidden = false; msg.classList.remove('ok');
    msg.textContent = '正在校验口令…';

    checkKey(key).then(function (ok) {
      btn.disabled = false;
      if (!ok) {
        msg.classList.remove('ok');
        msg.textContent = '口令不正确，请向任课教师确认后重试。';
        $('in-key').select();
        return;
      }
      S.key = key;
      lsSet(LS_KEY, key);
      msg.hidden = true;
      $('in-key').value = '';
      show('board');
      startAuto();
      load();
    }).catch(function (err) {
      btn.disabled = false;
      msg.classList.remove('ok');
      msg.textContent = /cloud-sdk-unavailable/.test(err && err.message)
        ? '云服务组件未加载，请检查网络后刷新页面。'
        : '云端连接失败，请检查网络后重试。';
    });
  }

  /* ---------- 数据读取 ---------- */
  function load(silent) {
    if (S.loading) return;
    var cloud = getCloud();
    if (!cloud) { showError('云服务组件未加载，请检查网络后刷新页面。'); return; }
    S.loading = true;
    if (!silent) $('pill-sync').textContent = '正在同步…';

    Promise.resolve(cloud.database.rpc(CC.teacherListRpc, { p_key: S.key }))
      .then(function (res) {
        if (res && res.error) throw res.error;
        var rows = Array.isArray(res && res.data) ? res.data : [];
        S.rows = rows.map(normalize).sort(function (a, b) { return b.ts - a.ts; });
        S.lastSync = fmtLocal(new Date().toISOString());
        $('load-error').hidden = true;
        $('pill-sync').textContent = '最近同步 ' + S.lastSync.slice(11);
        render();
      })
      .catch(function (err) {
        if (isDenied(err)) {
          // 口令已在服务端失效或不被接受
          lsDel(LS_KEY); S.key = '';
          stopAuto();
          show('gate');
          $('gate-msg').hidden = false;
          $('gate-msg').classList.remove('ok');
          $('gate-msg').textContent = '口令已失效，请重新输入。';
          return;
        }
        showError('成绩读取失败：' + ((err && err.message) || '网络异常，请稍后重试'));
      })
      .then(function () { S.loading = false; });
  }

  function showError(text) {
    var el = $('load-error');
    el.hidden = false;
    el.innerHTML = esc(text) + ' <button class="btn-mini" id="btn-retry-load">重试</button>';
    var b = $('btn-retry-load');
    if (b) b.addEventListener('click', function () { load(); });
  }

  function normalize(r) {
    var score = parseFloat(r.score);
    if (isNaN(score)) score = 0;
    return {
      id: r.id,
      name: r.name || '',
      cls: r.cls || '',
      sid: r.sid || '',
      score: score,
      right: r.right_cnt || 0,
      wrong: r.wrong_cnt || 0,
      blank: r.blank_cnt || 0,
      used: r.used_sec == null ? null : r.used_sec,
      time: fmtLocal(r.created_at),
      ts: new Date(r.created_at).getTime() || 0,
      pass: score >= PASS_SCORE,
    };
  }

  /* ---------- 视图计算 ---------- */
  function applyView() {
    var all = S.rows.slice();

    if (S.filterCls) all = all.filter(function (r) { return r.cls === S.filterCls; });

    if (S.filterText) {
      var kw = S.filterText.toLowerCase();
      all = all.filter(function (r) {
        return r.name.toLowerCase().indexOf(kw) > -1 || r.sid.toLowerCase().indexOf(kw) > -1;
      });
    }

    // 同一学号重复交卷标记
    var bySid = {};
    all.forEach(function (r) { (bySid[r.sid] = bySid[r.sid] || []).push(r); });
    Object.keys(bySid).forEach(function (sid) {
      var arr = bySid[sid];
      arr.sort(function (a, b) { return b.ts - a.ts; });
      arr.forEach(function (r, i) { r.dup = arr.length > 1; r.latest = i === 0; });
    });

    var list = all;
    if (S.dedupe) {
      var seen = {};
      list = all.filter(function (r) {
        if (r.latest === false || seen[r.sid]) return false;
        seen[r.sid] = 1;
        return true;
      });
    }

    var cmps = {
      'time-desc': function (a, b) { return b.ts - a.ts; },
      'time-asc': function (a, b) { return a.ts - b.ts; },
      'score-desc': function (a, b) { return b.score - a.score || b.ts - a.ts; },
      'score-asc': function (a, b) { return a.score - b.score || b.ts - a.ts; },
      'class-asc': function (a, b) {
        return a.cls.localeCompare(b.cls, 'zh') || a.sid.localeCompare(b.sid, 'zh');
      },
    };
    all.sort(cmps[S.sort] || cmps['time-desc']);
    if (list !== all) list.sort(cmps[S.sort] || cmps['time-desc']);

    S.viewAll = all;
    S.view = list;
    return list;
  }

  function statsOf(list) {
    var n = list.length, sum = 0, max = null, min = null, pass = 0, usedSum = 0, usedN = 0;
    list.forEach(function (r) {
      sum += r.score;
      if (max === null || r.score > max) max = r.score;
      if (min === null || r.score < min) min = r.score;
      if (r.pass) pass++;
      if (r.used != null) { usedSum += r.used; usedN++; }
    });
    return {
      n: n,
      avg: n ? sum / n : 0,
      max: max, min: min,
      pass: pass,
      passRate: n ? pass / n * 100 : 0,
      avgUsed: usedN ? usedSum / usedN : null,
    };
  }

  /* ---------- 渲染 ---------- */
  function render() {
    function n1(x) { return x % 1 === 0 ? String(x) : x.toFixed(1); }
    var list = applyView();
    var st = statsOf(list);
    var uniq = {};
    S.viewAll.forEach(function (r) { uniq[r.sid] = 1; });
    var uniqN = Object.keys(uniq).length;
    var dupN = S.viewAll.length - uniqN;

    // 统计卡
    var cards = [
      { k: '参考人数', v: uniqN, s: '人（去重学号）', cls: 'brand' },
      { k: '答卷份数', v: S.viewAll.length, s: '份' + (dupN > 0 ? '，含重考 ' + dupN + ' 份' : '') },
      { k: '平均分', v: n1(st.avg), s: '当前筛选范围内', cls: 'brand' },
      { k: '最高分', v: st.max === null ? '—' : fmtNum(st.max), s: '分', cls: 'ok' },
      { k: '最低分', v: st.min === null ? '—' : fmtNum(st.min), s: '分', cls: st.min !== null && st.min < PASS_SCORE ? 'bad' : '' },
      { k: '及格率', v: st.n ? st.passRate.toFixed(1) + '%' : '—', s: st.n ? st.pass + ' / ' + st.n + ' 人及格' : '暂无数据', cls: st.n && st.passRate >= 60 ? 'ok' : 'bad' },
      { k: '平均用时', v: st.avgUsed == null ? '—' : fmtSec(st.avgUsed), s: 'mm:ss' },
    ];
    $('stat-grid').innerHTML = cards.map(function (c) {
      return '<div class="card ' + (c.cls || '') + '"><div class="k">' + esc(c.k) + '</div>' +
        '<div class="v">' + esc(c.v) + ' <em>' + esc(c.s) + '</em></div></div>';
    }).join('');

    renderClassFilter();
    renderTable(list, st);
  }

  function renderClassFilter() {
    var sel = $('f-class');
    var classes = [];
    S.rows.forEach(function (r) { if (classes.indexOf(r.cls) < 0) classes.push(r.cls); });
    classes.sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    var cur = S.filterCls;
    sel.innerHTML = '<option value="">全部班级（' + classes.length + ' 个）</option>' +
      classes.map(function (c) {
        var cnt = S.rows.filter(function (r) { return r.cls === c; }).length;
        return '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') + '>' +
          esc(c) + '（' + cnt + ' 份）</option>';
      }).join('') +
      (cur && classes.indexOf(cur) < 0
        ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>' : '');
  }

  function renderTable(list, st) {
    var hint = $('table-hint');
    if (!S.rows.length) {
      hint.textContent = '';
      $('board-table').innerHTML = '<div class="empty">还没有收到成绩。考生在答题页交卷后，成绩会自动上传到这里。</div>';
      return;
    }
    if (!list.length) {
      hint.textContent = '';
      $('board-table').innerHTML = '<div class="empty">当前筛选条件下没有匹配的记录。</div>';
      return;
    }

    hint.textContent = '共 ' + list.length + ' 条' + (S.dedupe ? '（已按学号去重）' : '') +
      '　平均 ' + (st.avg % 1 === 0 ? st.avg : st.avg.toFixed(1)) + ' 分';

    var rows = list.map(function (r, i) {
      var dupTag = r.dup ? '<span class="badge dup">重考</span>' : '';
      return '<tr class="' + (r.dup && !r.latest ? 'dup' : '') + '">' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="who">' + esc(r.name) + dupTag + '</td>' +
        '<td class="cls-cell">' + esc(r.cls) + '</td>' +
        '<td class="num">' + esc(r.sid) + '</td>' +
        '<td class="score ' + (r.pass ? 'pass' : 'fail') + '">' + fmtNum(r.score) +
        '<span class="badge ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? '及格' : '不及格') + '</span></td>' +
        '<td class="num">' + r.right + '</td>' +
        '<td class="num">' + r.wrong + '</td>' +
        '<td class="num">' + r.blank + '</td>' +
        '<td class="num">' + (r.right / TOTAL_Q * 100).toFixed(0) + '%</td>' +
        '<td class="num">' + (r.used == null ? '—' : fmtSec(r.used)) + '</td>' +
        '<td class="num">' + esc(r.time) + '</td>' +
        '<td><button class="btn-mini" data-del="' + esc(r.id) + '" data-who="' +
        esc(r.name + ' ' + r.sid) + '">删除</button></td>' +
        '</tr>';
    }).join('');

    $('board-table').innerHTML = '<table><thead><tr>' +
      '<th>#</th><th>姓名</th><th>班级</th><th>学号</th><th>得分</th>' +
      '<th>答对</th><th>答错</th><th>未答</th><th>正确率</th><th>用时</th><th>交卷时间</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    Array.prototype.forEach.call($('board-table').querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () { askDelete(b.dataset.del, b.dataset.who); });
    });
  }

  /* ---------- 删除记录 ---------- */
  function askDelete(id, who) {
    confirmBox('删除记录', '将删除 <b>' + esc(who) + '</b> 的这条成绩记录，删除后无法恢复。<br>确定吗？', '删除', '取消')
      .then(function (ok) {
        if (!ok) return;
        var cloud = getCloud();
        if (!cloud) { toast('云服务组件未加载'); return; }
        Promise.resolve(cloud.database.rpc(CC.teacherDeleteRpc, { p_key: S.key, p_id: id }))
          .then(function (res) {
            if (res && res.error) throw res.error;
            var n = Array.isArray(res && res.data) ? res.data[0] : res && res.data;
            if (n === 0 || n == null) { toast('未删除任何记录'); }
            else { toast('已删除 1 条记录'); }
            load();
          })
          .catch(function (err) {
            toast(isDenied(err) ? '口令已失效，请重新登录' : '删除失败：' + ((err && err.message) || '网络异常'));
          });
      });
  }

  /* ---------- 导出 CSV ---------- */
  function exportCsv() {
    var list = S.view;
    if (!list.length) { toast('当前没有可导出的记录'); return; }
    var head = ['序号', '姓名', '班级', '学号', '得分', '是否及格', '答对', '答错', '未作答', '正确率', '用时', '交卷时间'];
    var rows = list.map(function (r, i) {
      return [i + 1, r.name, r.cls, r.sid, fmtNum(r.score), r.pass ? '及格' : '不及格',
        r.right, r.wrong, r.blank, (r.right / TOTAL_Q * 100).toFixed(0) + '%',
        r.used == null ? '' : fmtSec(r.used), r.time];
    });
    var st = statsOf(list);
    var tail = [];
    tail.push([]);
    tail.push(['统计', '人数 ' + st.n, '平均分 ' + (st.avg % 1 === 0 ? st.avg : st.avg.toFixed(1)),
      '最高分 ' + (st.max === null ? '' : fmtNum(st.max)), '最低分 ' + (st.min === null ? '' : fmtNum(st.min)),
      '及格率 ' + st.passRate.toFixed(1) + '%']);

    var csv = [head].concat(rows).concat(tail).map(function (row) {
      return row.map(function (c) {
        c = String(c == null ? '' : c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\r\n');

    function stamp() {
      var d = new Date();
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    }
    download('考核成绩册_' + (S.filterCls || '全部班级') + '_' + stamp() + '.csv', csv, 'text/csv');
    toast('成绩册已导出（' + list.length + ' 条）');
  }

  /* ---------- 自动刷新 ---------- */
  function startAuto() {
    stopAuto();
    S.timer = setInterval(function () {
      if (document.hidden) return;
      load(true);
    }, AUTO_MS);
  }
  function stopAuto() { clearInterval(S.timer); S.timer = null; }

  /* ---------- 事件绑定 ---------- */
  $('btn-unlock').addEventListener('click', function () { unlock(); });
  $('in-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
  $('btn-refresh').addEventListener('click', function () { load(); toast('已刷新'); });
  $('btn-csv').addEventListener('click', exportCsv);
  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-lock').addEventListener('click', function () {
    lsDel(LS_KEY); S.key = ''; stopAuto(); S.rows = [];
    $('gate-msg').hidden = true;
    show('gate');
    $('in-key').focus();
  });

  $('f-class').addEventListener('change', function () { S.filterCls = this.value; render(); });
  $('f-sort').addEventListener('change', function () { S.sort = this.value; render(); });
  $('f-dedupe').addEventListener('change', function () { S.dedupe = this.checked; render(); });

  var textTimer = null;
  $('f-text').addEventListener('input', function () {
    var v = this.value.trim();
    clearTimeout(textTimer);
    textTimer = setTimeout(function () { S.filterText = v; render(); }, 200);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.key) load(true);
  });

  /* ---------- 启动 ---------- */
  (function boot() {
    if (!CC) { showError('缺少云服务配置（cloud-config.js）。'); }
    var saved = lsGet(LS_KEY, '');
    if (saved) {
      S.key = saved;
      show('board');
      startAuto();
      load();
    } else {
      show('gate');
      $('in-key').focus();
    }
  })();
})();
