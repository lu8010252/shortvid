'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};
const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const ICON_ROT = '<svg viewBox="0 0 24 24"><path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/></svg>';

let me = null;            // {user, lock, used}
let used = 0;             // 今天已看秒数(服务端口径)
let locked = false;
const Snd = { on: true }; // 是否允许有声播放(被浏览器拒绝后会降级为静音,点一下屏幕恢复)
let autoRot = store.get('autoRot', '1') === '1';

async function api(url, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(url, opt);
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  if (r.status === 401) { showLogin(); throw new Error('未登录'); }
  if (!r.ok) { const e = new Error(j.error || j.message || '请求失败'); e.data = j; e.status = r.status; throw e; }
  return j;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
const fmtDur = s => {
  s = Math.round(s || 0);
  if (s < 60) return s + '秒';
  const m = Math.round(s / 60);
  return m < 60 ? m + '分钟' : Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '');
};

/* =================== 播放器(上下滑动) =================== */
const feeds = [];
class Feed {
  constructor(root, bn) {
    this.root = root; this.items = []; this.slides = []; this.cur = -1; this.active = false; this.mode = '';
    this.rotOv = {}; this.lastSave = 0; this.resumeId = 0; this.onChange = null;
    feeds.push(this);
  }
  mount(items, start, mode, resumeFirst) {
    this.destroy();
    this.items = items; this.mode = mode; this.rotOv = {}; this.cur = -1;
    this.resumeId = resumeFirst && items[start] && items[start].pos > 1 && !items[start].finished ? items[start].id : 0;
    const sc = el('div', 'scroller'); this.sc = sc;
    items.forEach((_, i) => { const s = el('div', 'slide'); s.dataset.i = i; sc.appendChild(s); this.slides.push(s); });
    this.root.appendChild(sc);
    sc.addEventListener('scroll', () => { clearTimeout(this.st); this.st = setTimeout(() => this.onScroll(), 90); }, { passive: true });
    requestAnimationFrame(() => { sc.scrollTop = start * sc.clientHeight; this.setCur(start); });
  }
  destroy() {
    this.saveProgress();
    if (this.sc) { this.slides.forEach((_, j) => this.detach(j)); this.sc.remove(); }
    this.sc = null; this.slides = []; this.items = []; this.cur = -1;
  }
  onScroll() {
    if (!this.sc || !this.sc.clientHeight) return;
    const i = Math.max(0, Math.min(this.items.length - 1, Math.round(this.sc.scrollTop / this.sc.clientHeight)));
    if (i !== this.cur) this.setCur(i);
  }
  goTo(i) {
    if (!this.sc || i < 0 || i >= this.items.length) return;
    this.sc.scrollTo({ top: i * this.sc.clientHeight, behavior: 'smooth' });
  }
  setCur(i) {
    if (i < 0 || i >= this.items.length) return;
    if (this.cur >= 0 && this.cur !== i) { this.saveProgress(); const ov = this.vid(this.cur); if (ov) ov.pause(); }
    this.cur = i;
    for (let j = 0; j < this.items.length; j++) {
      if (Math.abs(j - i) <= 2) this.hydrate(j); else this.dehydrate(j);
      if (Math.abs(j - i) <= 1) this.attach(j); else this.detach(j);
    }
    if (this.onChange) this.onChange(this.items[i], i);
    if (this.active) this.playCur();
  }
  vid(j) { const s = this.slides[j]; return s && s._v; }
  hydrate(j) {
    const s = this.slides[j]; if (!s || s._built) return;
    s._built = true;
    const it = this.items[j];
    s.style.setProperty('--W', s.clientWidth + 'px'); s.style.setProperty('--H', s.clientHeight + 'px');
    const poster = el('img', 'poster'); poster.draggable = false; poster.src = '/api/thumb/' + it.id;
    poster.onerror = () => poster.remove(); s.appendChild(poster); s._poster = poster;

    const info = el('div', 'info');
    info.appendChild(el('div', 't', it.title));
    const c = it.col || this.mode === 'collection' ? `${it.cname} · 第${it.seq}${this.mode === 'collection' ? '/' + this.items.length : ''}集` : it.cname;
    info.appendChild(el('div', 'c', c));
    s.appendChild(info);

    const side = el('div', 'side');
    const fav = el('button', it.fav ? 'b-fav on' : 'b-fav'); fav.innerHTML = ICON_HEART + '<span>收藏</span>';
    fav.onclick = e => { e.stopPropagation(); this.setFav(j, !this.items[j].fav); };
    const rot = el('button', 'b-rot'); rot.innerHTML = ICON_ROT + '<span></span>';
    rot.onclick = e => { e.stopPropagation(); this.rotOv[it.id] = !this.isRot(j); this.applyRot(j); };
    side.append(rot, fav); s.appendChild(side); s._fav = fav; s._rot = rot;

    const bar = el('div', 'bar'); const fill = el('i'); bar.appendChild(fill); s.appendChild(bar); s._fill = fill;
    this.bindSeek(bar, j);
    s.addEventListener('click', e => {
      if (e.target.closest('.side,.bar')) return;
      const now = Date.now();
      if (s._tap && now - s._tap < 280) { clearTimeout(s._tt); s._tap = 0; this.setFav(j, true); this.burst(s); return; }
      s._tap = now; s._tt = setTimeout(() => { s._tap = 0; this.toggle(j); }, 280);
    });
    this.applyRot(j);
  }
  dehydrate(j) {
    const s = this.slides[j]; if (!s || !s._built) return;
    this.detach(j); s.innerHTML = ''; s.className = 'slide'; s._built = false;
  }
  devPortrait(s) { return s.clientHeight > s.clientWidth; }
  isRot(j) {
    const s = this.slides[j], it = this.items[j];
    if (!s || !this.devPortrait(s) || !(it.width > it.height)) return false;
    const ov = this.rotOv[it.id];
    return ov === undefined ? autoRot : ov;
  }
  applyRot(j) {
    const s = this.slides[j]; if (!s || !s._built) return;
    const it = this.items[j];
    const can = this.devPortrait(s) && it.width > it.height, on = this.isRot(j);
    s.classList.toggle('rot', on);
    s._rot.style.display = can ? '' : 'none';
    s._rot.classList.toggle('pulse', can && !on);
    s._rot.querySelector('span').textContent = on ? '竖屏' : '横屏';
  }
  applyAllRot() {
    this.slides.forEach((s, j) => {
      if (!s._built) return;
      s.style.setProperty('--W', s.clientWidth + 'px'); s.style.setProperty('--H', s.clientHeight + 'px');
      this.applyRot(j);
    });
  }
  attach(j) {
    const s = this.slides[j]; if (!s || !s._built || s._v) return;
    const it = this.items[j];
    const v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.preload = j < this.cur ? 'metadata' : 'auto';
    v.loop = this.mode !== 'collection';
    v.muted = !Snd.on;
    v.src = '/api/stream/' + it.id;
    s.insertBefore(v, s._poster && s._poster.parentNode ? s._poster.nextSibling : s.firstChild);
    s._v = v;
    v.addEventListener('loadedmetadata', () => {
      if (v.videoWidth && !(it.width && it.height)) { it.width = v.videoWidth; it.height = v.videoHeight; this.applyRot(j); }
      else if (v.videoWidth && (v.videoWidth > v.videoHeight) !== (it.width > it.height)) { it.width = v.videoWidth; it.height = v.videoHeight; this.applyRot(j); }
      if (this.resumeId === it.id && it.pos > 1 && it.pos < v.duration - 1) { try { v.currentTime = it.pos; } catch { /* ignore */ } }
      if (this.resumeId === it.id) this.resumeId = 0;
    });
    v.addEventListener('playing', () => { if (s._poster) s._poster.style.visibility = 'hidden'; s.classList.remove('paused'); const e = s.querySelector('.errmsg'); if (e) e.remove(); });
    v.addEventListener('pause', () => { if (j === this.cur && this.active && !v.ended) s.classList.add('paused'); this.saveProgress(); });
    v.addEventListener('play', () => s.classList.remove('paused'));
    v.addEventListener('timeupdate', () => {
      if (s._fill && v.duration) s._fill.style.width = (v.currentTime / v.duration * 100) + '%';
      if (j === this.cur && !v.paused && Date.now() - this.lastSave > 5000) this.saveProgress();
    });
    v.addEventListener('ended', () => {
      if (this.mode !== 'collection') return;
      it.finished = true; it.pos = 0;
      api('/api/progress', { video_id: it.id, position: v.duration || 0, finished: true }).catch(() => {});
      if (j === this.cur) { if (j < this.items.length - 1) this.goTo(j + 1); else toast('这个合集看完啦'); }
    });
    v.addEventListener('error', async () => {
      if (!s._built) return;
      let msg = '这个视频暂时播放不了';
      try { const r = await api('/api/heartbeat', { seconds: 0 }); if (r.lock.locked) { doLock(r.lock.message); return; } } catch { /* ignore */ }
      if (!s.querySelector('.errmsg')) s.appendChild(el('div', 'errmsg', msg + '(可能是视频格式不被支持),上滑看下一个'));
    });
  }
  detach(j) {
    const s = this.slides[j]; if (!s || !s._v) return;
    const v = s._v; v.pause(); v.removeAttribute('src'); v.load(); v.remove(); s._v = null;
  }
  saveProgress() {
    if (this.cur < 0 || !this.items[this.cur]) return;
    const v = this.vid(this.cur), it = this.items[this.cur];
    if (!v || !v.duration || v.ended) return;
    this.lastSave = Date.now();
    it.pos = v.currentTime;
    api('/api/progress', { video_id: it.id, position: v.currentTime, finished: false }).catch(() => {});
  }
  setActive(on) {
    this.active = on;
    if (!this.sc) return;
    if (on) this.playCur(); else { this.slides.forEach((s, j) => { const v = this.vid(j); if (v) v.pause(); s.classList.remove('paused'); }); this.saveProgress(); }
  }
  async playCur() {
    const v = this.vid(this.cur);
    if (!v || locked || !this.active) return;
    v.muted = !Snd.on;
    try { await v.play(); }
    catch (e) {
      if (e && e.name === 'NotAllowedError') {
        Snd.on = false; v.muted = true; $('#hint').classList.remove('hidden');
        try { await v.play(); } catch { /* ignore */ }
      }
    }
  }
  applyMute() { this.slides.forEach((_, j) => { const v = this.vid(j); if (v) v.muted = !Snd.on; }); }
  isPlaying() { const v = this.vid(this.cur); return !!(v && this.active && !v.paused && !v.ended && v.readyState > 2); }
  toggle(j) {
    const v = this.vid(j); if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }
  setFav(j, on) {
    const it = this.items[j]; if (!it || it.fav === on) return;
    it.fav = on;
    const s = this.slides[j]; if (s && s._fav) s._fav.classList.toggle('on', on);
    api('/api/fav', { video_id: it.id, on }).catch(() => { it.fav = !on; if (s && s._fav) s._fav.classList.toggle('on', !on); });
    if (on) toast('已收藏');
  }
  burst(s) {
    const b = el('div', 'burst'); b.innerHTML = ICON_HEART; s.appendChild(b); setTimeout(() => b.remove(), 650);
  }
  bindSeek(bar, j) {
    const seek = e => {
      const v = this.vid(j); if (!v || !v.duration) return;
      const r = bar.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      v.currentTime = p * v.duration;
      if (this.slides[j]._fill) this.slides[j]._fill.style.width = (p * 100) + '%';
    };
    bar.addEventListener('pointerdown', e => { e.stopPropagation(); bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); seek(e); });
    bar.addEventListener('pointermove', e => { if (bar.classList.contains('drag')) seek(e); });
    const end = () => bar.classList.remove('drag');
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
  }
}

const homeFeed = new Feed($('#v-home'));
const ovFeed = new Feed($('#pFeed'));
let curTab = 'home', homeLoaded = false, playerOpen = false, subOpen = false;

function refreshActive() {
  homeFeed.setActive(!locked && !playerOpen && curTab === 'home' && !document.hidden);
  ovFeed.setActive(!locked && playerOpen && !document.hidden);
}
const activeFeed = () => (playerOpen ? ovFeed : curTab === 'home' ? homeFeed : null);

/* 第一次点击/触摸后恢复声音 */
['click', 'touchend'].forEach(ev => document.addEventListener(ev, () => {
  if (!Snd.on) { Snd.on = true; feeds.forEach(f => f.applyMute()); $('#hint').classList.add('hidden'); }
}, true));

/* =================== 时长限制 / 休息提醒 =================== */
let acc = 0, cont = 0, idle = 0, resting = false;
function doLock(msg) {
  locked = true; $('#lockMsg').textContent = msg || '现在不能看啦'; $('#lock').classList.remove('hidden');
  refreshActive();
}
$('#lockRetry').onclick = async () => {
  try {
    const r = await api('/api/me'); me = r; used = r.used;
    if (!r.lock.locked) { locked = false; $('#lock').classList.add('hidden'); refreshActive(); }
    else $('#lockMsg').textContent = r.lock.message;
  } catch { /* ignore */ }
};
function doRest() {
  resting = true; cont = 0;
  const m = me.user.break_every_min;
  $('#restMsg').textContent = `已经连续看了 ${m} 分钟啦,闭上眼睛休息一下、看看远处吧`;
  const b = $('#restBtn'); b.disabled = true; $('#rest').classList.remove('hidden');
  homeFeed.setActive(false); ovFeed.setActive(false);
  let left = 20; b.textContent = `休息 ${left} 秒`;
  const t = setInterval(() => {
    left--;
    if (left > 0) { b.textContent = `休息 ${left} 秒`; return; }
    clearInterval(t); b.disabled = false; b.textContent = '休息好了,继续看';
  }, 1000);
}
$('#restBtn').onclick = () => { resting = false; $('#rest').classList.add('hidden'); cont = 0; idle = 0; refreshActive(); };
async function beat(s) {
  try {
    const r = await api('/api/heartbeat', { seconds: s });
    used = r.used; me.lock = r.lock;
    if (r.lock.locked) doLock(r.lock.message);
  } catch { /* ignore */ }
}
setInterval(() => {
  if (!me || locked || resting) return;
  const f = activeFeed();
  if (f && f.isPlaying()) { acc++; cont++; idle = 0; } else { idle++; if (idle >= 180) cont = 0; }
  if (acc >= 10) { const s = acc; acc = 0; beat(s); }
  if (me.user.break_every_min > 0 && me.user.role !== 'admin' && cont >= me.user.break_every_min * 60) doRest();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    homeFeed.saveProgress(); ovFeed.saveProgress();
    if (acc > 0 && navigator.sendBeacon) { navigator.sendBeacon('/api/heartbeat', new Blob([JSON.stringify({ seconds: acc })], { type: 'application/json' })); acc = 0; }
  }
  refreshActive();
});
window.addEventListener('pagehide', () => { homeFeed.saveProgress(); ovFeed.saveProgress(); });

/* =================== 页面 / 导航 =================== */
function showLogin() {
  me = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  homeFeed.destroy(); ovFeed.destroy(); homeLoaded = false; playerOpen = false; subOpen = false;
  $('#player').classList.add('hidden'); $('#sub').classList.add('hidden');
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#lerr').textContent = '';
  try { await api('/api/login', { username: $('#lu').value.trim(), password: $('#lp').value }); $('#lp').value = ''; boot(); }
  catch (er) { $('#lerr').textContent = er.message; }
};
async function boot() {
  let r;
  try { r = await api('/api/me'); } catch { showLogin(); return; }
  me = r; used = r.used; locked = false;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  const u = me.user;
  $('#meAv').textContent = (u.nickname || u.username).slice(0, 1).toUpperCase();
  $('#meNick').textContent = u.nickname;
  $('#meSub').textContent = (u.role === 'admin' ? '管理员 · ' : '') + '账号: ' + u.username;
  $('#mAdmin').classList.toggle('hidden', u.role !== 'admin');
  $('#mPwd').classList.toggle('hidden', u.role !== 'admin');
  $('#autoSw').classList.toggle('on', autoRot);
  if (r.lock.locked) doLock(r.lock.message);
  showTab(curTab, true);
}
function showTab(t, force) {
  if (!force && t === curTab && homeLoaded) { if (t !== 'home') loadTab(t); return; }
  curTab = t;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('hidden', x.id !== 'v-' + t));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $('#app').classList.toggle('home', t === 'home');
  loadTab(t); refreshActive();
}
async function loadTab(t) {
  if (t === 'home') return loadHome();
  if (t === 'cols') return loadCols();
  if (t === 'fav') return loadFav();
  if (t === 'me') return loadMe();
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => showTab(b.dataset.t));

function msgBox(parent, text) { const d = el('div', 'loading', text); parent.appendChild(d); return d; }
async function loadHome() {
  if (homeLoaded) return;
  homeLoaded = true;
  const root = $('#v-home'); const box = msgBox(root, '加载中…');
  try {
    const r = await api('/api/feed?mode=random');
    box.remove();
    if (!r.items.length) { msgBox(root, '还没有视频\n请先到管理后台添加视频库并扫描'); homeLoaded = false; return; }
    homeFeed.mount(r.items, 0, 'random', false);
    refreshActive();
  } catch (e) {
    box.textContent = e.status === 403 ? '请到「合集」里选一个想看的内容吧 😊' : (e.message || '加载失败');
    if (e.status !== 403) homeLoaded = false;
  }
}
function card(o) {
  const c = el('div', 'card');
  const im = el('div', 'im');
  if (o.img) { const i = el('img'); i.loading = 'lazy'; i.src = o.img; i.onerror = () => i.remove(); im.appendChild(i); }
  if (o.badge) im.appendChild(el('div', 'badge', o.badge));
  const tx = el('div', 'tx'); tx.appendChild(el('div', 'nm', o.name)); if (o.meta) tx.appendChild(el('div', 'mt', o.meta));
  if (o.pct) { const pg = el('div', 'pg'); const i = el('i'); i.style.width = o.pct + '%'; pg.appendChild(i); tx.appendChild(pg); }
  c.append(im, tx); c.onclick = o.onclick; return c;
}
async function loadCols() {
  const g = $('#colGrid');
  try {
    const list = await api('/api/collections');
    g.innerHTML = '';
    if (!list.length) { g.appendChild(el('div', 'empty', '还没有可看的合集\n请家长在管理后台添加视频库')); return; }
    list.forEach(c => g.appendChild(card({
      img: '/api/thumb/' + c.cover, name: c.name, meta: `${c.count} 集 · ${fmtDur(c.duration)}`,
      badge: c.done ? `${c.done}/${c.count}` : '', pct: c.count ? c.done / c.count * 100 : 0,
      onclick: () => openSub({ title: c.name, mode: 'collection', url: `/api/feed?mode=collection&lib=${c.lib}&col=${encodeURIComponent(c.col)}` })
    })));
  } catch (e) { g.innerHTML = ''; g.appendChild(el('div', 'empty', e.message)); }
}
async function loadFav() {
  const g = $('#favGrid');
  try {
    const r = await api('/api/feed?mode=fav');
    g.innerHTML = '';
    if (!r.items.length) { g.appendChild(el('div', 'empty', '还没有收藏\n看视频时点 ♥ 或者双击屏幕就能收藏')); return; }
    r.items.forEach((it, i) => g.appendChild(card({ img: '/api/thumb/' + it.id, name: it.title, meta: it.cname, onclick: () => openPlayer(r.items, i, 'fav') })));
  } catch (e) { g.innerHTML = ''; g.appendChild(el('div', 'empty', e.message)); }
}
async function loadMe() {
  try { const r = await api('/api/me'); me = r; used = r.used; } catch { return; }
  const u = me.user, box = $('#meUsage');
  if (u.daily_limit_min > 0 && u.role !== 'admin') {
    const lim = u.daily_limit_min * 60, left = Math.max(0, lim - used);
    box.classList.remove('hidden'); box.innerHTML = '';
    box.appendChild(el('div', '', `今天已看 ${Math.floor(used / 60)} 分钟,还可以看 ${Math.ceil(left / 60)} 分钟`));
    const b = el('div', 'bar2'); const i = el('i'); i.style.width = Math.min(100, used / lim * 100) + '%'; b.appendChild(i); box.appendChild(b);
  } else box.classList.add('hidden');
}
$('#mHistory').onclick = () => openSub({ title: '观看历史', mode: 'history', url: '/api/feed?mode=history' });
$('#mAuto').onclick = () => {
  autoRot = !autoRot; store.set('autoRot', autoRot ? '1' : '0');
  $('#autoSw').classList.toggle('on', autoRot);
  feeds.forEach(f => { f.rotOv = {}; f.applyAllRot(); });
};
$('#mAdmin').onclick = () => { location.href = '/admin.html'; };
// 仅在 Android App 里显示:回到壳里的服务器地址页
if (/ShortvidApp/.test(navigator.userAgent)) $('#mServer').classList.remove('hidden');
$('#mServer').onclick = () => { location.href = 'http://localhost/?change=1'; };
$('#mPwd').onclick = async () => {
  const old = prompt('请输入原密码'); if (old == null) return;
  const neu = prompt('请输入新密码(至少 6 位)'); if (neu == null) return;
  try { await api('/api/password', { old, neu }); toast('密码已修改'); } catch (e) { toast(e.message); }
};
$('#mLogout').onclick = async () => { try { await api('/api/logout', {}); } catch { /* ignore */ } showLogin(); };

/* ---- 合集/历史 子页面 与 全屏播放 ---- */
async function openSub(o) {
  const page = $('#sub'); $('#sTitle').textContent = o.title;
  const g = $('#subGrid'); g.innerHTML = ''; g.appendChild(el('div', 'empty', '加载中…'));
  page.classList.remove('hidden'); page.scrollTop = 0; subOpen = true; history.pushState({ v: 'sub' }, '');
  try {
    const r = await api(o.url);
    g.innerHTML = '';
    if (!r.items.length) { g.appendChild(el('div', 'empty', '这里还没有内容')); return; }
    if (o.mode === 'collection') {
      const cont = r.items[r.start];
      const b = el('button', 'btn', r.items.some(x => x.pos > 0 || x.finished) ? `▶ 继续播放(第 ${cont.seq} 集)` : '▶ 从头播放');
      b.style.cssText = 'grid-column:1/-1'; b.onclick = () => openPlayer(r.items, r.start, 'collection', o.title, true); g.appendChild(b);
    }
    r.items.forEach((it, i) => g.appendChild(card({
      img: '/api/thumb/' + it.id,
      name: o.mode === 'collection' ? `第${it.seq}集 ${it.title}` : it.title,
      meta: o.mode === 'collection' ? fmtDur(it.duration) + (it.finished ? ' · 已看完' : it.pos > 1 ? ' · 看到 ' + fmtDur(it.pos) : '') : it.cname,
      pct: it.duration && it.pos && !it.finished ? it.pos / it.duration * 100 : it.finished ? 100 : 0,
      onclick: () => openPlayer(r.items, i, o.mode, o.title, o.mode === 'collection' && it.pos > 1 && !it.finished)
    })));
  } catch (e) { g.innerHTML = ''; g.appendChild(el('div', 'empty', e.message)); }
}
function openPlayer(items, start, mode, title, resume) {
  playerOpen = true; history.pushState({ v: 'player' }, '');
  $('#player').classList.remove('hidden'); $('#pTitle').textContent = title || '';
  ovFeed.onChange = it => { if (!title) $('#pTitle').textContent = it.cname; };
  ovFeed.mount(items, start, mode, resume);
  refreshActive();
}
function closePlayer() {
  playerOpen = false; ovFeed.destroy(); $('#player').classList.add('hidden'); refreshActive();
  if (curTab === 'cols') loadCols(); else if (curTab === 'fav') loadFav();
}
function closeSub() { subOpen = false; $('#sub').classList.add('hidden'); if (curTab === 'cols') loadCols(); }
$('#pBack').onclick = () => history.back();
$('#sBack').onclick = () => history.back();
window.addEventListener('popstate', () => {
  if (playerOpen) closePlayer(); else if (subOpen) closeSub();
});

/* ---- 键盘(电脑) / 窗口变化 ---- */
document.addEventListener('keydown', e => {
  const f = activeFeed(); if (!f || !f.sc || locked || resting) return;
  if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); f.goTo(f.cur + 1); }
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); f.goTo(f.cur - 1); }
  else if (e.key === ' ') { e.preventDefault(); f.toggle(f.cur); }
  else if (e.key === 'Escape' && playerOpen) history.back();
});
let rz; window.addEventListener('resize', () => {
  clearTimeout(rz); rz = setTimeout(() => feeds.forEach(f => { if (f.sc && f.cur >= 0) { f.applyAllRot(); f.sc.scrollTop = f.cur * f.sc.clientHeight; } }), 150);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
