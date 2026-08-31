'use strict';

/**
 * 坡南寻宝记 v5.34.0 微信小游戏独立后端
 * Node.js 18+，无第三方依赖。
 *
 * 环境变量：
 *   WECHAT_APPID          微信小游戏 AppID
 *   WECHAT_APPSECRET      微信小游戏 AppSecret
 *   AUTH_TOKEN_SECRET     至少 24 位随机字符串，建议 48 位以上
 *   PASSWORD              独立管理后台密码
 *   USER_DB_FILE          /data/auth/users.json
 *   MINIGAME_DATA_DIR     /data（可选；默认由 USER_DB_FILE 推导）
 *   PORT                  Zeabur 自动注入；本机可设 3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '5.34.2';
const PORT = Number(process.env.PORT || 3000);
const APPID = String(process.env.WECHAT_APPID || '').trim();
const APPSECRET = String(process.env.WECHAT_APPSECRET || '').trim();
const TOKEN_SECRET = String(process.env.AUTH_TOKEN_SECRET || '').trim();
const ADMIN_PASSWORD = String(process.env.PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const DB_FILE = process.env.USER_DB_FILE || path.join(__dirname, 'data', 'auth', 'users.json');
const inferredDataDir = path.dirname(path.dirname(DB_FILE));
const DATA_DIR = process.env.MINIGAME_DATA_DIR || inferredDataDir || path.join(__dirname, 'data');
const SAVE_DIR = path.join(DATA_DIR, 'saves');
const CONFIG_FILE = path.join(DATA_DIR, 'config', 'runtime.json');
const VISIT_FILE = path.join(DATA_DIR, 'stats', 'visits.json');
const STAGE_FILE = path.join(DATA_DIR, 'stats', 'stage-records.json');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard', 'entries.json');
const ADMIN_HTML = path.join(__dirname, 'public', 'admin', 'index.html');

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(data);
}

function text(res, status, content, contentType) {
  const data = Buffer.from(content || '');
  res.writeHead(status, {
    'content-type': contentType || 'text/plain; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(data);
}

function readBody(req, limit = 320 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function atomicWrite(file, value) {
  ensureDir(file);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback)); }
}
function ensureJson(file, fallback) {
  if (!fs.existsSync(file)) atomicWrite(file, typeof fallback === 'function' ? fallback() : fallback);
}

function defaultUsersDb() { return { usersByOpenid: {} }; }
function readUsersDb() {
  ensureJson(DB_FILE, defaultUsersDb);
  const db = readJson(DB_FILE, defaultUsersDb);
  if (!db.usersByOpenid || typeof db.usersByOpenid !== 'object') db.usersByOpenid = {};
  return db;
}
function writeUsersDb(db) { atomicWrite(DB_FILE, db); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('wechat response parse failed')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('wechat request timeout')));
  });
}

async function code2Session(code) {
  const u = new URL('https://api.weixin.qq.com/sns/jscode2session');
  u.searchParams.set('appid', APPID);
  u.searchParams.set('secret', APPSECRET);
  u.searchParams.set('js_code', code);
  u.searchParams.set('grant_type', 'authorization_code');
  const result = await getJson(u.toString());
  if (!result || result.errcode || !result.openid) {
    const msg = result && (result.errmsg || result.errcode) ? String(result.errmsg || result.errcode) : 'jscode2session failed';
    throw new Error(msg);
  }
  return result;
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromBase64url(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function signPayload(payload) {
  return base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest());
}
function issueToken(userId, ttlMs = 30 * 24 * 3600 * 1000, role = 'user') {
  const expiresAt = Date.now() + ttlMs;
  const payload = base64url(JSON.stringify({ sub: userId, role, exp: expiresAt }));
  return { token: payload + '.' + signPayload(payload), expiresAt };
}
function verifyToken(token, role) {
  if (!TOKEN_SECRET || TOKEN_SECRET.length < 24) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(signPayload(parts[0]));
  const got = Buffer.from(parts[1]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const p = JSON.parse(fromBase64url(parts[0]).toString('utf8'));
    if (!p || !p.sub || Number(p.exp || 0) <= Date.now()) return null;
    if (role && String(p.role || 'user') !== role) return null;
    return p;
  } catch (e) { return null; }
}
function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}
function requireUser(req, res) {
  const p = verifyToken(bearer(req), 'user');
  if (!p) { json(res, 401, { error: 'login required' }); return null; }
  const userId = String(p.sub);
  // v5.34.2：签名正确还不够；user_id 必须确实存在于当前 Volume 的玩家库。
  // 这样切换 Service / Volume 后，旧服务留下的孤儿 token 会被拒绝并触发客户端重新 wx.login。
  const db = readUsersDb();
  if (!findUserById(db, userId)) { json(res, 401, { error: 'login required' }); return null; }
  return userId;
}
function requireAdmin(req, res) {
  const p = verifyToken(bearer(req), 'admin');
  if (!p) { json(res, 401, { error: 'admin login required' }); return null; }
  return p;
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function newUserId() { return 'pn_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex'); }
function findUserById(db, userId) {
  for (const [openid, user] of Object.entries(db.usersByOpenid || {})) {
    if (user && String(user.userId) === String(userId)) return { openid, user };
  }
  return null;
}

async function handleLogin(req, res) {
  if (!APPID || !APPSECRET || TOKEN_SECRET.length < 24) {
    json(res, 503, { error: 'wechat auth server is not configured' }); return;
  }
  const body = await readBody(req, 24 * 1024);
  const code = String(body.code || '').trim();
  if (!code) { json(res, 400, { error: 'code is required' }); return; }
  const wxSession = await code2Session(code);
  const openid = String(wxSession.openid);
  const db = readUsersDb();
  let user = db.usersByOpenid[openid];
  const isNewUser = !user;
  if (!user) {
    user = {
      userId: newUserId(), createdAt: Date.now(), lastLoginAt: Date.now(), unionid: wxSession.unionid || '',
      lastDeviceId: String(body.deviceId || '').slice(0, 80), appVersion: String(body.appVersion || '').slice(0, 80)
    };
    db.usersByOpenid[openid] = user;
  } else {
    user.lastLoginAt = Date.now();
    user.lastDeviceId = String(body.deviceId || '').slice(0, 80);
    user.appVersion = String(body.appVersion || '').slice(0, 80);
    if (wxSession.unionid) user.unionid = wxSession.unionid;
  }
  writeUsersDb(db);
  const auth = issueToken(user.userId);
  json(res, 200, { ok: true, userId: user.userId, token: auth.token, expiresAt: auth.expiresAt, isNewUser });
}

function safeUserId(userId) {
  const s = String(userId || '');
  if (!/^pn_[a-z0-9_\-]{6,80}$/i.test(s)) throw new Error('invalid user id');
  return s;
}
function saveFileFor(userId) { return path.join(SAVE_DIR, safeUserId(userId) + '.json'); }
function readSaveRecord(userId) {
  const file = saveFileFor(userId);
  if (!fs.existsSync(file)) return null;
  const rec = readJson(file, null);
  return rec && typeof rec === 'object' ? rec : null;
}
function writeSaveRecord(userId, save, appVersion) {
  const cleanSave = JSON.parse(JSON.stringify(save || {}));
  cleanSave.ownerUserId = userId;
  const serialized = JSON.stringify(cleanSave);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('save data too large');
  const rec = {
    userId,
    save: cleanSave,
    clientUpdatedAt: Math.max(0, Number(cleanSave.lastUpdatedAt) || 0),
    serverUpdatedAt: Date.now(),
    appVersion: String(appVersion || '').slice(0, 80)
  };
  atomicWrite(saveFileFor(userId), rec);
  const db = readUsersDb();
  const found = findUserById(db, userId);
  if (found) {
    found.user.lastSaveAt = rec.serverUpdatedAt;
    found.user.lastSaveVersion = rec.appVersion;
    writeUsersDb(db);
  }
  return rec;
}

async function handleSaveSync(req, res) {
  const userId = requireUser(req, res); if (!userId) return;
  const body = await readBody(req, 300 * 1024);
  const local = body.save && typeof body.save === 'object' ? JSON.parse(JSON.stringify(body.save)) : {};
  const localOwner = String(local.ownerUserId || '').trim();
  const remote = readSaveRecord(userId);
  if (localOwner && localOwner !== userId) {
    if (remote) { json(res, 200, { ok: true, action: 'remote', save: remote.save, serverUpdatedAt: remote.serverUpdatedAt }); return; }
    json(res, 200, { ok: true, action: 'foreign-local', save: null }); return;
  }
  local.ownerUserId = userId;
  const localTs = Math.max(0, Number(local.lastUpdatedAt) || 0);
  if (!remote) {
    const rec = writeSaveRecord(userId, local, body.appVersion);
    json(res, 200, { ok: true, action: 'uploaded', save: rec.save, serverUpdatedAt: rec.serverUpdatedAt }); return;
  }
  const remoteTs = Math.max(0, Number(remote.clientUpdatedAt) || Number(remote.save && remote.save.lastUpdatedAt) || 0);
  if (remoteTs > localTs) {
    json(res, 200, { ok: true, action: 'remote', save: remote.save, serverUpdatedAt: remote.serverUpdatedAt }); return;
  }
  if (localTs > remoteTs) {
    const rec = writeSaveRecord(userId, local, body.appVersion);
    json(res, 200, { ok: true, action: 'uploaded', save: rec.save, serverUpdatedAt: rec.serverUpdatedAt }); return;
  }
  json(res, 200, { ok: true, action: 'same', save: remote.save, serverUpdatedAt: remote.serverUpdatedAt });
}

function defaultRuntimeConfig() {
  return { maintenanceMode: false, bgmVolume: 55, sfxVolume: 100, bgmUrl: '' };
}
function readRuntimeConfig() {
  ensureJson(CONFIG_FILE, defaultRuntimeConfig);
  return Object.assign(defaultRuntimeConfig(), readJson(CONFIG_FILE, defaultRuntimeConfig));
}
function writeRuntimeConfig(input) {
  const current = readRuntimeConfig();
  if (input.maintenanceMode != null) current.maintenanceMode = !!input.maintenanceMode;
  if (input.bgmVolume != null) current.bgmVolume = Math.max(0, Math.min(100, Math.round(Number(input.bgmVolume) || 0)));
  if (input.sfxVolume != null) current.sfxVolume = Math.max(0, Math.min(100, Math.round(Number(input.sfxVolume) || 0)));
  if (input.bgmUrl != null) current.bgmUrl = String(input.bgmUrl || '').trim().slice(0, 500);
  atomicWrite(CONFIG_FILE, current);
  return current;
}

function incrementVisit() {
  ensureJson(VISIT_FILE, { count: 1000 });
  const d = readJson(VISIT_FILE, { count: 1000 });
  d.count = Math.max(1000, Number(d.count) || 1000) + 1;
  d.updatedAt = Date.now(); atomicWrite(VISIT_FILE, d); return d.count;
}
function readStageRecords() { ensureJson(STAGE_FILE, { stages: {} }); const d = readJson(STAGE_FILE, { stages: {} }); if (!d.stages) d.stages = {}; return d; }
function updateStageRecord(stageId, score) {
  const d = readStageRecords(), key = String(stageId), prev = Math.max(0, Number(d.stages[key] || 0));
  if (score > prev) { d.stages[key] = score; d.updatedAt = Date.now(); atomicWrite(STAGE_FILE, d); }
  return Math.max(prev, score);
}

function readLeaderboard() { ensureJson(LEADERBOARD_FILE, { entries: [] }); const d = readJson(LEADERBOARD_FILE, { entries: [] }); if (!Array.isArray(d.entries)) d.entries = []; return d; }
function durationText(ms) {
  const sec = Math.max(0, Math.floor(Number(ms) || 0) / 1000), m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
function sortedEntries(entries) {
  return entries.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.durationMs) || 9e15) - (Number(b.durationMs) || 9e15) || (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
}
function submitLeaderboardEntry(entry) {
  const d = readLeaderboard(), id = String(entry.playerId || '').trim();
  let old = d.entries.find((x) => String(x.playerId) === id);
  const better = !old || Number(entry.score) > Number(old.score) || (Number(entry.score) === Number(old.score) && Number(entry.durationMs) < Number(old.durationMs || 9e15));
  if (better) {
    if (old) Object.assign(old, entry, { updatedAt: Date.now() });
    else d.entries.push(Object.assign({}, entry, { createdAt: Date.now(), updatedAt: Date.now() }));
  } else if (old && (entry.displayName || entry.avatarUrl)) {
    if (entry.displayName) old.displayName = entry.displayName;
    if (entry.avatarUrl) old.avatarUrl = entry.avatarUrl;
    old.updatedAt = Date.now();
  }
  const sorted = sortedEntries(d.entries), idx = sorted.findIndex((x) => String(x.playerId) === id), rank = idx >= 0 ? idx + 1 : 0;
  d.entries = sorted.slice(0, 200);
  atomicWrite(LEADERBOARD_FILE, d);
  const finalIdx = d.entries.findIndex((x) => String(x.playerId) === id);
  return { rank: finalIdx >= 0 ? finalIdx + 1 : rank, qualified: finalIdx >= 0, entry: finalIdx >= 0 ? d.entries[finalIdx] : null };
}

function summarizeSave(save) {
  const s = save || {};
  const best = s.bestScores && typeof s.bestScores === 'object' ? s.bestScores : {};
  let totalScore = Object.values(best).reduce((sum, v) => sum + Math.max(0, Number(v) || 0), 0);
  if (!best['1'] && !best[1]) totalScore += Math.max(0, Number(s.stage1Best) || 0);
  const treasures = s.treasures && typeof s.treasures === 'object' ? Object.values(s.treasures).filter(Boolean).length : 0;
  return {
    currentStage: Math.max(1, Math.min(19, Number(s.unlocked) || 1)),
    gameCompleted: !!s.gameCompleted,
    jade: Math.max(0, Number(s.jade) || 0),
    treasureCount: treasures + (s.treasure ? 1 : 0),
    totalScore,
    lastUpdatedAt: Math.max(0, Number(s.lastUpdatedAt) || 0)
  };
}

async function handleAdminLogin(req, res) {
  if (!ADMIN_PASSWORD) { json(res, 503, { error: 'admin password is not configured' }); return; }
  const body = await readBody(req, 16 * 1024);
  if (!safeEqual(body.password, ADMIN_PASSWORD)) { json(res, 401, { error: '密码错误' }); return; }
  const auth = issueToken('admin', 8 * 3600 * 1000, 'admin');
  json(res, 200, { ok: true, token: auth.token, expiresAt: auth.expiresAt });
}
function adminPlayers(query) {
  const db = readUsersDb();
  const all = Object.values(db.usersByOpenid || {}).map((u) => {
    const rec = u && u.userId ? readSaveRecord(u.userId) : null;
    return {
      userId: u.userId, createdAt: u.createdAt || 0, lastLoginAt: u.lastLoginAt || 0,
      appVersion: u.appVersion || '', lastDeviceId: u.lastDeviceId || '', lastSaveAt: u.lastSaveAt || (rec && rec.serverUpdatedAt) || 0,
      progress: summarizeSave(rec && rec.save)
    };
  });
  const q = String(query.q || '').trim().toLowerCase();
  const filtered = q ? all.filter((x) => String(x.userId).toLowerCase().includes(q) || String(x.appVersion).toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => Number(b.lastLoginAt) - Number(a.lastLoginAt));
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.max(10, Math.min(100, Number(query.pageSize) || 30));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  return { page, pages, total: filtered.length, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
}

function serveAdmin(res) {
  try { text(res, 200, fs.readFileSync(ADMIN_HTML, 'utf8'), 'text/html; charset=utf-8'); }
  catch (e) { text(res, 500, 'admin page missing'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (req.method === 'GET' && p === '/health') {
      json(res, 200, { ok: true, service: 'ponan-wechat-minigame', version: VERSION, authConfigured: !!(APPID && APPSECRET && TOKEN_SECRET.length >= 24), adminConfigured: !!ADMIN_PASSWORD }); return;
    }
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) { serveAdmin(res); return; }
    if (req.method === 'POST' && p === '/api/auth/wechat-login') { await handleLogin(req, res); return; }
    if (req.method === 'GET' && p === '/api/auth/me') {
      const userId = requireUser(req, res); if (!userId) return;
      const db = readUsersDb(), found = findUserById(db, userId);
      json(res, 200, { ok: true, userId, createdAt: found && found.user ? (found.user.createdAt || 0) : 0, lastLoginAt: found && found.user ? (found.user.lastLoginAt || 0) : 0 }); return;
    }
    if (req.method === 'POST' && p === '/api/save/sync') { await handleSaveSync(req, res); return; }
    if (req.method === 'GET' && p === '/api/save') {
      const userId = requireUser(req, res); if (!userId) return;
      const rec = readSaveRecord(userId); json(res, 200, { ok: true, save: rec ? rec.save : null, serverUpdatedAt: rec ? rec.serverUpdatedAt : 0 }); return;
    }

    if (req.method === 'GET' && p === '/api/config') { json(res, 200, readRuntimeConfig()); return; }
    if (req.method === 'POST' && p === '/api/visit-counter') { json(res, 200, { count: incrementVisit() }); return; }
    if (p === '/api/stage-records' && req.method === 'GET') {
      const stage = Math.max(1, Math.min(19, Number(u.searchParams.get('stage')) || 1));
      const d = readStageRecords(); json(res, 200, { stageId: stage, score: Math.max(0, Number(d.stages[String(stage)] || 0)) }); return;
    }
    if (p === '/api/stage-records' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024), stage = Math.max(1, Math.min(19, Number(body.stageId) || 1)), score = Math.max(0, Math.floor(Number(body.score) || 0));
      json(res, 200, { ok: true, stageId: stage, score: updateStageRecord(stage, score) }); return;
    }

    if (p === '/api/leaderboard' && req.method === 'GET') {
      const d = readLeaderboard(), sorted = sortedEntries(d.entries).slice(0, 200), page = Math.max(1, Number(u.searchParams.get('page')) || 1), pageSize = Math.max(5, Math.min(20, Number(u.searchParams.get('pageSize')) || 10));
      const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
      const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((x, i) => ({ rank: (page - 1) * pageSize + i + 1, username: x.displayName || x.username || '微信玩家', displayName: x.displayName || x.username || '微信玩家', avatarUrl: x.avatarUrl || '', score: x.score || 0, durationMs: x.durationMs || 0, durationText: durationText(x.durationMs) }));
      json(res, 200, { page, pages, total: sorted.length, items }); return;
    }
    if (p === '/api/leaderboard/wechat' && req.method === 'POST') {
      const userId = requireUser(req, res); if (!userId) return;
      const body = await readBody(req, 32 * 1024);
      const r = submitLeaderboardEntry({ playerId: userId, displayName: String(body.nickname || '微信玩家').trim().slice(0, 30) || '微信玩家', avatarUrl: String(body.avatarUrl || '').trim().slice(0, 800), score: Math.max(0, Math.floor(Number(body.score) || 0)), durationMs: Math.max(0, Math.floor(Number(body.durationMs) || 0)), source: 'wechat' });
      json(res, 200, { ok: true, rank: r.rank, qualified: r.qualified }); return;
    }
    if (p === '/api/leaderboard' && req.method === 'POST') {
      const body = await readBody(req, 24 * 1024), username = String(body.username || '玩家').trim().slice(0, 30), password = String(body.password || '');
      const legacyId = 'legacy_' + crypto.createHash('sha256').update(username + '\n' + password).digest('hex').slice(0, 20);
      const r = submitLeaderboardEntry({ playerId: legacyId, username, displayName: username, avatarUrl: '', score: Math.max(0, Math.floor(Number(body.score) || 0)), durationMs: Math.max(0, Math.floor(Number(body.durationMs) || 0)), source: 'legacy' });
      json(res, 200, { ok: true, rank: r.rank, qualified: r.qualified }); return;
    }

    if (p === '/api/admin/login' && req.method === 'POST') { await handleAdminLogin(req, res); return; }
    if (p === '/api/admin/summary' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const db = readUsersDb(), users = Object.values(db.usersByOpenid || {}), now = Date.now();
      let saves = 0, completed = 0;
      for (const user of users) { const rec = user && user.userId ? readSaveRecord(user.userId) : null; if (rec) { saves++; if (rec.save && rec.save.gameCompleted) completed++; } }
      const lb = readLeaderboard();
      json(res, 200, { users: users.length, saves, completed, active7d: users.filter((x) => now - Number(x.lastLoginAt || 0) <= 7 * 86400000).length, leaderboard: Math.min(200, lb.entries.length), version: VERSION }); return;
    }
    if (p === '/api/admin/players' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, adminPlayers(Object.fromEntries(u.searchParams.entries()))); return; }
    if (p === '/api/admin/player' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const userId = String(u.searchParams.get('userId') || '');
      const db = readUsersDb(), found = findUserById(db, userId);
      if (!found) { json(res, 404, { error: 'player not found' }); return; }
      const rec = readSaveRecord(userId);
      json(res, 200, { user: { userId: found.user.userId, createdAt: found.user.createdAt || 0, lastLoginAt: found.user.lastLoginAt || 0, appVersion: found.user.appVersion || '', lastDeviceId: found.user.lastDeviceId || '', lastSaveAt: found.user.lastSaveAt || 0 }, progress: summarizeSave(rec && rec.save), save: rec ? rec.save : null, serverUpdatedAt: rec ? rec.serverUpdatedAt : 0 }); return;
    }
    if (p === '/api/admin/config' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, readRuntimeConfig()); return; }
    if (p === '/api/admin/config' && (req.method === 'PUT' || req.method === 'POST')) { if (!requireAdmin(req, res)) return; json(res, 200, writeRuntimeConfig(await readBody(req, 24 * 1024))); return; }
    if (p === '/api/admin/leaderboard' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const sorted = sortedEntries(readLeaderboard().entries).slice(0, 200).map((x, i) => Object.assign({ rank: i + 1, durationText: durationText(x.durationMs) }, x));
      json(res, 200, { items: sorted, total: sorted.length }); return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    const status = /too large/i.test(String(err && err.message)) ? 413 : 500;
    json(res, status, { error: err && err.message ? err.message : 'internal error' });
  }
});

for (const dir of [path.dirname(DB_FILE), SAVE_DIR, path.dirname(CONFIG_FILE), path.dirname(VISIT_FILE), path.dirname(LEADERBOARD_FILE)]) fs.mkdirSync(dir, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ponan-wechat-minigame v${VERSION} listening on`, PORT);
});
