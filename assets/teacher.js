/* ============================================================
   教师端成绩汇总看板
   数据来源：云数据库 exam_records（考生交卷时自动上传）
   读取/删除均通过带口令校验的服务端函数完成，口令不出现在前端代码里。
   ============================================================ */
(function () {
  'use strict';

  var CC = window.CLOUD_CONFIG || null;
  var LS_KEY = 'quiz.teacherkey';
  var LS_WHO = 'quiz.teacherwho';
  var LOGIN_RPC = (CC && CC.teacherLoginRpc) || 'teacher_login';
  var FULL_SCORE = 100, PASS_SCORE = 60, TOTAL_Q = 50, PER_SCORE = 2;
  var AUTO_MS = 15000;                 // 看板自动刷新间隔（有违规报警，刷新更勤）

  /* 违规类型：与 app.js 的 VIOLATIONS 保持一致 */
  var VIO_LABEL = {
    leave:      '退出考试界面',
    screenshot: '截屏',
    split:      '分屏 / 调整窗口',
    copy:       '复制粘贴',
    sound:      '环境声音',
  };

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

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  var modalResolve = null;
  /* requirePhrase：给了就必须一字不差地输入该文字，「确定」才会解锁 —— 用于清空全部这种不可逆操作 */
  function confirmBox(title, text, okText, cancelText, requirePhrase) {
    $('modal-title').textContent = title;
    $('modal-text').innerHTML = text;
    $('modal-ok').textContent = okText || '确定';
    $('modal-cancel').textContent = cancelText || '取消';
    var inp = $('modal-input');
    if (requirePhrase) {
      inp.hidden = false;
      inp.value = '';
      inp.placeholder = '请输入「' + requirePhrase + '」以确认';
      $('modal-ok').disabled = true;
      inp.oninput = function () { $('modal-ok').disabled = this.value.trim() !== requirePhrase; };
      setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
    } else {
      inp.hidden = true;
      inp.value = '';
      inp.oninput = null;
      $('modal-ok').disabled = false;
    }
    $('modal-mask').classList.add('open');
    return new Promise(function (res) { modalResolve = res; });
  }
  function closeModal(v) {
    $('modal-mask').classList.remove('open');
    $('modal-ok').disabled = false;
    var inp = $('modal-input');
    if (inp) { inp.hidden = true; inp.value = ''; inp.oninput = null; }
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
    who: '',                         // 当前登录身份（如「教师一」）
    rows: [],
    viewAll: [],                     // 筛选后（未去重）
    view: [],                        // 筛选 + 去重，用于明细与导出
    filterCls: '',
    filterText: '',
    onlyVio: false,                  // 仅看违规
    selected: new Set(),             // 已勾选的记录 id（批量删除用）
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

  /* ---------- 口令校验（支持多位教师各自的教师口令） ---------- */
  /* 校验成功返回身份标识（如「教师一」），失败返回 null */
  function checkKey(key) {
    var cloud = getCloud();
    if (!cloud) return Promise.reject(new Error('cloud-sdk-unavailable'));
    return Promise.resolve(cloud.database.rpc(LOGIN_RPC, { p_key: key }))
      .then(function (res) {
        if (res && res.error) throw res.error;
        var who = res && res.data;
        return (typeof who === 'string' && who) ? who : null;
      });
  }

  function renderWho() {
    var el = $('pill-who');
    if (!el) return;
    if (S.who) { el.hidden = false; el.textContent = '当前身份：' + S.who; }
    else { el.hidden = true; el.textContent = ''; }
  }

  function backToGate(msg) {
    lsDel(LS_KEY); lsDel(LS_WHO);
    S.key = ''; S.who = ''; S.rows = []; S.view = []; S.viewAll = [];
    stopAuto();
    show('gate');
    renderWho();
    var el = $('gate-msg');
    if (msg) { el.hidden = false; el.classList.remove('ok'); el.textContent = msg; }
    else { el.hidden = true; }
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

    checkKey(key).then(function (who) {
      btn.disabled = false;
      if (!who) {
        msg.classList.remove('ok');
        msg.textContent = '口令不正确，请向管理员确认后重试。';
        $('in-key').select();
        return;
      }
      S.key = key;
      S.who = who;
      lsSet(LS_KEY, key);
      lsSet(LS_WHO, who);
      msg.hidden = true;
      $('in-key').value = '';
      renderWho();
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

    // 每次都先确认口令仍然有效：口令可能已被轮换，而失效口令读取只会返回空表，
    // 与「暂无成绩」同形，必须靠这一步区分。
    Promise.resolve(cloud.database.rpc(LOGIN_RPC, { p_key: S.key }))
      .then(function (whoRes) {
        if (whoRes && whoRes.error) throw whoRes.error;
        var who = whoRes && whoRes.data;
        if (typeof who !== 'string' || !who) {
          var e = new Error('teacher key invalid');
          e.code = '42501';
          throw e;
        }
        if (who !== S.who) { S.who = who; lsSet(LS_WHO, who); renderWho(); }
        return cloud.database.rpc(CC.teacherListRpc, { p_key: S.key });
      })
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
          backToGate('口令已失效（可能已被轮换），请重新输入。');
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
      violation: r.violation || '',
      vioDetail: r.violation_detail || '',
      violatedAt: r.violated_at ? fmtLocal(r.violated_at) : '',
      timedOut: !!r.timed_out,
      soundMonitored: !!r.sound_monitored,
      hasFace: !!r.has_face,          // 是否有考前人脸照片（照片本体走按需接口，不进列表）
      faceLive: !!r.face_live,        // 活体检测是否通过
    };
  }

  function vioText(r) {
    return VIO_LABEL[r.violation] || r.violation || '违规';
  }

  /* ---------- 视图计算 ---------- */
  function applyView() {
    var all = S.rows.slice();

    if (S.filterCls) all = all.filter(function (r) { return r.cls === S.filterCls; });

    if (S.onlyVio) all = all.filter(function (r) { return !!r.violation; });

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

    var vioN = S.viewAll.filter(function (r) { return !!r.violation; }).length;

    // 统计卡
    var cards = [
      { k: '参考人数', v: uniqN, s: '人（去重学号）', cls: 'brand' },
      { k: '答卷份数', v: S.viewAll.length, s: '份' + (dupN > 0 ? '，含重考 ' + dupN + ' 份' : '') },
      { k: '平均分', v: n1(st.avg), s: '当前筛选范围内', cls: 'brand' },
      { k: '最高分', v: st.max === null ? '—' : fmtNum(st.max), s: '分', cls: 'ok' },
      { k: '最低分', v: st.min === null ? '—' : fmtNum(st.min), s: '分', cls: st.min !== null && st.min < PASS_SCORE ? 'bad' : '' },
      { k: '及格率', v: st.n ? st.passRate.toFixed(1) + '%' : '—', s: st.n ? st.pass + ' / ' + st.n + ' 人及格' : '暂无数据', cls: st.n && st.passRate >= 60 ? 'ok' : 'bad' },
      { k: '违规记录', v: vioN, s: vioN ? '条，需人工复核' : '暂无违规', cls: vioN ? 'bad' : '' },
      { k: '平均用时', v: st.avgUsed == null ? '—' : fmtSec(st.avgUsed), s: 'mm:ss' },
    ];
    $('stat-grid').innerHTML = cards.map(function (c) {
      return '<div class="card ' + (c.cls || '') + '"><div class="k">' + esc(c.k) + '</div>' +
        '<div class="v">' + esc(c.v) + ' <em>' + esc(c.s) + '</em></div></div>';
    }).join('');

    // 已经被删掉的记录留在选择集里没有意义，顺手清掉
    var alive = {};
    S.rows.forEach(function (r) { alive[r.id] = 1; });
    S.selected.forEach(function (id) { if (!alive[id]) S.selected.delete(id); });

    renderClassFilter();
    renderAlarm();
    renderTable(list, st);
    Array.prototype.forEach.call($('board-table').querySelectorAll('[data-face]'), function (b) {
      b.addEventListener('click', function () {
        var row = S.rows.filter(function (r) { return r.id === b.dataset.face; })[0];
        showFace(b.dataset.face, row);
      });
    });
    renderSelbar();
  }

  /* ---------- 违规报警区 ---------- */
  function renderAlarm() {
    var box = $('alarm-box');
    if (!box) return;
    var vios = S.rows.filter(function (r) { return !!r.violation; })
      .sort(function (a, b) { return b.ts - a.ts; });
    if (!vios.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML =
      '<div class="alarm-head"><span class="alarm-dot"></span><b>违规报警</b>' +
      '<span class="hint">共 ' + vios.length + ' 条，按时间倒序；完整名单见下方明细表</span></div>' +
      '<div class="alarm-list">' +
      vios.slice(0, 8).map(function (r) {
        return '<div class="alarm-row">' +
          '<span class="a-kind">' + esc(vioText(r)) + '</span>' +
          '<span class="a-who">' + esc(r.name) + '　' + esc(r.cls) + '　' + esc(r.sid) + '</span>' +
          '<span class="a-time">' + esc(r.violatedAt || r.time) + '</span>' +
          (r.vioDetail ? '<span class="a-detail">' + esc(r.vioDetail) + '</span>' : '') +
          '</div>';
      }).join('') +
      (vios.length > 8 ? '<div class="alarm-more">仅列出最近 8 条</div>' : '') +
      '</div>';
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
      var trCls = r.violation ? 'vio' : (r.dup && !r.latest ? 'dup' : '');
      var status = r.violation
        ? '<span class="badge vio">违规 · ' + esc(vioText(r)) + '</span>' +
          (r.vioDetail ? '<span class="vio-detail">' + esc(r.vioDetail) + '</span>' : '')
        : (r.timedOut ? '<span class="badge dup">超时交卷</span>' : '<span class="badge pass">正常</span>');
      return '<tr class="' + trCls + '">' +
        '<td class="ck"><input type="checkbox" class="rowck" data-id="' + esc(r.id) + '"' +
        (S.selected.has(r.id) ? ' checked' : '') + '></td>' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="who">' + esc(r.name) + dupTag + '</td>' +
        '<td class="cls-cell">' + esc(r.cls) + '</td>' +
        '<td class="num">' + esc(r.sid) + '</td>' +
        '<td class="face-cell">' + (r.hasFace
          ? '<button class="face-btn" data-face="' + esc(r.id) + '">查看</button>' +
            (r.faceLive ? '' : '<span class="face-none"> 活体未过</span>')
          : '<span class="face-none">未采集</span>') + '</td>' +
        '<td class="score ' + (r.pass ? 'pass' : 'fail') + '">' + fmtNum(r.score) +
        '<span class="badge ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? '及格' : '不及格') + '</span></td>' +
        '<td class="num">' + r.right + '</td>' +
        '<td class="num">' + r.wrong + '</td>' +
        '<td class="num">' + r.blank + '</td>' +
        '<td class="num">' + (r.right / TOTAL_Q * 100).toFixed(0) + '%</td>' +
        '<td class="num">' + (r.used == null ? '—' : fmtSec(r.used)) + '</td>' +
        '<td class="num">' + esc(r.time) + '</td>' +
        '<td class="status-cell">' + status + '</td>' +
        '<td><button class="btn-mini" data-del="' + esc(r.id) + '" data-who="' +
        esc(r.name + ' ' + r.sid) + '">删除</button></td>' +
        '</tr>';
    }).join('');

    $('board-table').innerHTML = '<table><thead><tr>' +
      '<th class="ck"></th><th>#</th><th>姓名</th><th>班级</th><th>学号</th><th>人脸</th><th>得分</th>' +
      '<th>答对</th><th>答错</th><th>未答</th><th>正确率</th><th>用时</th><th>交卷时间</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    Array.prototype.forEach.call($('board-table').querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () { askDelete(b.dataset.del, b.dataset.who); });
    });
    // 逐行勾选：只更新选择集与顶部状态，不整表重绘
    Array.prototype.forEach.call($('board-table').querySelectorAll('.rowck'), function (ck) {
      ck.addEventListener('change', function () {
        if (this.checked) S.selected.add(this.dataset.id);
        else S.selected.delete(this.dataset.id);
        renderSelbar();
      });
    });
    renderSelbar();
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

  /* ---------- 批量删除 / 清空全部 ---------- */
  /* 当前筛选结果（表格里看到的那批）的 id */
  function viewIds() {
    return (S.view || []).map(function (r) { return r.id; });
  }

  function renderSelbar() {
    var el = $('sel-count');
    if (el) {
      var n = S.selected.size;
      el.innerHTML = n ? ('已选 <b>' + n + '</b> 条') : '未选择任何记录';
    }
    var b = $('btn-del-sel');
    if (b) {
      b.disabled = S.selected.size === 0 || S.loading;
      if (!/.+…$/.test(b.textContent)) b.textContent = '批量删除所选';
    }
    var none = $('btn-sel-none');
    if (none) none.disabled = S.selected.size === 0;
    var all = $('ck-all');
    if (all) {
      var ids = viewIds();
      var sel = ids.filter(function (id) { return S.selected.has(id); }).length;
      all.checked = ids.length > 0 && sel === ids.length;
      all.indeterminate = sel > 0 && sel < ids.length;
      all.disabled = ids.length === 0;
    }
    var delAll = $('btn-del-all');
    if (delAll) delAll.disabled = S.rows.length === 0 || S.loading;
  }

  /* 分批调用服务端批量删除；失败按 0.5s→1s→2s 退避重试 */
  function deleteChunk(chunk, maxTries) {
    var cloud = getCloud();
    if (!cloud) return Promise.reject(new Error('cloud-sdk-unavailable'));
    maxTries = maxTries || 3;
    var attempt = 0;
    function once() {
      attempt++;
      return Promise.resolve(cloud.database.rpc(CC.teacherDeleteManyRpc, { p_key: S.key, p_ids: chunk }))
        .then(function (res) {
          if (res && res.error) throw res.error;
          var n = Array.isArray(res.data) ? res.data[0] : res.data;
          return Number(n) || 0;
        })
        .catch(function (err) {
          if (attempt >= maxTries || isDenied(err)) throw err;
          return sleep(500 * attempt).then(once);
        });
    }
    return once();
  }

  var CHUNK = 200;

  function runBatchDelete(ids, label) {
    var btn = $('btn-del-sel');
    var total = ids.length;
    var chunks = [];
    for (var i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    var done = 0, failed = 0;

    S.loading = true;
    var chain = Promise.resolve();
    chunks.forEach(function (ch) {
      chain = chain.then(function () {
        if (btn) btn.textContent = '删除中 ' + done + '/' + total + ' …';
        return deleteChunk(ch).then(function (k) { done += k; })
          .catch(function () { failed += ch.length; });
      });
    });
    chain.then(function () {
      S.loading = false;
      ids.forEach(function (id) { S.selected.delete(id); });
      if (failed) toast('已删除 ' + done + ' 条，' + failed + ' 条失败，请稍后重试');
      else toast(label + '完成：共删除 ' + done + ' 条');
      load(true);
    });
  }

  function deleteSelected() {
    var ids = [...S.selected];
    if (!ids.length) { toast('请先勾选要删除的记录'); return; }
    var n = ids.length;
    var extra = n >= 100 ? '<br><b>数量较多（' + n + ' 条），建议先确认这确实是你要删除的范围。</b>' : '';
    confirmBox('批量删除',
      '将删除 <b>' + n + '</b> 条成绩记录，<b>删除后无法恢复</b>。' + extra + '<br>确定继续吗？',
      '删除 ' + n + ' 条', '取消').then(function (ok) {
      if (ok) runBatchDelete(ids, '批量删除');
    });
  }

  function clearAll() {
    var n = S.rows.length;
    if (!n) { toast('当前没有成绩可清空'); return; }
    var vio = S.rows.filter(function (r) { return !!r.violation; }).length;
    confirmBox('清空全部成绩',
      '将删除表内<b>全部 ' + n + ' 条</b>成绩记录（含违规记录 ' + vio + ' 条）。' +
      '<br><b>此操作不可恢复</b>，请先确认已导出需要的成绩册。<br>' +
      '<span class="hint">为防止误操作，请在下方输入「清空全部」后再点确认。</span>',
      '确认清空', '取消', '清空全部').then(function (ok) {
      if (!ok) return;
      var cloud = getCloud();
      if (!cloud) { toast('云服务组件未加载'); return; }
      var btn = $('btn-del-all');
      if (btn) btn.textContent = '清空中…';
      S.loading = true;
      Promise.resolve(cloud.database.rpc(CC.teacherClearRpc, { p_key: S.key }))
        .then(function (res) {
          if (res && res.error) throw res.error;
          var k = Array.isArray(res.data) ? res.data[0] : res.data;
          S.selected.clear();
          toast('已清空全部成绩：共删除 ' + (Number(k) || 0) + ' 条');
        })
        .catch(function (err) {
          toast(isDenied(err) ? '口令已失效，请重新登录' : ('清空失败：' + ((err && err.message) || '网络异常')));
        })
        .then(function () {
          S.loading = false;
          if (btn) btn.textContent = '清空全部成绩';
          load(true);
        });
    });
  }

  /* ---------- 查看考前人脸照片（按需拉取，不拖慢列表） ---------- */
  function showFace(id, row) {
    var cloud = getCloud();
    if (!cloud) { toast('云服务组件未加载'); return; }
    var box = $('face-modal');
    var img = $('face-photo');
    var meta = $('face-meta');
    if (!box || !img) return;
    img.removeAttribute('src');
    meta.innerHTML = '<b>' + esc((row && row.name) || '') + '</b>　' +
      esc((row && row.cls) || '') + '　' + esc((row && row.sid) || '') +
      '　交卷 ' + esc(fmtLocal((row && row.created_at) || '')) +
      '<br><span class="hint">活体检测：' + (row && row.face_live ? '通过' : '未通过') + '</span>';
    box.hidden = false;
    Promise.resolve(cloud.database.rpc(CC.teacherPhotoRpc, { p_key: S.key, p_id: id }))
      .then(function (res) {
        if (res && res.error) throw res.error;
        var url = Array.isArray(res.data) ? res.data[0] : res.data;
        if (!url) { meta.innerHTML += '<br><b>未找到照片</b>'; return; }
        img.src = url;
      })
      .catch(function (err) {
        meta.innerHTML += '<br><b>读取失败：' + esc((err && err.message) || '网络异常') + '</b>';
      });
  }

  /* ---------- 导出 CSV ---------- */
  function exportCsv() {
    var list = S.view;
    if (!list.length) { toast('当前没有可导出的记录'); return; }
    var head = ['序号', '姓名', '班级', '学号', '得分', '是否及格', '答对', '答错', '未作答', '正确率', '用时', '交卷时间', '状态', '违规详情'];
    var rows = list.map(function (r, i) {
      return [i + 1, r.name, r.cls, r.sid, fmtNum(r.score), r.pass ? '及格' : '不及格',
        r.right, r.wrong, r.blank, (r.right / TOTAL_Q * 100).toFixed(0) + '%',
        r.used == null ? '' : fmtSec(r.used), r.time,
        r.violation ? ('违规：' + vioText(r)) : (r.timedOut ? '超时交卷' : '正常'),
        r.violation ? (r.vioDetail || '') : ''];
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
    backToGate(null);
    $('in-key').focus();
  });

  /* 退出教师端：清掉本机记住的口令与身份，回到学生端答题页。
     与「锁定」的区别 —— 锁定只是退出登录、仍留在教师端；退出则直接离开教师端。 */
  function leaveToStudent() {
    try { window.location.href = 'index.html'; } catch (e) { /* 测试环境不支持跳转 */ }
  }

  if ($('btn-exit')) {
    $('btn-exit').addEventListener('click', function () {
      confirmBox('退出教师端',
        '将<b>退出登录</b>并返回学生端答题页。<br>本机记住的教师口令与登录身份会被清除，下次进入需要重新输口令。',
        '退出教师端', '取消').then(function (ok) {
        if (!ok) return;
        backToGate(null);
        leaveToStudent();
      });
    });
  }

  if ($('ck-all')) {
    $('ck-all').addEventListener('change', function () {
      var ids = viewIds();
      if (this.checked) ids.forEach(function (id) { S.selected.add(id); });
      else ids.forEach(function (id) { S.selected.delete(id); });
      render();                       // 整表重绘以同步每行复选框
    });
  }
  if ($('btn-sel-none')) {
    $('btn-sel-none').addEventListener('click', function () { S.selected.clear(); render(); });
  }
  if ($('btn-del-sel')) $('btn-del-sel').addEventListener('click', deleteSelected);
  if ($('btn-del-all')) $('btn-del-all').addEventListener('click', clearAll);

  if ($('face-close')) {
    $('face-close').addEventListener('click', function () { $('face-modal').hidden = true; });
  }
  if ($('face-modal')) {
    $('face-modal').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });
  }

  $('f-class').addEventListener('change', function () { S.filterCls = this.value; render(); });
  $('f-sort').addEventListener('change', function () { S.sort = this.value; render(); });
  $('f-dedupe').addEventListener('change', function () { S.dedupe = this.checked; render(); });
  if ($('f-violation')) {
    $('f-violation').addEventListener('change', function () { S.onlyVio = this.checked; render(); });
  }

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
      S.who = lsGet(LS_WHO, '') || '';
      renderWho();
      show('board');
      startAuto();
      load();
    } else {
      show('gate');
      $('in-key').focus();
    }
  })();
})();
