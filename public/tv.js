/* 短视频库 TV 版 —— 遥控器操作。
 * 注意:这份脚本要在 Android 8.0 的老 WebView(Chrome 58~66)上运行,
 * 所以只用 ES5 + Promise/fetch 级别的语法(不用 ?. ?? 可选 catch 绑定 / async 等)。 */
(function () {
  'use strict';

  /* ---------- 小工具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var IN_APP = /ShortvidApp/.test(navigator.userAgent);
  function fmtDur(s) {
    s = Math.round(s || 0);
    if (s < 60) return s + '秒';
    var m = Math.round(s / 60);
    return m < 60 ? m + '分钟' : Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '');
  }
  function fmtT(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  var toastT = 0;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function api(url, body) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(body === undefined ? 'GET' : 'POST', url, true);
      if (body !== undefined) x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 25000;
      x.onload = function () {
        var j = {};
        try { j = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        if (x.status === 401) { showLogin(); var e1 = new Error('未登录'); e1.status = 401; reject(e1); return; }
        if (x.status < 200 || x.status >= 300) { var e2 = new Error(j.error || j.message || '请求失败'); e2.status = x.status; e2.data = j; reject(e2); return; }
        resolve(j);
      };
      x.onerror = function () { reject(new Error('连不上服务器')); };
      x.ontimeout = function () { reject(new Error('服务器响应超时')); };
      x.send(body === undefined ? null : JSON.stringify(body));
    });
  }

  /* ---------- 状态 ---------- */
  var S = {
    me: null, screen: '', tab: 'cols', seq: 0, cols: null, detail: null, from: 'home',
    cat: store.get('tvCat', ''), sort: store.get('tvSort', 'recent'),
    homeKey: '', detailKey: '', mask: '', pairId: 0, lastBack: 0
  };
  var SORTS = [['recent', '最近观看'], ['name', '名称'], ['count', '集数'], ['added', '最新添加'], ['todo', '没看完']];
  var TABS = [['cols', '合集'], ['rand', '随便刷'], ['fav', '收藏'], ['hist', '历史'], ['set', '设置']];
  var SCOPES = { login: '#scrLogin', home: '#scrHome', detail: '#scrDetail' };
  var V = $('#tv');
  var locked = false, resting = false;

  function show(name) {
    ['login', 'home', 'detail', 'player'].forEach(function (n) {
      $('#scr' + n.charAt(0).toUpperCase() + n.slice(1)).classList.toggle('hidden', n !== name);
    });
    S.screen = name;
  }

  /* ---------- 焦点(方向键找最近的可选项) ---------- */
  function ensureVisible(n) {
    var p = n.parentNode;
    while (p && p !== document.body) {
      if (p.classList && p.classList.contains('sc')) {
        var r = n.getBoundingClientRect(), pr = p.getBoundingClientRect(), m = Math.min(40, pr.height * 0.08);
        if (r.top < pr.top + m) p.scrollTop -= (pr.top + m - r.top);
        else if (r.bottom > pr.bottom - m) p.scrollTop += (r.bottom - (pr.bottom - m));
        if (r.left < pr.left + 20) p.scrollLeft -= (pr.left + 20 - r.left);
        else if (r.right > pr.right - 20) p.scrollLeft += (r.right - (pr.right - 20));
      }
      p = p.parentNode;
    }
  }
  function focusEl(n) {
    if (!n) return;
    try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); }
    ensureVisible(n);
  }
  function visibleF(scope) {
    return $$('.f', scope).filter(function (n) { return n.offsetWidth > 0 && n.offsetHeight > 0; });
  }
  function moveFocus(dir) {
    var scope = $(SCOPES[S.screen]); if (!scope) return;
    var list = visibleF(scope); if (!list.length) return;
    var cur = document.activeElement;
    if (!cur || list.indexOf(cur) < 0) { focusEl(list[0]); return; }
    var r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, best = null, bs = 1e12;
    list.forEach(function (n) {
      if (n === cur) return;
      var b = n.getBoundingClientRect(), dx = b.left + b.width / 2 - cx, dy = b.top + b.height / 2 - cy, pri, sec, w;
      var sameRow = b.top < r.bottom - 2 && b.bottom > r.top + 2;
      if (dir === 'left') { if (dx > -2 || !sameRow) return; pri = -dx; sec = Math.abs(dy); w = 3; }
      else if (dir === 'right') { if (dx < 2 || !sameRow) return; pri = dx; sec = Math.abs(dy); w = 3; }
      else if (dir === 'up') { if (dy > -2) return; pri = -dy; sec = Math.abs(dx); w = 2.2; }
      else { if (dy < 2) return; pri = dy; sec = Math.abs(dx); w = 2.2; }
      var sc = pri + sec * w;
      if (sc < bs) { bs = sc; best = n; }
    });
    if (best) focusEl(best);
  }
  function focusKey(key) {
    if (!key) return false;
    var n = $('[data-k="' + key.replace(/"/g, '') + '"]');
    if (n && n.offsetWidth > 0) { focusEl(n); return true; }
    return false;
  }
  function focusFirst(scopeSel) {
    var list = visibleF($(scopeSel || SCOPES[S.screen]));
    if (list.length) focusEl(list[0]);
  }

  /* ---------- 懒加载图片 ---------- */
  var io = window.IntersectionObserver ? new IntersectionObserver(function (es) {
    es.forEach(function (en) {
      if (en.isIntersecting || en.intersectionRatio > 0) { io.unobserve(en.target); en.target.src = en.target.getAttribute('data-src'); }
    });
  }, { rootMargin: '500px' }) : null;
  function lazyImg(src) {
    var i = document.createElement('img');
    i.setAttribute('data-src', src);
    i.onerror = function () { i.style.display = 'none'; };
    if (io) io.observe(i); else i.src = src;
    return i;
  }
  function card(o) {
    var c = el('div', 'f card'); c.tabIndex = -1; c.setAttribute('data-k', o.key);
    var im = el('div', 'im');
    if (o.img) im.appendChild(lazyImg(o.img));
    if (o.badge) im.appendChild(el('div', 'badge', o.badge));
    var tx = el('div', 'tx'); tx.appendChild(el('div', 'nm', o.name));
    if (o.meta) tx.appendChild(el('div', 'mt', o.meta));
    if (o.pct) { var pg = el('div', 'pg'), i = el('i'); i.style.width = o.pct + '%'; pg.appendChild(i); tx.appendChild(pg); }
    c.appendChild(im); c.appendChild(tx);
    c.onclick = function () { if (S.screen === 'home') S.homeKey = o.key; else if (S.screen === 'detail') S.detailKey = o.key; o.onclick(); };
    return c;
  }

  /* =================== 登录(扫码) =================== */
  var pairT = 0;
  function drawQR(text) {
    var cv = $('#qr'), ctx = cv.getContext('2d');
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    var n = qr.getModuleCount(), pad = 3, sc = Math.floor(cv.width / (n + pad * 2)), off = Math.floor((cv.width - sc * n) / 2);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * sc, off + r * sc, sc, sc);
  }
  function startPair() {
    clearTimeout(pairT);
    var id = ++S.pairId;
    $('#loginErr').textContent = '';
    api('/api/tv/code', {}).then(function (r) {
      if (id !== S.pairId) return;
      drawQR(r.base + '/tv-auth.html?code=' + r.code);
      $('#pairCode').textContent = '配对码 ' + r.code;
      $('#pairUrl').textContent = r.base;
      pollPair(r, id);
    }, function (e) {
      if (id !== S.pairId) return;
      $('#loginErr').textContent = (e.message || '获取二维码失败') + ',5 秒后重试';
      pairT = setTimeout(startPair, 5000);
    });
  }
  function pollPair(r, id) {
    api('/api/tv/poll?code=' + r.code + '&poll=' + r.poll).then(function (j) {
      if (id !== S.pairId || S.screen !== 'login') return;
      if (j.status === 'ok') { S.pairId++; boot(); }
      else if (j.status === 'expired') startPair();
      else pairT = setTimeout(function () { pollPair(r, id); }, 2000);
    }, function () {
      if (id !== S.pairId) return;
      pairT = setTimeout(function () { pollPair(r, id); }, 3000);
    });
  }
  function showLogin() {
    if (S.screen === 'login') return;
    S.me = null; locked = false; resting = false; hideMask();
    stopVideo();
    show('login');
    $('#manual').classList.add('hidden');
    startPair();
    setTimeout(function () { focusEl($('#btnManual')); }, 50);
  }
  $('#btnManual').onclick = function () {
    $('#manual').classList.toggle('hidden');
    if (!$('#manual').classList.contains('hidden')) focusEl($('#fu'));
  };
  $('#btnRefresh').onclick = function () { startPair(); toast('已刷新二维码'); };
  $('#manual').onsubmit = function (e) { e.preventDefault(); return false; };
  $('#btnLogin').onclick = function () {
    $('#loginErr').textContent = '';
    api('/api/login', { username: $('#fu').value.replace(/^\s+|\s+$/g, ''), password: $('#fp').value }).then(function () {
      $('#fp').value = ''; S.pairId++; boot();
    }, function (e) { if (e.status !== 401) $('#loginErr').textContent = e.message; });
  };

  /* =================== 启动 / 首页 =================== */
  function boot() {
    api('/api/me').then(function (r) {
      S.me = r; locked = false; resting = false;
      $('#who').textContent = r.user.nickname || r.user.username;
      showHome(true);
      if (r.lock.locked) doLock(r.lock.message);
    }, function (e) {
      if (e.status === 401) return;
      toast((e.message || '连接失败') + ',3 秒后重试');
      setTimeout(boot, 3000);
    });
  }
  function buildTabs() {
    var box = $('#tabs'); box.innerHTML = '';
    var timer = 0;
    TABS.forEach(function (t) {
      var b = el('div', 'f tab' + (t[0] === S.tab ? ' on' : ''), t[1]);
      b.tabIndex = -1; b.setAttribute('data-k', 'tab:' + t[0]);
      b.onclick = function () { if (t[0] === 'rand') playRandom(); else openTab(t[0], true); };
      // 光标移到标签上就自动切换(「随便刷」要按确定才开始)
      b.onfocus = function () {
        clearTimeout(timer);
        if (t[0] !== 'rand' && t[0] !== S.tab) timer = setTimeout(function () { openTab(t[0], false); }, 250);
      };
      box.appendChild(b);
    });
  }
  function showHome(restore) {
    show('home'); buildTabs();
    var key = restore ? S.homeKey : '';
    openTab(S.tab, false, key);
  }
  function openTab(t, focusContent, wantKey) {
    S.tab = t; S.seq++;
    $$('#tabs .tab').forEach(function (n) { n.classList.toggle('on', n.getAttribute('data-k') === 'tab:' + t); });
    $('#chipBar').innerHTML = ''; $('#homeBody').innerHTML = ''; $('#gridWrap').scrollTop = 0;
    var after = function () {
      if (wantKey && focusKey(wantKey)) return;
      if (focusContent) { var g = visibleF($('#gridWrap')); if (g.length) focusEl(g[0]); }
      else if (wantKey !== undefined) { if (!focusKey('tab:' + t)) focusFirst('#scrHome'); }
    };
    if (t === 'cols') loadCols(after);
    else if (t === 'fav') loadVideos('fav', '还没有收藏\n看视频时长按「确定」键就能收藏', after);
    else if (t === 'hist') loadVideos('history', '还没有观看记录', after);
    else renderSet(after);
  }
  function msg(text) { $('#homeBody').innerHTML = ''; $('#homeBody').appendChild(el('div', 'empty', text)); }

  /* ---- 合集 ---- */
  function zh(a, b) { return String(a).localeCompare(String(b), 'zh-Hans-CN'); }
  function sortCols(list, how) {
    var a = list.slice();
    var byName = function (x, y) { return zh(x.name, y.name); };
    var todo = function (c) { return c.last && c.done < c.count ? 1 : 0; };
    if (how === 'name') a.sort(byName);
    else if (how === 'count') a.sort(function (x, y) { return y.count - x.count || byName(x, y); });
    else if (how === 'added') a.sort(function (x, y) { return y.added - x.added; });
    else if (how === 'todo') a.sort(function (x, y) { return todo(y) - todo(x) || y.last - x.last || byName(x, y); });
    else a.sort(function (x, y) { return y.last - x.last || byName(x, y); });
    return a;
  }
  function loadCols(after) {
    var seq = S.seq;
    msg('加载中…');
    api('/api/collections').then(function (list) {
      if (seq !== S.seq) return;
      S.cols = list; drawCols(); if (after) after();
    }, function (e) { if (seq === S.seq) msg(e.message || '加载失败'); });
  }
  function drawCols() {
    var list = S.cols || [], body = $('#homeBody'), bar = $('#chipBar');
    var cats = [];
    list.forEach(function (c) { if (cats.indexOf(c.cat) < 0) cats.push(c.cat); });
    cats.sort(zh);
    if (S.cat && cats.indexOf(S.cat) < 0) S.cat = '';
    bar.innerHTML = '';
    var mk = function (key, text, on, fn, extra) {
      var b = el('div', 'f chip' + (on ? ' on' : '') + (extra ? ' ' + extra : ''), text);
      b.tabIndex = -1; b.setAttribute('data-k', key); b.onclick = fn; bar.appendChild(b);
    };
    if (cats.length > 1) {
      mk('cat:', '全部 ' + list.length, !S.cat, function () { S.cat = ''; store.set('tvCat', ''); drawCols(); focusKey('cat:'); });
      cats.forEach(function (c) {
        var n = list.filter(function (x) { return x.cat === c; }).length;
        mk('cat:' + c, c + ' ' + n, S.cat === c, function () { S.cat = c; store.set('tvCat', c); drawCols(); focusKey('cat:' + c); });
      });
    }
    var label = '';
    SORTS.forEach(function (s) { if (s[0] === S.sort) label = s[1]; });
    mk('sort', '排序:' + label + ' ▸', false, function () {
      var i = 0; SORTS.forEach(function (s, k) { if (s[0] === S.sort) i = k; });
      S.sort = SORTS[(i + 1) % SORTS.length][0]; store.set('tvSort', S.sort); drawCols(); focusKey('sort');
    }, 'sort');
    var rows = sortCols(list.filter(function (c) { return !S.cat || c.cat === S.cat; }), S.sort);
    body.innerHTML = '';
    if (!rows.length) { body.appendChild(el('div', 'empty', list.length ? '这个分类下没有合集' : '还没有可看的合集\n请家长在管理后台添加视频库')); return; }
    var g = el('div', 'grid');
    rows.forEach(function (c) {
      g.appendChild(card({
        key: 'c:' + c.lib + ':' + c.col, img: '/api/thumb/' + c.cover, name: c.name,
        meta: c.count + ' 集 · ' + fmtDur(c.duration), badge: c.done ? c.done + '/' + c.count : '',
        pct: c.count ? c.done / c.count * 100 : 0, onclick: function () { openDetail(c); }
      }));
    });
    body.appendChild(g);
  }

  /* ---- 收藏 / 历史 ---- */
  function loadVideos(mode, emptyText, after) {
    var seq = S.seq;
    msg('加载中…');
    api('/api/feed?mode=' + mode).then(function (r) {
      if (seq !== S.seq) return;
      if (!r.items.length) { msg(emptyText); if (after) after(); return; }
      var g = el('div', 'grid');
      r.items.forEach(function (it, i) {
        g.appendChild(card({
          key: 'v:' + mode + ':' + it.id, img: '/api/thumb/' + it.id, name: it.title, meta: it.cname,
          onclick: function () { S.from = 'home'; startPlay(r.items, i, mode, mode === 'fav' ? '收藏' : '观看历史', false); }
        }));
      });
      $('#homeBody').innerHTML = ''; $('#homeBody').appendChild(g);
      if (after) after();
    }, function (e) { if (seq === S.seq) msg(e.message || '加载失败'); });
  }
  function playRandom() {
    toast('正在准备…');
    api('/api/feed?mode=random').then(function (r) {
      if (!r.items.length) { toast('还没有视频'); return; }
      S.from = 'home'; S.homeKey = 'tab:rand';
      startPlay(r.items, 0, 'random', '随便刷', false);
    }, function (e) { toast(e.status === 403 ? '家长没有开放「随便刷」,请到「合集」里选' : e.message); });
  }

  /* ---- 设置 ---- */
  function renderSet(after) {
    var seq = S.seq, body = $('#homeBody');
    body.innerHTML = '';
    api('/api/me').then(function (r) {
      if (seq !== S.seq) return;
      S.me = r;
      var u = r.user, box = el('div', 'setbox');
      box.appendChild(el('p', '', '当前账号:' + (u.nickname || u.username) + '(' + u.username + ')'));
      if (u.daily_limit_min > 0 && u.role !== 'admin') {
        var lim = u.daily_limit_min * 60, left = Math.max(0, lim - r.used);
        box.appendChild(el('p', '', '今天已看 ' + Math.floor(r.used / 60) + ' 分钟,还可以看 ' + Math.ceil(left / 60) + ' 分钟'));
      }
      var b = function (key, text, fn, cls) {
        var x = el('div', 'f btn' + (cls ? ' ' + cls : ''), text); x.tabIndex = -1; x.setAttribute('data-k', key); x.onclick = fn; box.appendChild(x);
      };
      b('set:reload', '刷新', function () { location.reload(); }, 'g');
      if (IN_APP) b('set:server', '更换服务器地址', function () { location.href = 'http://localhost/?change=1'; }, 'g');
      b('set:logout', '退出登录', function () {
        api('/api/logout', {}).then(function () { showLogin(); }, function () { showLogin(); });
      });
      box.appendChild(el('p', '', 'TV 版 v1.1.0 · 方向键选择,确定键进入,返回键后退'));
      body.appendChild(box);
      if (after) after();
    }, function (e) { if (seq === S.seq) msg(e.message || '加载失败'); });
  }

  /* =================== 合集详情 =================== */
  function openDetail(c, wantKey) {
    S.detail = c; show('detail');
    $('#dTitle').textContent = c.name;
    $('#dSub').textContent = '共 ' + c.count + ' 集 · ' + fmtDur(c.duration) + (c.cat ? ' · ' + c.cat : '');
    var body = $('#dBody'); body.innerHTML = ''; $('#dWrap').scrollTop = 0;
    body.appendChild(el('div', 'empty', '加载中…'));
    api('/api/feed?mode=collection&lib=' + c.lib + '&col=' + encodeURIComponent(c.col)).then(function (r) {
      if (S.screen !== 'detail' || S.detail !== c) return;
      body.innerHTML = '';
      if (!r.items.length) { body.appendChild(el('div', 'empty', '这里还没有内容')); return; }
      var started = r.items.some(function (x) { return x.pos > 0 || x.finished; });
      var cont = r.items[r.start];
      var b = el('div', 'f bigbtn', started ? '▶ 继续播放(第 ' + cont.seq + ' 集)' : '▶ 从头播放');
      b.tabIndex = -1; b.setAttribute('data-k', 'cont');
      b.onclick = function () { S.detailKey = 'cont'; S.from = 'detail'; startPlay(r.items, r.start, 'collection', c.name, true); };
      body.appendChild(b);
      var g = el('div', 'grid');
      r.items.forEach(function (it, i) {
        g.appendChild(card({
          key: 'e:' + it.id, img: '/api/thumb/' + it.id, name: '第' + it.seq + '集 ' + it.title,
          meta: fmtDur(it.duration) + (it.finished ? ' · 已看完' : it.pos > 1 ? ' · 看到 ' + fmtDur(it.pos) : ''),
          pct: it.duration && it.pos && !it.finished ? it.pos / it.duration * 100 : it.finished ? 100 : 0,
          onclick: function () { S.from = 'detail'; startPlay(r.items, i, 'collection', c.name, it.pos > 1 && !it.finished); }
        }));
      });
      body.appendChild(g);
      if (!(wantKey && focusKey(wantKey))) focusEl(b);
    }, function (e) { if (S.screen === 'detail') { body.innerHTML = ''; body.appendChild(el('div', 'empty', e.message || '加载失败')); } });
  }

  /* =================== 播放 =================== */
  var P = { items: [], i: -1, mode: '', title: '', resume: false, resumeId: 0, lastSave: 0, ovT: 0, target: null, seekT: 0, lastSeekKey: 0, okLong: false, errT: 0 };
  function cur() { return P.items[P.i]; }
  function startPlay(items, i, mode, title, resume) {
    P.items = items; P.mode = mode; P.title = title; P.resume = !!resume;
    show('player'); hideMsg();
    loadItem(i);
  }
  function loadItem(i) {
    saveProgress();
    clearTimeout(P.errT); hideMsg();
    P.i = i; P.target = null;
    var it = cur();
    P.resumeId = P.resume && it.pos > 1 && !it.finished ? it.id : 0;
    P.resume = false;
    V.poster = '/api/thumb/' + it.id;
    P.fb = false;
    V.src = '/api/stream/' + it.id + '?tv=1';
    armStall(8000);
    $('#ovT').textContent = it.title;
    updateInfo();
    $('#ovFill').style.width = '0'; $('#ovTime').textContent = '0:00'; $('#ovDur').textContent = fmtT(it.duration);
    playNow();
    showOv();
  }
  function updateInfo() {
    var it = cur(); if (!it) return;
    var c = P.mode === 'collection' ? it.cname + ' · 第' + it.seq + '/' + P.items.length + '集' : it.cname + ' · ' + (P.i + 1) + '/' + P.items.length;
    $('#ovC').textContent = c + (it.fav ? '  ♥ 已收藏' : '');
  }
  function playNow() {
    if (locked || resting) return;
    var p;
    try { p = V.play(); } catch (e) { p = null; }
    if (p && p.catch) p.catch(function (e) {
      if (e && e.name === 'NotAllowedError') { showMsg('按「确定」键开始播放'); }
    });
  }
  function stopVideo() {
    saveProgress(); clearTimeout(P.stallT);
    try { V.pause(); V.removeAttribute('src'); V.load(); } catch (e) { /* ignore */ }
    clearTimeout(P.errT);
  }
  function togglePlay() {
    if (V.paused) { hideMsg(); playNow(); } else V.pause();
    showOv();
  }
  function showOv() {
    var ov = $('#ov'); ov.classList.add('show');
    var mid = $('#ovMid'); mid.textContent = V.paused ? '▶' : ''; mid.classList.toggle('show', V.paused);
    clearTimeout(P.ovT);
    if (!V.paused) P.ovT = setTimeout(function () { ov.classList.remove('show'); }, 3500);
  }
  function showMsg(t) { var m = $('#pMsg'); m.textContent = t; m.classList.remove('hidden'); }
  function hideMsg() { $('#pMsg').classList.add('hidden'); }
  function updateBar(t) {
    var d = V.duration || (cur() && cur().duration) || 0;
    $('#ovFill').style.width = d ? Math.min(100, t / d * 100) + '%' : '0';
    $('#ovTime').textContent = fmtT(t);
  }
  function saveProgress() {
    var it = cur();
    if (S.screen !== 'player' || !it || !V.duration || V.ended || !V.currentTime) return;
    P.lastSave = Date.now(); it.pos = V.currentTime;
    api('/api/progress', { video_id: it.id, position: V.currentTime, finished: false }).then(null, function () {});
  }
  function go(d) {
    var n = P.i + d;
    if (n < 0) { toast('已经是第一个了'); return; }
    if (n >= P.items.length) { toast(P.mode === 'collection' ? '这个合集看完啦' : '已经播完了'); setTimeout(closePlayer, 600); return; }
    loadItem(n);
  }
  function toggleFav() {
    var it = cur(); if (!it) return;
    var on = !it.fav; it.fav = on; updateInfo(); showOv();
    api('/api/fav', { video_id: it.id, on: on }).then(function () { toast(on ? '已收藏 ♥' : '已取消收藏'); }, function () { it.fav = !on; updateInfo(); });
  }
  function seekKey(dir, repeat) {
    var now = Date.now();
    if (repeat && now - P.lastSeekKey < 180) return;
    P.lastSeekKey = now;
    var d = V.duration || 0; if (!d) return;
    if (P.target === null) P.target = V.currentTime;
    P.target = Math.max(0, Math.min(d - 0.5, P.target + dir * (repeat ? 15 : 10)));
    updateBar(P.target); showOv();
    clearTimeout(P.seekT);
    P.seekT = setTimeout(function () { try { V.currentTime = P.target; } catch (e) { /* ignore */ } P.target = null; }, 400);
  }
  function dbgInfo() {
    var e = V.error;
    return '[错误码' + (e ? e.code : '无') + ' 就绪' + V.readyState + ' 网络' + V.networkState + ' ' + (V.videoWidth || 0) + 'x' + (V.videoHeight || 0) + ']';
  }
  // 先让服务器转成 H.264 再试一次(老投影对 H.265/高规格视频常常既不报错也不出画面)
  function tryFallback() {
    var it0 = cur();
    if (!it0 || P.fb) return false;
    P.fb = true;
    showMsg('正在转换视频格式,请稍等…');
    V.src = '/api/stream/' + it0.id + '?h264=1';
    playNow();
    armStall(120000);
    return true;
  }
  function armStall(ms) {
    clearTimeout(P.stallT);
    var idx = P.i;
    P.stallT = setTimeout(function () {
      if (S.screen !== 'player' || P.i !== idx || locked || resting) return;
      if (!V.paused && V.currentTime > 0.2) return;
      if (V.paused && V.readyState >= 3) { showMsg('按「确定」键开始播放'); return; }
      if (tryFallback()) return;
      showMsg('视频一直没有画面,请把下面这行发给开发者\n' + dbgInfo());
    }, ms);
  }
  function closePlayer() {
    if (S.screen !== 'player') return;
    stopVideo();
    if (S.from === 'detail' && S.detail) openDetail(S.detail, S.detailKey);
    else showHome(true);
  }

  V.addEventListener('loadedmetadata', function () {
    var it = cur();
    if (it && P.resumeId === it.id && it.pos > 1 && it.pos < V.duration - 1) { try { V.currentTime = it.pos; } catch (e) { /* ignore */ } }
    P.resumeId = 0;
    $('#ovDur').textContent = fmtT(V.duration);
  });
  V.addEventListener('timeupdate', function () {
    if (P.target === null) updateBar(V.currentTime);
    if (!V.paused && Date.now() - P.lastSave > 5000) saveProgress();
  });
  V.addEventListener('playing', function () { hideMsg(); clearTimeout(P.errT); clearTimeout(P.stallT); showOv(); });
  V.addEventListener('pause', function () { if (S.screen === 'player' && !V.ended) { showOv(); saveProgress(); } });
  V.addEventListener('ended', function () {
    var it = cur(); if (!it) return;
    if (P.mode === 'collection') {
      it.finished = true; it.pos = 0;
      api('/api/progress', { video_id: it.id, position: V.duration || 0, finished: true }).then(null, function () {});
    }
    go(1);
  });
  V.addEventListener('error', function () {
    if (S.screen !== 'player' || !V.getAttribute('src')) return;
    if (tryFallback()) return;
    api('/api/heartbeat', { seconds: 0 }).then(function (r) {
      if (r.lock.locked) { doLock(r.lock.message); return; }
      showMsg('这个视频暂时播放不了,3 秒后播放下一个\n' + dbgInfo());
      var idx = P.i;
      P.errT = setTimeout(function () { if (S.screen === 'player' && P.i === idx) go(1); }, 3000);
    }, function () { showMsg('网络不通,请检查服务器'); });
  });

  function playerKey(e) {
    var k = e.keyCode, handled = true;
    if (k === 13 || k === 23) {
      // 短按 = 暂停/播放(松手时触发);长按 = 收藏
      if (e.repeat) { if (!P.okLong) { P.okLong = true; toggleFav(); } }
    }
    else if (k === 32 || k === 179 || k === 85) togglePlay();
    else if (k === 37 || k === 89 || k === 227 || k === 177) seekKey(-1, e.repeat);
    else if (k === 39 || k === 90 || k === 228 || k === 176) seekKey(1, e.repeat);
    else if (k === 38 || k === 33 || k === 167 || k === 428) go(-1);
    else if (k === 40 || k === 34 || k === 166 || k === 427) go(1);
    else if (k === 82 || k === 93 || k === 77 || k === 70 || k === 165) toggleFav();
    else if (k === 27 || k === 8) closePlayer();
    else handled = false;
    if (handled) e.preventDefault(); else showOv();
  }
  document.addEventListener('keyup', function (e) {
    if ((e.keyCode === 13 || e.keyCode === 23) && S.screen === 'player' && !S.mask) {
      if (!P.okLong) togglePlay();
      P.okLong = false;
    }
  });

  /* =================== 时长限制 / 休息提醒 =================== */
  var acc = 0, contSec = 0, idle = 0;
  function showMask(kind, icon, text, btn, enabled) {
    S.mask = kind;
    $('#mIcon').textContent = icon; $('#mMsg').textContent = text;
    var b = $('#mBtn'); b.textContent = btn; b.classList.toggle('dis', !enabled); b.tabIndex = -1;
    $('#mask').classList.remove('hidden'); b.focus();
  }
  function hideMask() { S.mask = ''; $('#mask').classList.add('hidden'); }
  function doLock(text) {
    locked = true; try { V.pause(); } catch (e) { /* ignore */ }
    showMask('lock', '🌙', text || '现在不能看啦', '我知道了,再看看', true);
  }
  function doRest() {
    resting = true; contSec = 0; try { V.pause(); } catch (e) { /* ignore */ }
    var left = 20;
    showMask('rest', '👀', '已经连续看了 ' + S.me.user.break_every_min + ' 分钟啦,闭上眼睛休息一下、看看远处吧', '休息 ' + left + ' 秒', false);
    var t = setInterval(function () {
      left--;
      if (left > 0) { $('#mBtn').textContent = '休息 ' + left + ' 秒'; return; }
      clearInterval(t); $('#mBtn').textContent = '休息好了,继续看'; $('#mBtn').classList.remove('dis');
    }, 1000);
  }
  $('#mBtn').onclick = function () {
    if ($('#mBtn').classList.contains('dis')) return;
    if (S.mask === 'rest') { resting = false; hideMask(); contSec = 0; idle = 0; if (S.screen === 'player') playNow(); return; }
    api('/api/me').then(function (r) {
      S.me = r;
      if (!r.lock.locked) { locked = false; hideMask(); if (S.screen === 'player') playNow(); }
      else $('#mMsg').textContent = r.lock.message;
    }, function () { /* ignore */ });
  };
  function beat(s) {
    api('/api/heartbeat', { seconds: s }).then(function (r) { if (S.me) S.me.lock = r.lock; if (r.lock.locked) doLock(r.lock.message); }, function () {});
  }
  setInterval(function () {
    if (!S.me || locked || resting) return;
    var playing = S.screen === 'player' && !V.paused && !V.ended && V.readyState > 2;
    if (playing) { acc++; contSec++; idle = 0; } else { idle++; if (idle >= 180) contSec = 0; }
    if (acc >= 10) { var s = acc; acc = 0; beat(s); }
    if (S.me.user.break_every_min > 0 && S.me.user.role !== 'admin' && contSec >= S.me.user.break_every_min * 60) doRest();
  }, 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveProgress(); if (S.screen === 'player') try { V.pause(); } catch (e) { /* ignore */ } }
  });

  /* =================== 按键 / 返回 =================== */
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, t = e.target, inInput = t && t.tagName === 'INPUT';
    if (S.mask) {
      if (k === 13 || k === 23 || k === 32) $('#mBtn').click();
      if (k !== 116 && k !== 123) e.preventDefault();
      return;
    }
    if (S.screen === 'player') { playerKey(e); return; }
    if (k === 37 || k === 39) { if (inInput) return; moveFocus(k === 37 ? 'left' : 'right'); e.preventDefault(); return; }
    if (k === 38 || k === 40) { moveFocus(k === 38 ? 'up' : 'down'); e.preventDefault(); return; }
    if (k === 13 || k === 23) {
      if (inInput) {
        e.preventDefault();
        if (t.id === 'fu') focusEl($('#fp')); else if (t.id === 'fp') $('#btnLogin').click();
        return;
      }
      var a = document.activeElement;
      if (a && a.classList && a.classList.contains('f')) { e.preventDefault(); a.click(); } else focusFirst();
      return;
    }
    if (k === 27 || (k === 8 && !inInput)) { e.preventDefault(); window.__appBack(); }
  });

  // 原生壳按返回键时调用;返回 true 表示网页已处理,false 表示交给系统(退到桌面)
  window.__appBack = function () {
    if (S.mask === 'rest') return true;
    if (S.mask === 'lock') return false;
    if (S.screen === 'player') { closePlayer(); return true; }
    if (S.screen === 'detail') { showHome(true); return true; }
    if (S.screen === 'home') {
      if (S.tab !== 'cols') { S.homeKey = ''; openTab('cols', false, ''); return true; }
      if (Date.now() - S.lastBack < 2000) return false;
      S.lastBack = Date.now(); toast('再按一次返回键退出'); return true;
    }
    return false;
  };

  if (!window.qrcode) { /* 二维码库没加载出来时,至少还能用账号密码登录 */ drawQR = function () {}; }
  boot();
})();
