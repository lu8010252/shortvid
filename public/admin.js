'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
let libsCache = [];

async function api(url, method, body) {
  const opt = { method: method || 'GET', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch('/api/admin' + url, opt);
  let j = {}; try { j = await r.json(); } catch { /* ignore */ }
  if (r.status === 401 || r.status === 403) { location.href = '/'; throw new Error(j.error || '无权限'); }
  if (!r.ok) throw new Error(j.error || '请求失败');
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); }
const wrap = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const fmtDur = s => { s = Math.round(s || 0); return s < 60 ? s + '秒' : Math.round(s / 60) + '分钟'; };
const fmtTime = t => { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

function modal(title, build, onOk, okText) {
  const mask = el('div', 'mask'), box = el('div', 'modal');
  box.appendChild(el('h3', '', title));
  const body = el('div'); box.appendChild(body); build(body);
  const f = el('div', 'mf');
  const close = () => mask.remove();
  const cancel = el('button', 'btn g', onOk ? '取消' : '关闭'); cancel.onclick = close; f.appendChild(cancel);
  if (onOk) { const ok = el('button', 'btn', okText || '保存'); ok.onclick = wrap(async () => { if ((await onOk()) !== false) close(); }); f.appendChild(ok); }
  box.appendChild(f); mask.appendChild(box);
  mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  return { close, body };
}
function field(parent, label, input) { const l = el('label', '', label); parent.append(l, input); return input; }
function inp(type, val, ph) { const i = el('input'); i.type = type; if (val != null) i.value = val; if (ph) i.placeholder = ph; return i; }
function chk(parent, text, on) { const l = el('label', 'chk'); const c = el('input'); c.type = 'checkbox'; c.checked = !!on; l.append(c, document.createTextNode(text)); parent.appendChild(l); return c; }

/* ---------- 概览 ---------- */
async function loadOverview() {
  const o = await api('/overview');
  const s = $('#stats'); s.innerHTML = '';
  [[o.videos, '视频'], [o.collections, '合集'], [o.users, '用户']].forEach(([n, t]) => { const d = el('div', 'stat'); d.append(el('b', '', n), el('span', '', t)); s.appendChild(d); });
  const w = [];
  if (o.hevc) w.push(`有 ${o.hevc} 个视频是 H.265(HEVC) 编码,部分手机/浏览器可能无法播放,建议转成 H.264。`);
  if (o.unprobed) w.push(`还有 ${o.unprobed} 个视频正在读取信息/生成封面。`);
  $('#warn').textContent = w.join(' ');
}

/* ---------- 视频库 ---------- */
async function loadLibs() {
  libsCache = await api('/libs');
  const box = $('#libs'); box.innerHTML = '';
  if (!libsCache.length) { box.appendChild(el('div', 'empty', '还没有视频库,点右上角「添加」')); return; }
  libsCache.forEach(l => {
    const r = el('div', 'row'), m = el('div', 'm');
    const n = el('div', 'n'); n.append(el('span', 'tag', '视频'), document.createTextNode(l.name));
    m.append(n, el('div', 's', l.path), el('div', 's', `视频数量:${l.cnt}` + (l.hevc ? `(其中 H.265:${l.hevc})` : '')));
    const ops = el('div', 'ops');
    const b = (t, c, fn) => { const x = el('button', 'btn s ' + c, t); x.onclick = wrap(fn); ops.appendChild(x); };
    b('合集排序', 'g', () => openCollections(l));
    b('扫描', 'g', async () => { await api(`/libs/${l.id}/scan`, 'POST', {}); toast('已开始扫描,见下方后台任务'); loadTasks(); });
    b('编辑', 'g', () => editLib(l));
    b('删除', 'd', async () => { if (!confirm(`删除视频库「${l.name}」?只会删除库记录,不会删除服务器上的视频文件。`)) return; await api('/libs/' + l.id, 'DELETE'); refresh(); });
    r.append(m, ops); box.appendChild(r);
  });
}
function editLib(l) {
  let name, path;
  modal(l ? '编辑视频库' : '添加视频库', body => {
    name = field(body, '名称', inp('text', l ? l.name : '', '例如:呱呱和辣条'));
    path = field(body, '文件夹路径(容器内)', inp('text', l ? l.path : '/video', '/video/xxx'));
    const br = el('button', 'btn g s', '浏览文件夹…'); br.style.marginTop = '8px';
    br.onclick = () => browse(path.value, p => { path.value = p; if (!name.value) name.value = p.split('/').filter(Boolean).pop(); });
    body.appendChild(br);
    body.appendChild(el('div', 'hint', '路径是容器里的路径:docker-compose 里把服务器目录挂载到 /video,这里就从 /video 往下选。'));
  }, async () => {
    const b = { name: name.value, path: path.value };
    if (l) await api('/libs/' + l.id, 'PUT', b); else await api('/libs', 'POST', b);
    toast(l ? '已保存' : '已添加,正在后台扫描'); refresh();
  });
}
function browse(start, pick) {
  const m = modal('选择文件夹', body => {
    const cur = el('div', 'hint'), list = el('div'); body.append(cur, list);
    const go = wrap(async p => {
      const r = await api('/browse?path=' + encodeURIComponent(p || ''));
      cur.textContent = '当前:' + r.path; list.innerHTML = '';
      if (r.parent) { const u = el('div', 'dir', '⬆ 上一级'); u.onclick = () => go(r.parent); list.appendChild(u); }
      r.dirs.forEach(d => { const x = el('div', 'dir', '📁 ' + d); x.onclick = () => go(r.path + '/' + d); list.appendChild(x); });
      if (!r.dirs.length) list.appendChild(el('div', 'empty', '没有子文件夹'));
      m.cur = r.path;
    });
    go(start && start.startsWith('/video') ? start : '');
  }, () => { if (!m.cur) return false; pick(m.cur); }, '选择当前文件夹');
}

/* ---------- 合集排序 ---------- */
async function openCollections(l) {
  const cols = await api(`/libs/${l.id}/collections`);
  modal(`「${l.name}」的合集`, body => {
    if (!cols.length) body.appendChild(el('div', 'empty', '还没有视频,请先扫描'));
    cols.forEach(c => {
      const d = el('div', 'dir', `📂 ${c.name}(${c.count} 集)`);
      d.onclick = () => editOrder(l, c); body.appendChild(d);
    });
    body.appendChild(el('div', 'hint', '点击合集可调整集数顺序、修改标题。默认已按「第2集 < 第10集」自然排序。'));
  });
}
async function editOrder(l, c) {
  let rows = await api(`/collection?lib=${l.id}&col=${encodeURIComponent(c.col)}`);
  const m = modal(`${c.name} · 集数顺序`, body => {
    const list = el('div'); body.appendChild(list);
    const draw = () => {
      list.innerHTML = '';
      rows.forEach((r, i) => {
        const d = el('div', 'ep');
        const nm = el('div', 'nm'); nm.append(document.createTextNode(r.title), el('small', '', r.rel_path.split('/').pop()));
        const mk = (t, fn) => { const b = el('button', '', t); b.onclick = fn; return b; };
        d.append(el('div', 'no', i + 1), nm,
          mk('↑', () => { if (i) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }),
          mk('↓', () => { if (i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); } }),
          mk('✎', wrap(async () => { const t = prompt('视频标题', r.title); if (t && t.trim()) { await api('/videos/' + r.id, 'PUT', { title: t.trim() }); r.title = t.trim(); draw(); } })));
        list.appendChild(d);
      });
    };
    draw();
    const rs = el('button', 'btn g s', '恢复自动排序(按文件名)'); rs.style.marginTop = '12px';
    rs.onclick = wrap(async () => { await api('/reorder-reset', 'POST', { lib: l.id, col: c.col }); toast('已恢复自动排序'); m.close(); });
    body.appendChild(rs);
  }, async () => { await api('/reorder', 'POST', { ids: rows.map(r => r.id) }); toast('顺序已保存'); });
}

/* ---------- 用户 ---------- */
async function loadUsers() {
  const list = await api('/users');
  const box = $('#users'); box.innerHTML = '';
  list.forEach(u => {
    const r = el('div', 'row'), m = el('div', 'm');
    const n = el('div', 'n');
    n.append(el('span', u.role === 'admin' ? 'tag r' : 'tag', u.role === 'admin' ? '管理员' : '孩子'), document.createTextNode(`${u.nickname || u.username}(${u.username})`));
    if (!u.enabled) n.appendChild(el('span', 'tag w', '已停用'));
    const info = [];
    if (u.role !== 'admin') {
      info.push(u.daily_limit_min ? `每日 ${u.daily_limit_min} 分钟,今天已看 ${Math.floor(u.used / 60)} 分钟` : `不限时长,今天已看 ${Math.floor(u.used / 60)} 分钟`);
      if (u.break_every_min) info.push(`每 ${u.break_every_min} 分钟提醒休息`);
      if (u.quiet_start && u.quiet_end) info.push(`${u.quiet_start}-${u.quiet_end} 禁止观看`);
      info.push(u.allow_random ? '可随便刷' : '只能看合集');
      info.push('可看视频库:' + (u.libs.map(id => (libsCache.find(l => l.id === id) || {}).name).filter(Boolean).join('、') || '无'));
    }
    m.append(n, el('div', 's', info.join(' · ')));
    const ops = el('div', 'ops');
    const b = (t, c, fn) => { const x = el('button', 'btn s ' + c, t); x.onclick = wrap(fn); ops.appendChild(x); };
    if (u.role !== 'admin' && u.daily_limit_min) b('重置今日', 'g', async () => { await api(`/users/${u.id}/reset-usage`, 'POST', {}); refresh(); });
    b('编辑', 'g', () => editUser(u));
    b('删除', 'd', async () => { if (!confirm(`删除用户「${u.username}」及其观看记录、收藏?`)) return; await api('/users/' + u.id, 'DELETE'); refresh(); });
    r.append(m, ops); box.appendChild(r);
  });
}
function editUser(u) {
  const f = {};
  modal(u ? '编辑用户' : '添加用户', body => {
    if (!u) f.username = field(body, '账号(字母/数字/下划线)', inp('text', '', 'kid1'));
    f.nickname = field(body, '昵称', inp('text', u ? u.nickname : '', '例如:大宝'));
    f.password = field(body, u ? '新密码(不改请留空)' : '密码', inp('text', '', u ? '留空表示不修改' : '至少 4 位'));
    const r = el('select'); [['user', '孩子/普通用户'], ['admin', '管理员']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; r.appendChild(o); });
    r.value = u ? u.role : 'user'; f.role = field(body, '身份', r);
    const row = el('div', 'two'); body.appendChild(row);
    const a = el('div'), b = el('div'); row.append(a, b);
    f.limit = field(a, '每日最长观看(分钟,0=不限)', inp('number', u ? u.daily_limit_min : 40));
    f.brk = field(b, '连续观看多久提醒休息(分钟,0=不提醒)', inp('number', u ? u.break_every_min : 20));
    const row2 = el('div', 'two'); body.appendChild(row2);
    const c = el('div'), d = el('div'); row2.append(c, d);
    f.qs = field(c, '禁止观看开始时间(HH:MM)', inp('text', u ? u.quiet_start : '', '例如 21:00'));
    f.qe = field(d, '禁止观看结束时间(HH:MM)', inp('text', u ? u.quiet_end : '', '例如 07:00'));
    body.appendChild(el('div', 'hint', '不需要禁止时段就两个都留空;跨夜(如 21:00 到 07:00)也可以。管理员不受限制。'));
    body.appendChild(el('label', '', '可观看的视频库'));
    f.libs = libsCache.map(l => ({ id: l.id, c: chk(body, l.name, u ? u.libs.includes(l.id) : false) }));
    if (!libsCache.length) body.appendChild(el('div', 'hint', '还没有视频库'));
    body.appendChild(el('div', 'hint', '(管理员默认能看所有视频库)'));
    f.random = chk(body, '允许「随便刷」(首页随机推荐);关闭后只能在合集里选着看', u ? u.allow_random : true);
    f.enabled = chk(body, '账号启用(取消勾选相当于暂停此账号)', u ? u.enabled : true);
  }, async () => {
    const b = {
      username: f.username ? f.username.value : u.username, nickname: f.nickname.value, password: f.password.value, role: f.role.value,
      daily_limit_min: f.limit.value, break_every_min: f.brk.value, quiet_start: f.qs.value.trim(), quiet_end: f.qe.value.trim(),
      libs: f.libs.filter(x => x.c.checked).map(x => x.id), allow_random: f.random.checked, enabled: f.enabled.checked
    };
    if (u) await api('/users/' + u.id, 'PUT', b); else await api('/users', 'POST', b);
    toast('已保存'); refresh();
  });
}

/* ---------- 任务 ---------- */
async function loadTasks() {
  const list = await api('/tasks');
  const box = $('#tasks'); box.innerHTML = '';
  if (!list.length) { box.appendChild(el('div', 'empty', '暂无任务')); return; }
  list.forEach(t => {
    const d = el('div', 'task');
    const cls = { done: 'tag ok', failed: 'tag r', running: 'tag w', pending: 'tag' }[t.status] || 'tag';
    const lab = { done: '完成', failed: '失败', running: '进行中', pending: '排队' }[t.status] || t.status;
    const tx = el('div', 't'); tx.append(el('span', cls, lab), document.createTextNode(t.title + ' — ' + (t.detail || '')));
    d.append(tx, el('time', '', fmtTime(t.created_at))); box.appendChild(d);
  });
}
async function refresh() { await Promise.all([loadOverview(), loadLibs().then(loadUsers), loadTasks()]); }

$('#addLib').onclick = () => editLib(null);
$('#addUser').onclick = () => editUser(null);
$('#goHome').onclick = () => { location.href = '/'; };
$('#clearTasks').onclick = wrap(async () => { await api('/tasks', 'DELETE'); loadTasks(); });
refresh().catch(e => toast(e.message));
setInterval(() => { if (!document.hidden) { loadTasks().catch(() => {}); loadOverview().catch(() => {}); } }, 4000);
