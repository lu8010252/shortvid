'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/video');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const H264_DIR = path.join(DATA_DIR, 'h264');
fs.mkdirSync(H264_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, nickname TEXT, pass_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user', enabled INTEGER DEFAULT 1,
  daily_limit_min INTEGER DEFAULT 0, break_every_min INTEGER DEFAULT 0,
  quiet_start TEXT DEFAULT '', quiet_end TEXT DEFAULT '', allow_random INTEGER DEFAULT 1,
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS libraries(id INTEGER PRIMARY KEY, name TEXT, path TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS user_libs(user_id INTEGER, lib_id INTEGER, PRIMARY KEY(user_id, lib_id));
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY, lib_id INTEGER, rel_path TEXT, collection TEXT DEFAULT '', seq INTEGER DEFAULT 0,
  manual INTEGER DEFAULT 0, title TEXT, size INTEGER, mtime INTEGER,
  duration REAL DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, vcodec TEXT DEFAULT '',
  has_thumb INTEGER DEFAULT 0, probed INTEGER DEFAULT 0, UNIQUE(lib_id, rel_path));
CREATE INDEX IF NOT EXISTS idx_videos_col ON videos(lib_id, collection, seq);
CREATE TABLE IF NOT EXISTS progress(
  user_id INTEGER, video_id INTEGER, position REAL DEFAULT 0, finished INTEGER DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY(user_id, video_id));
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER, video_id INTEGER, created_at INTEGER, PRIMARY KEY(user_id, video_id));
CREATE TABLE IF NOT EXISTS usage(user_id INTEGER, day TEXT, seconds INTEGER DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS collection_meta(lib_id INTEGER, collection TEXT, category TEXT, PRIMARY KEY(lib_id, collection));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, type TEXT, title TEXT, status TEXT, detail TEXT, created_at INTEGER, finished_at INTEGER);
`);
try { db.exec('ALTER TABLE libraries ADD COLUMN merge INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
db.prepare(`UPDATE tasks SET status='failed', detail='服务重启,任务已中断', finished_at=? WHERE status IN ('running','pending')`).run(Date.now());

// ---------- 工具函数 ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, h) {
  try {
    const [s, k] = String(h).split(':');
    const a = Buffer.from(k, 'hex');
    const b = crypto.scryptSync(pw, s, 32);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const A = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intOr = (v, d, min, max) => {
  v = parseInt(v, 10);
  if (isNaN(v)) return d;
  return Math.max(min, Math.min(max, v));
};
const hmOk = s => s === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);

// ---------- 初始管理员 ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'admin123';
  db.prepare('INSERT INTO users(username,nickname,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(u, u, hashPw(p), 'admin', Date.now());
  console.log(`已创建管理员账号 ${u}(初始密码见环境变量 ADMIN_PASS,默认 admin123,请尽快修改)`);
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 3600e3);

// ---------- 限时 / 休息时段 ----------
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
function parseHM(s) {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function inQuiet(u) {
  const a = parseHM(u.quiet_start), b = parseHM(u.quiet_end);
  if (a == null || b == null || a === b) return false;
  const n = nowMin();
  return a < b ? (n >= a && n < b) : (n >= a || n < b);
}
function usageToday(uid) {
  const r = db.prepare('SELECT seconds FROM usage WHERE user_id=? AND day=?').get(uid, today());
  return r ? r.seconds : 0;
}
function lockState(u) {
  if (u.role === 'admin') return { locked: false };
  if (inQuiet(u)) return { locked: true, reason: 'quiet', message: `${u.quiet_start} - ${u.quiet_end} 是休息时间,等会儿再来吧` };
  if (u.daily_limit_min > 0) {
    const left = u.daily_limit_min * 60 - usageToday(u.id);
    if (left <= 0) return { locked: true, reason: 'limit', message: '今天的观看时间用完啦,明天再来吧' };
    return { locked: false, remaining: left };
  }
  return { locked: false };
}

// ---------- 自然排序 ----------
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
function cn2num(s) {
  const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (a ? d[a] : 1) * 10 + (b ? d[b] : 0);
  }
  return s.split('').map(c => d[c]).join('');
}
function normName(n) {
  return n.replace(/第([零〇一二两三四五六七八九十]+)([集话話期章回季])/g, (m, a, b) => '第' + cn2num(a) + b);
}
const natCmp = (a, b) => collator.compare(normName(path.basename(a)), normName(path.basename(b)));

function renumber(libId, col, reset) {
  const rows = db.prepare('SELECT id,rel_path,seq,manual,mtime FROM videos WHERE lib_id=? AND collection=?').all(libId, col);
  // 每个视频各占一个子文件夹(合并后的合集):按文件时间新的在前
  const merged = rows.length > 1 && rows.every(r => path.posix.dirname(r.rel_path) !== (col || '.'));
  const byTime = (a, b) => (b.mtime - a.mtime) || natCmp(a.rel_path, b.rel_path);
  const hasManual = !reset && rows.some(r => r.manual);
  let list;
  if (hasManual) {
    const fixed = rows.filter(r => r.seq > 0).sort((a, b) => a.seq - b.seq);
    const fresh = rows.filter(r => !(r.seq > 0)).sort(merged ? byTime : (a, b) => natCmp(a.rel_path, b.rel_path));
    list = fixed.concat(fresh);
  } else {
    list = rows.sort(merged ? byTime : (a, b) => natCmp(a.rel_path, b.rel_path));
  }
  const up = db.prepare('UPDATE videos SET seq=?, manual=? WHERE id=?');
  db.transaction(() => list.forEach((r, i) => up.run(i + 1, hasManual ? r.manual : 0, r.id)))();
}

// ---------- 扫描 ----------
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.flv', '.ts', '.3gp', '.wmv']);
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.3gp': 'video/3gpp' };

function insideRoot(p) {
  const r = path.resolve(p);
  return r === VIDEO_ROOT || r.startsWith(VIDEO_ROOT + path.sep);
}
async function walk(root, rel, out) {
  let ents;
  try { ents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('@') || e.name.startsWith('#')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { await walk(root, r, out); continue; }
    if (!VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    try {
      const st = await fsp.stat(path.join(root, r));
      if (st.isFile()) out.push({ rel: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
    } catch { /* ignore */ }
  }
}
function probe(file) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', file],
      { timeout: 30000, maxBuffer: 4 << 20 }, (err, out) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(out);
          const s = (j.streams || [])[0] || {};
          let w = s.width || 0, h = s.height || 0, rot = 0;
          if (s.tags && s.tags.rotate) rot = +s.tags.rotate;
          for (const d of s.side_data_list || []) if (d.rotation !== undefined) rot = +d.rotation;
          rot = ((rot % 360) + 360) % 360;
          if (rot === 90 || rot === 270) [w, h] = [h, w];
          resolve({ duration: +((j.format && j.format.duration) || s.duration) || 0, width: w, height: h, codec: s.codec_name || '' });
        } catch { resolve(null); }
      });
  });
}
function makeThumb(file, out, dur) {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-ss', String(dur > 6 ? 2 : 0), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out],
      { timeout: 60000 }, err => resolve(!err && fs.existsSync(out)));
  });
}
function delVideos(ids) {
  if (!ids.length) return;
  const run = db.transaction(() => {
    for (const id of ids) {
      db.prepare('DELETE FROM progress WHERE video_id=?').run(id);
      db.prepare('DELETE FROM favorites WHERE video_id=?').run(id);
      db.prepare('DELETE FROM videos WHERE id=?').run(id);
    }
  });
  run();
  for (const id of ids) fs.unlink(path.join(THUMB_DIR, id + '.jpg'), () => {});
}
function setTask(id, status, detail) {
  const fin = status === 'done' || status === 'failed' ? Date.now() : null;
  db.prepare('UPDATE tasks SET status=?, detail=?, finished_at=? WHERE id=?').run(status, detail, fin, id);
}
let queue = Promise.resolve();
function enqueueScan(lib) {
  const id = db.prepare('INSERT INTO tasks(type,title,status,detail,created_at) VALUES(?,?,?,?,?)')
    .run('scan', '扫描:' + lib.name, 'pending', '排队中', Date.now()).lastInsertRowid;
  queue = queue.then(() => runScan(lib, id)).catch(e => setTask(id, 'failed', String((e && e.message) || e)));
  return id;
}
async function runScan(lib, tid) {
  setTask(tid, 'running', '读取目录…');
  if (!fs.existsSync(lib.path)) throw new Error('目录不存在:' + lib.path);
  const files = [];
  await walk(lib.path, '', files);
  const existing = new Map(db.prepare('SELECT * FROM videos WHERE lib_id=?').all(lib.id).map(r => [r.rel_path, r]));
  const seen = new Set();
  const touched = new Set();
  let added = 0, removed = 0;
  const ins = db.prepare('INSERT INTO videos(lib_id,rel_path,collection,title,size,mtime) VALUES(?,?,?,?,?,?)');
  const mv = db.prepare('UPDATE videos SET collection=?,seq=0,manual=0 WHERE id=?');
  const perDir = new Map();
  for (const f of files) { const d = path.posix.dirname(f.rel); perDir.set(d, (perDir.get(d) || 0) + 1); }
  const upd = db.prepare('UPDATE videos SET size=?,mtime=?,probed=0,has_thumb=0 WHERE id=?');
  db.transaction(() => {
    for (const f of files) {
      seen.add(f.rel);
      const e = existing.get(f.rel);
      const dir = path.posix.dirname(f.rel);
      let col = dir === '.' ? '' : dir;
      // 合并:文件夹里只有一个视频时,归入上一级文件夹的合集
      if (lib.merge && col && perDir.get(dir) === 1) { const up = path.posix.dirname(col); col = up === '.' ? '' : up; }
      if (e && e.collection !== col) { mv.run(col, e.id); touched.add(e.collection); touched.add(col); }
      if (!e) {
        ins.run(lib.id, f.rel, col, path.basename(f.rel, path.extname(f.rel)), f.size, f.mtime);
        touched.add(col); added++;
      } else if (e.size !== f.size || e.mtime !== f.mtime) {
        upd.run(f.size, f.mtime, e.id);
      }
    }
  })();
  const gone = [];
  for (const [rel, e] of existing) if (!seen.has(rel)) { gone.push(e.id); touched.add(e.collection); }
  removed = gone.length;
  delVideos(gone);
  for (const col of touched) renumber(lib.id, col, false);

  const todo = db.prepare('SELECT id,rel_path FROM videos WHERE lib_id=? AND probed=0').all(lib.id);
  let n = 0;
  for (const v of todo) {
    n++;
    if (n % 3 === 1) setTask(tid, 'running', `新增 ${added},移除 ${removed};读取信息/生成封面 ${n}/${todo.length}`);
    const file = path.join(lib.path, v.rel_path);
    const info = await probe(file);
    let thumb = 0;
    if (info) {
      thumb = (await makeThumb(file, path.join(THUMB_DIR, v.id + '.jpg'), info.duration)) ? 1 : 0;
      db.prepare('UPDATE videos SET duration=?,width=?,height=?,vcodec=?,has_thumb=?,probed=1 WHERE id=?')
        .run(info.duration, info.width, info.height, info.codec, thumb, v.id);
    } else {
      db.prepare('UPDATE videos SET probed=1 WHERE id=?').run(v.id);
    }
  }
  setTask(tid, 'done', `完成:共 ${files.length} 个视频,新增 ${added},移除 ${removed}`);
}

// ---------- 应用 ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

function auth(req, res, next) {
  // 原生播放器(TV APK 的 ExoPlayer)拿不到网页的 cookie,视频流接口额外允许 ?k=<会话令牌>
  const sid = parseCookies(req.headers.cookie).sid || (req.path.startsWith('/api/stream/') ? String(req.query.k || '') : '');
  if (!sid) return res.status(401).json({ error: '未登录' });
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(sid, Date.now());
  if (!u || !u.enabled) return res.status(401).json({ error: '未登录或账号已停用' });
  req.user = u;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}
function allowedLibs(u) {
  if (u.role === 'admin') return db.prepare('SELECT id FROM libraries').all().map(r => r.id);
  return db.prepare('SELECT lib_id id FROM user_libs WHERE user_id=?').all(u.id).map(r => r.id);
}
const inList = ids => (ids.length ? ids.map(Number).join(',') : '-1');
function videoFor(u, id) {
  const v = db.prepare('SELECT v.*,l.path lib_path FROM videos v JOIN libraries l ON l.id=v.lib_id WHERE v.id=?').get(id);
  if (!v) return null;
  if (u.role !== 'admin' && !db.prepare('SELECT 1 FROM user_libs WHERE user_id=? AND lib_id=?').get(u.id, v.lib_id)) return null;
  return v;
}
const publicUser = u => ({
  id: u.id, username: u.username, nickname: u.nickname || u.username, role: u.role,
  break_every_min: u.break_every_min, daily_limit_min: u.daily_limit_min, allow_random: !!u.allow_random
});

// ----- 登录 -----
function newSession(req, res, uid, days) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, uid, Date.now() + days * 864e5);
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${req.secure ? '; Secure' : ''}`);
}
const attempts = new Map();
app.post('/api/stream-key', auth, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, req.user.id, Date.now() + 864e5);
  res.json({ key: token });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 600e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: '尝试次数过多,请 10 分钟后再试' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  if (!u || !checkPw(String(password || ''), u.pass_hash)) {
    a.n++; attempts.set(ip, a);
    return res.status(400).json({ error: '账号或密码错误' });
  }
  if (!u.enabled) return res.status(403).json({ error: '账号已停用' });
  attempts.delete(ip);
  newSession(req, res, u.id, 30);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token=?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) =>
  res.json({ user: publicUser(req.user), lock: lockState(req.user), used: usageToday(req.user.id) }));
app.post('/api/password', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '请让家长修改密码' });
  const { old, neu } = req.body || {};
  if (!checkPw(String(old || ''), req.user.pass_hash)) return res.status(400).json({ error: '原密码不对' });
  if (String(neu || '').length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPw(String(neu)), req.user.id);
  res.json({ ok: true });
});


// ---------- 名称清理(只影响显示,不改文件) ----------
const DEFAULT_RULES = {
  cut: ['文脉里的', '科普新锐扶持计划', '边画边写讲知识', '抖音前沿科技首发计划'],
  strip: ['抖音精选作者宠粉福利抖音精选app', '抖音独家', '抖音精选首发', '抖音精选', '混子哥边走边画边讲', '混子哥边画边讲'],
};
let rulesCache = null;
function getRules() {
  if (rulesCache) return rulesCache;
  const r = db.prepare("SELECT v FROM settings WHERE k='name_rules'").get();
  let o = null; try { o = r && JSON.parse(r.v); } catch { /* ignore */ }
  rulesCache = o && Array.isArray(o.cut) && Array.isArray(o.strip) ? o : DEFAULT_RULES;
  return rulesCache;
}
function cleanName(s) {
  if (!s) return s;
  const { cut, strip } = getRules();
  let t = String(s);
  for (const w of strip) if (w) t = t.split(w).join('');
  let at = t.length;
  for (const w of cut) { const i = w ? t.indexOf(w) : -1; if (i > 0 && i < at) at = i; }
  t = t.slice(0, at).replace(/^[\s\-_·、,,.。]+|[\s\-_·、,,.。]+$/g, '');
  return t || String(s);
}

// ----- 内容 -----
const META = `SELECT v.id,v.title,v.duration,v.width,v.height,v.collection,v.seq,v.lib_id,l.name lname,
  IFNULL(p.position,0) pos,IFNULL(p.finished,0) finished,p.updated_at pt,(f.video_id IS NOT NULL) fav
  FROM videos v JOIN libraries l ON l.id=v.lib_id
  LEFT JOIN progress p ON p.video_id=v.id AND p.user_id=@u
  LEFT JOIN favorites f ON f.video_id=v.id AND f.user_id=@u
  LEFT JOIN collection_meta cm ON cm.lib_id=v.lib_id AND cm.collection=v.collection`;
function shape(rows) {
  return rows.map(r => ({
    id: r.id, title: cleanName(r.title), duration: r.duration, width: r.width, height: r.height,
    cname: r.collection ? cleanName(r.collection.split('/').pop()) : r.lname,
    seq: r.seq, lib: r.lib_id, col: r.collection, pos: r.pos, finished: !!r.finished, fav: !!r.fav
  }));
}
app.get('/api/feed', auth, (req, res) => {
  const u = req.user, libs = allowedLibs(u), mode = req.query.mode || 'random';
  const P = { u: u.id };
  const base = `${META} WHERE v.lib_id IN (${inList(libs)})`;
  let rows, start = 0;
  if (mode === 'random') {
    if (!u.allow_random && u.role !== 'admin') return res.status(403).json({ error: '未开放随便刷' });
    const cat = String(req.query.cat || '');
    if (cat) rows = db.prepare(base + " AND IFNULL(NULLIF(cm.category,''), l.name)=@cat").all({ ...P, cat });
    else rows = db.prepare(base).all(P);
    rows = shuffle(rows).slice(0, 1500);
  } else if (mode === 'collection') {
    const lib = +req.query.lib, col = String(req.query.col || '');
    if (!libs.includes(lib)) return res.status(403).json({ error: '没有权限' });
    rows = db.prepare(base + ' AND v.lib_id=@lib AND v.collection=@col ORDER BY v.seq').all({ ...P, lib, col });
    let bi = -1, bt = 0;
    rows.forEach((r, i) => { if (r.pt && r.pt > bt) { bt = r.pt; bi = i; } });
    if (bi >= 0) start = rows[bi].finished ? (bi + 1 < rows.length ? bi + 1 : 0) : bi;
  } else if (mode === 'fav') {
    rows = db.prepare(base + ' AND f.video_id IS NOT NULL ORDER BY f.created_at DESC').all(P);
  } else if (mode === 'history') {
    rows = db.prepare(base + ' AND p.video_id IS NOT NULL ORDER BY p.updated_at DESC LIMIT 200').all(P);
  } else return res.status(400).json({ error: '参数错误' });
  res.json({ items: shape(rows), start });
});
app.get('/api/collections', auth, (req, res) => {
  const u = req.user, libs = allowedLibs(u);
  const rows = db.prepare(`
    SELECT v.lib_id,v.collection,l.name lname,COUNT(*) cnt,SUM(v.duration) dur,
      SUM(CASE WHEN p.finished=1 THEN 1 ELSE 0 END) done,MAX(p.updated_at) last,MAX(v.id) added,
      IFNULL(NULLIF(cm.category,''), l.name) cat,
      (SELECT id FROM videos w WHERE w.lib_id=v.lib_id AND w.collection=v.collection ORDER BY w.seq LIMIT 1) cover
    FROM videos v JOIN libraries l ON l.id=v.lib_id
    LEFT JOIN collection_meta cm ON cm.lib_id=v.lib_id AND cm.collection=v.collection
    LEFT JOIN progress p ON p.video_id=v.id AND p.user_id=?
    WHERE v.lib_id IN (${inList(libs)})
    GROUP BY v.lib_id,v.collection
    ORDER BY last DESC, l.name, v.collection`).all(u.id);
  res.json(rows.map(r => ({
    lib: r.lib_id, col: r.collection, name: r.collection ? cleanName(r.collection.split('/').pop()) : r.lname,
    count: r.cnt, duration: r.dur || 0, done: r.done, cover: r.cover,
    last: r.last || 0, added: r.added || 0, cat: r.cat
  })));
});
app.get('/api/thumb/:id', auth, (req, res) => {
  const v = videoFor(req.user, +req.params.id);
  if (!v) return res.status(404).end();
  const f = path.join(THUMB_DIR, v.id + '.jpg');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(f);
});
// 按需转 H.264(给老电视/投影用):结果缓存在 DATA_DIR/h264,同一视频并发请求共用一次转码
const h264Jobs = new Map();
function ensureH264(v, src) {
  const out = path.join(H264_DIR, v.id + '_' + Math.floor(v.mtime || 0) + '.mp4');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (h264Jobs.has(out)) return h264Jobs.get(out);
  const tmp = out + '.part.mp4';
  const job = new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale='if(gt(iw,ih),min(1280,iw),min(720,iw))':-2,format=yuv420p",
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', tmp],
    { timeout: 15 * 60 * 1000, maxBuffer: 1 << 20 }, err => {
      if (err) { fs.unlink(tmp, () => {}); return reject(err); }
      fs.rename(tmp, out, e => e ? reject(e) : resolve(out));
    });
  }).finally(() => h264Jobs.delete(out));
  h264Jobs.set(out, job);
  return job;
}
app.get('/api/stream/:id', auth, async (req, res) => {
  const v = videoFor(req.user, +req.params.id);
  if (!v) return res.status(404).end();
  const ls = lockState(req.user);
  if (ls.locked) return res.status(403).json(ls);
  let file = path.join(v.lib_path, v.rel_path);
  const codec = String(v.vcodec || '').toLowerCase();
  // tv=1:已知不是 H.264 的(HEVC 等)自动转;h264=1:客户端播放出错后强制转
  if (req.query.h264 === '1' || (req.query.tv === '1' && codec && codec !== 'h264')) {
    try { file = await ensureH264(v, file); } catch (e) { console.error('h264 转码失败', v.id, e.message); return res.status(500).end(); }
  }
  fs.stat(file, (err, st) => {
    if (err) return res.status(404).end();
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const size = st.size;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    let start = 0, end = size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - +m[2]); }
      else { start = m[1] === '' ? 0 : +m[1]; if (m[2] !== '') end = Math.min(+m[2], size - 1); }
      if (start > end || start >= size) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  });
});
app.post('/api/progress', auth, (req, res) => {
  const { video_id, position, finished } = req.body || {};
  const v = videoFor(req.user, +video_id);
  if (!v) return res.status(404).json({});
  db.prepare(`INSERT INTO progress(user_id,video_id,position,finished,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,video_id) DO UPDATE SET position=excluded.position,finished=excluded.finished,updated_at=excluded.updated_at`)
    .run(req.user.id, v.id, Math.max(0, +position || 0), finished ? 1 : 0, Date.now());
  res.json({ ok: true });
});
app.post('/api/heartbeat', auth, (req, res) => {
  const u = req.user;
  const s = Math.max(0, Math.min(30, Math.floor(+(req.body && req.body.seconds) || 0)));
  if (u.role !== 'admin' && s) {
    db.prepare('INSERT INTO usage(user_id,day,seconds) VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET seconds=seconds+excluded.seconds')
      .run(u.id, today(), s);
  }
  res.json({ lock: lockState(u), used: usageToday(u.id) });
});
app.post('/api/fav', auth, (req, res) => {
  const { video_id, on } = req.body || {};
  const v = videoFor(req.user, +video_id);
  if (!v) return res.status(404).json({});
  if (on) db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?,?)').run(req.user.id, v.id, Date.now());
  else db.prepare('DELETE FROM favorites WHERE user_id=? AND video_id=?').run(req.user.id, v.id);
  res.json({ ok: true });
});

// ----- 电视扫码登录(设备码) -----
const tvCodes = new Map();   // code -> { poll, uid, exp }
const tvRate = new Map();    // ip -> { n, t }
function tvClean() {
  const n = Date.now();
  for (const [k, v] of tvCodes) if (v.exp < n) tvCodes.delete(k);
  for (const [k, v] of tvRate) if (n - v.t > 300e3) tvRate.delete(k);
}
setInterval(tvClean, 60e3);
app.post('/api/tv/code', (req, res) => {
  const now = Date.now();
  const r = tvRate.get(req.ip) || { n: 0, t: now };
  if (now - r.t > 60e3) { r.n = 0; r.t = now; }
  tvRate.set(req.ip, r);
  if (++r.n > 20) return res.status(429).json({ error: '请求太频繁,稍后再试' });
  tvClean();
  if (tvCodes.size > 500) return res.status(429).json({ error: '请稍后再试' });
  let code;
  do { code = crypto.randomBytes(4).toString('hex').toUpperCase(); } while (tvCodes.has(code));
  const poll = crypto.randomBytes(16).toString('hex');
  tvCodes.set(code, { poll, uid: 0, exp: now + 10 * 60e3 });
  res.json({ code, poll, ttl: 600, base: PUBLIC_URL || `${req.protocol}://${req.get('host')}` });
});
app.get('/api/tv/poll', (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  const c = tvCodes.get(code);
  if (!c || c.poll !== String(req.query.poll || '') || c.exp < Date.now()) return res.json({ status: 'expired' });
  if (!c.uid) return res.json({ status: 'wait' });
  tvCodes.delete(code);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.uid);
  if (!u || !u.enabled) return res.json({ status: 'expired' });
  newSession(req, res, u.id, 180);
  res.json({ status: 'ok' });
});
app.post('/api/tv/approve', auth, (req, res) => {
  const c = tvCodes.get(String((req.body && req.body.code) || '').toUpperCase());
  if (!c || c.exp < Date.now()) return res.status(400).json({ error: '二维码已过期,请在电视上刷新后重新扫码' });
  c.uid = req.user.id;
  res.json({ ok: true, nickname: req.user.nickname || req.user.username });
});
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

// ----- 管理 -----
const adm = express.Router();
app.use('/api/admin', auth, adminOnly, adm);

adm.get('/overview', (req, res) => {
  const c = sql => db.prepare(sql).get().n;
  const users = db.prepare('SELECT id,username,nickname,role,daily_limit_min FROM users').all()
    .map(u => ({ ...u, used: usageToday(u.id) }));
  res.json({
    videos: c('SELECT COUNT(*) n FROM videos'),
    collections: c('SELECT COUNT(*) n FROM (SELECT 1 FROM videos GROUP BY lib_id,collection)'),
    users: c('SELECT COUNT(*) n FROM users'),
    hevc: c(`SELECT COUNT(*) n FROM videos WHERE vcodec IN ('hevc','h265')`),
    unprobed: c('SELECT COUNT(*) n FROM videos WHERE probed=0'),
    usage: users
  });
});
adm.get('/browse', A(async (req, res) => {
  const p = path.resolve(req.query.path || VIDEO_ROOT);
  if (!insideRoot(p)) return res.status(400).json({ error: '只能浏览 ' + VIDEO_ROOT + ' 下的目录' });
  let ents;
  try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch { return res.status(400).json({ error: '无法读取该目录' }); }
  const dirs = ents.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort(collator.compare);
  res.json({ path: p, parent: p === VIDEO_ROOT ? null : path.dirname(p), dirs });
}));

function libBody(req, res) {
  const name = String((req.body && req.body.name) || '').trim();
  const p = path.resolve(String((req.body && req.body.path) || ''));
  if (!name) { res.status(400).json({ error: '请填写名称' }); return null; }
  if (!insideRoot(p)) { res.status(400).json({ error: '路径必须在 ' + VIDEO_ROOT + ' 之下' }); return null; }
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) { res.status(400).json({ error: '该目录不存在' }); return null; }
  return { name, path: p, merge: req.body && req.body.merge ? 1 : 0 };
}
adm.get('/libs', (req, res) => {
  res.json(db.prepare(`SELECT l.*,(SELECT COUNT(*) FROM videos v WHERE v.lib_id=l.id) cnt,
    (SELECT COUNT(*) FROM videos v WHERE v.lib_id=l.id AND v.vcodec IN ('hevc','h265')) hevc FROM libraries l ORDER BY l.id`).all());
});
adm.post('/libs', (req, res) => {
  const b = libBody(req, res); if (!b) return;
  const id = db.prepare('INSERT INTO libraries(name,path,created_at,merge) VALUES(?,?,?,?)').run(b.name, b.path, Date.now(), b.merge).lastInsertRowid;
  enqueueScan({ id, ...b });
  res.json({ ok: true, id });
});
adm.put('/libs/:id', (req, res) => {
  const b = libBody(req, res); if (!b) return;
  const old = db.prepare('SELECT merge FROM libraries WHERE id=?').get(+req.params.id);
  db.prepare('UPDATE libraries SET name=?,path=?,merge=? WHERE id=?').run(b.name, b.path, b.merge, +req.params.id);
  const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(+req.params.id);
  if (old && lib && old.merge !== b.merge) enqueueScan(lib); // 合并方式改变,重新扫描归类
  res.json({ ok: true });
});
adm.delete('/libs/:id', (req, res) => {
  const id = +req.params.id;
  delVideos(db.prepare('SELECT id FROM videos WHERE lib_id=?').all(id).map(r => r.id));
  db.prepare('DELETE FROM user_libs WHERE lib_id=?').run(id);
  db.prepare('DELETE FROM collection_meta WHERE lib_id=?').run(id);
  db.prepare('DELETE FROM libraries WHERE id=?').run(id);
  res.json({ ok: true });
});
adm.post('/libs/:id/scan', (req, res) => {
  const lib = db.prepare('SELECT * FROM libraries WHERE id=?').get(+req.params.id);
  if (!lib) return res.status(404).json({ error: '视频库不存在' });
  res.json({ ok: true, task: enqueueScan(lib) });
});
adm.get('/libs/:id/collections', (req, res) => {
  res.json(db.prepare(`SELECT v.collection col,COUNT(*) cnt,IFNULL(cm.category,'') category FROM videos v
    LEFT JOIN collection_meta cm ON cm.lib_id=v.lib_id AND cm.collection=v.collection
    WHERE v.lib_id=? GROUP BY v.collection ORDER BY v.collection`).all(+req.params.id)
    .map(r => ({ col: r.col, name: r.col || '(根目录)', count: r.cnt, category: r.category })));
});
adm.get('/name-rules', (req, res) => res.json(getRules()));
adm.put('/name-rules', (req, res) => {
  const lines = a => (Array.isArray(a) ? a : []).map(x => String(x).trim()).filter(Boolean);
  const o = { cut: lines(req.body && req.body.cut), strip: lines(req.body && req.body.strip) };
  db.prepare("INSERT INTO settings VALUES('name_rules',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(o));
  rulesCache = o; res.json({ ok: true });
});
adm.get('/categories', (req, res) => {
  res.json(db.prepare("SELECT DISTINCT category FROM collection_meta WHERE category<>'' ORDER BY category").all().map(r => r.category));
});
adm.put('/collection-meta', (req, res) => {
  const lib = +(req.body && req.body.lib), col = String((req.body && req.body.col) || '');
  const cat = String((req.body && req.body.category) || '').trim().slice(0, 30);
  if (!lib) return res.status(400).json({ error: '参数错误' });
  if (!cat) db.prepare('DELETE FROM collection_meta WHERE lib_id=? AND collection=?').run(lib, col);
  else db.prepare('INSERT INTO collection_meta VALUES(?,?,?) ON CONFLICT(lib_id,collection) DO UPDATE SET category=excluded.category').run(lib, col, cat);
  res.json({ ok: true });
});
adm.get('/collection', (req, res) => {
  res.json(db.prepare('SELECT id,title,rel_path,seq,mtime,duration,vcodec FROM videos WHERE lib_id=? AND collection=? ORDER BY seq')
    .all(+req.query.lib, String(req.query.col || '')));
});
adm.post('/reorder', (req, res) => {
  const ids = (req.body && req.body.ids || []).map(Number);
  if (!ids.length) return res.status(400).json({ error: '空列表' });
  const rows = db.prepare(`SELECT DISTINCT lib_id,collection FROM videos WHERE id IN (${inList(ids)})`).all();
  if (rows.length !== 1) return res.status(400).json({ error: '只能整理同一个合集' });
  const up = db.prepare('UPDATE videos SET seq=?,manual=1 WHERE id=?');
  db.transaction(() => ids.forEach((id, i) => up.run(i + 1, id)))();
  res.json({ ok: true });
});
adm.post('/reorder-reset', (req, res) => {
  renumber(+req.body.lib, String(req.body.col || ''), true);
  res.json({ ok: true });
});
adm.put('/videos/:id', (req, res) => {
  const title = String((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  db.prepare('UPDATE videos SET title=? WHERE id=?').run(title, +req.params.id);
  res.json({ ok: true });
});

function userBody(req, res, creating) {
  const b = req.body || {};
  const o = {
    username: String(b.username || '').trim(),
    nickname: String(b.nickname || '').trim(),
    role: b.role === 'admin' ? 'admin' : 'user',
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
    daily_limit_min: intOr(b.daily_limit_min, 0, 0, 1440),
    break_every_min: intOr(b.break_every_min, 0, 0, 240),
    quiet_start: String(b.quiet_start || ''),
    quiet_end: String(b.quiet_end || ''),
    allow_random: b.allow_random === false || b.allow_random === 0 ? 0 : 1,
    libs: (Array.isArray(b.libs) ? b.libs : []).map(Number).filter(Boolean),
    password: String(b.password || '')
  };
  if (creating && !/^[A-Za-z0-9_\-.]{2,32}$/.test(o.username)) { res.status(400).json({ error: '账号只能用字母数字下划线,2-32 位' }); return null; }
  if ((creating || o.password) && o.password.length < 4) { res.status(400).json({ error: '密码至少 4 位' }); return null; }
  if (!hmOk(o.quiet_start) || !hmOk(o.quiet_end)) { res.status(400).json({ error: '时间格式应为 HH:MM' }); return null; }
  return o;
}
function setUserLibs(uid, libs) {
  db.prepare('DELETE FROM user_libs WHERE user_id=?').run(uid);
  const ins = db.prepare('INSERT OR IGNORE INTO user_libs VALUES(?,?)');
  libs.forEach(l => ins.run(uid, l));
}
adm.get('/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json(rows.map(u => ({
    id: u.id, username: u.username, nickname: u.nickname, role: u.role, enabled: !!u.enabled,
    daily_limit_min: u.daily_limit_min, break_every_min: u.break_every_min,
    quiet_start: u.quiet_start, quiet_end: u.quiet_end, allow_random: !!u.allow_random,
    used: usageToday(u.id),
    libs: db.prepare('SELECT lib_id FROM user_libs WHERE user_id=?').all(u.id).map(r => r.lib_id)
  })));
});
adm.post('/users', (req, res) => {
  const o = userBody(req, res, true); if (!o) return;
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(o.username)) return res.status(400).json({ error: '账号已存在' });
  const id = db.prepare(`INSERT INTO users(username,nickname,pass_hash,role,enabled,daily_limit_min,break_every_min,quiet_start,quiet_end,allow_random,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(o.username, o.nickname || o.username, hashPw(o.password), o.role, o.enabled,
    o.daily_limit_min, o.break_every_min, o.quiet_start, o.quiet_end, o.allow_random, Date.now()).lastInsertRowid;
  setUserLibs(id, o.libs);
  res.json({ ok: true, id });
});
adm.put('/users/:id', (req, res) => {
  const id = +req.params.id;
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '用户不存在' });
  const o = userBody(req, res, false); if (!o) return;
  if (id === req.user.id && (o.role !== 'admin' || !o.enabled)) return res.status(400).json({ error: '不能停用或降级自己' });
  db.prepare(`UPDATE users SET nickname=?,role=?,enabled=?,daily_limit_min=?,break_every_min=?,quiet_start=?,quiet_end=?,allow_random=? WHERE id=?`)
    .run(o.nickname || cur.username, o.role, o.enabled, o.daily_limit_min, o.break_every_min, o.quiet_start, o.quiet_end, o.allow_random, id);
  if (o.password) db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPw(o.password), id);
  if (!o.enabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  setUserLibs(id, o.libs);
  res.json({ ok: true });
});
adm.delete('/users/:id', (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  for (const t of ['sessions', 'user_libs', 'progress', 'favorites', 'usage']) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});
adm.post('/users/:id/reset-usage', (req, res) => {
  db.prepare('DELETE FROM usage WHERE user_id=? AND day=?').run(+req.params.id, today());
  res.json({ ok: true });
});
adm.get('/tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 30').all());
});
adm.delete('/tasks', (req, res) => {
  db.prepare(`DELETE FROM tasks WHERE status IN ('done','failed')`).run();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器出错了' });
});
app.listen(PORT, () => console.log(`shortvid 已启动: http://0.0.0.0:${PORT}  视频根目录 ${VIDEO_ROOT}`));
