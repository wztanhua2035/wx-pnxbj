'use strict';

/**
 * 坡南寻宝记 v5.54.0 微信小游戏独立后端
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

const VERSION = '5.54.0';
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
const LOTTERY_ADMIN_HTML = path.join(__dirname, 'public', 'admin', 'lottery.html');
const lottery = require('./lottery')(DATA_DIR);
const redeemers = require('./redeemers')(DATA_DIR);
const bgmStore = require('./bgm')(DATA_DIR);
const staffAttempts=new Map();
function requireRedeemer(req,res){
  const token=verifyToken(bearer(req),'redeemer'),actor=token&&redeemers.session(token.sub);
  if(!actor){json(res,401,{error:'请重新登录核销员账号'});return null;}return actor;
}

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

function readRawBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; const err = new Error('音乐文件不能超过15MB'); err.status = 413; reject(err); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
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

function defaultDisplayName(userId) {
  const s = String(userId || '').replace(/[^a-z0-9]/gi, '');
  return '寻宝客' + (s.slice(-4) || '0000');
}
function cleanDisplayName(value, userId) {
  const raw = String(value || '').replace(/[\r\n\t]/g, ' ').trim().replace(/\s{2,}/g, ' ');
  return (raw || defaultDisplayName(userId)).slice(0, 20);
}
function cleanAvatarUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!/^https:\/\//i.test(s)) return '';
  return s.slice(0, 800);
}
function publicProfile(user) {
  const u = user || {};
  return {
    userId: String(u.userId || ''),
    displayName: cleanDisplayName(u.displayName, u.userId),
    avatarUrl: cleanAvatarUrl(u.avatarUrl),
    profileUpdatedAt: Math.max(0, Number(u.profileUpdatedAt) || 0)
  };
}
function updateUserProfile(userId, input) {
  const db = readUsersDb(), found = findUserById(db, userId);
  if (!found) return null;
  const body = input || {};
  const rawName = String(body.displayName != null ? body.displayName : (body.nickname != null ? body.nickname : '')).trim();
  const genericName = !rawName || rawName === '微信用户' || rawName === '微信玩家';
  if (!genericName) found.user.displayName = cleanDisplayName(rawName, userId);
  else if (!found.user.displayName) found.user.displayName = defaultDisplayName(userId);
  if (body.avatarUrl != null) {
    const avatar = cleanAvatarUrl(body.avatarUrl);
    if (avatar) found.user.avatarUrl = avatar;
  }
  found.user.profileUpdatedAt = Date.now();
  writeUsersDb(db);
  return publicProfile(found.user);
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
    const createdUserId = newUserId();
    user = {
      userId: createdUserId, createdAt: Date.now(), lastLoginAt: Date.now(), unionid: wxSession.unionid || '',
      displayName: defaultDisplayName(createdUserId), avatarUrl: '', profileUpdatedAt: 0,
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
  json(res, 200, { ok: true, userId: user.userId, token: auth.token, expiresAt: auth.expiresAt, isNewUser, profile: publicProfile(user) });
}

function safeUserId(userId) {
  const s = String(userId || '');
  if (!/^pn_[a-z0-9_\-]{6,80}$/i.test(s)) throw new Error('invalid user id');
  return s;
}
function saveFileFor(userId) { return path.join(SAVE_DIR, safeUserId(userId) + '.json'); }
const migrateRoute=require('./routeMigration');
function readSaveRecord(userId) {
  const file = saveFileFor(userId);
  if (!fs.existsSync(file)) return null;
  const rec = readJson(file, null);
  if(rec&&rec.save)rec.save=migrateRoute(rec.save);
  return rec && typeof rec === 'object' ? rec : null;
}
function writeSaveRecord(userId, save, appVersion) {
  const existing=readJson(saveFileFor(userId),null);
  if(existing&&Number(existing.save&&existing.save.routeVersion)>=20&&(Number(save&&save.routeVersion)||0)<20)throw new Error('请升级至v5.61.0后同步存档');
  const cleanSave = migrateRoute(JSON.parse(JSON.stringify(save || {})));
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
  return { maintenanceMode: false, bgmVolume: 55, sfxVolume: 100, bgmSource: 'local', bgmTrackId: '', bgmUrl: '', debugModeEnabled: true, debugScoresEnabled: false, debugEntryCode: '9999' };
}
function readRuntimeConfig() {
  ensureJson(CONFIG_FILE, defaultRuntimeConfig);
  const raw = readJson(CONFIG_FILE, defaultRuntimeConfig);
  const value = Object.assign(defaultRuntimeConfig(), raw);
  if (!Object.prototype.hasOwnProperty.call(raw, 'bgmSource')) value.bgmSource = value.bgmUrl ? 'url' : 'local';
  return value;
}
function writeRuntimeConfig(input) {
  const current = readRuntimeConfig();
  if (input.maintenanceMode != null) current.maintenanceMode = !!input.maintenanceMode;
  if (input.bgmVolume != null) current.bgmVolume = Math.max(0, Math.min(100, Math.round(Number(input.bgmVolume) || 0)));
  if (input.sfxVolume != null) current.sfxVolume = Math.max(0, Math.min(100, Math.round(Number(input.sfxVolume) || 0)));
  if (input.bgmSource != null) {
    const source = String(input.bgmSource || 'local');
    if (!['local', 'uploaded', 'url'].includes(source)) { const err = new Error('背景音乐来源无效'); err.status = 400; throw err; }
    current.bgmSource = source;
  }
  if (input.bgmTrackId != null) current.bgmTrackId = String(input.bgmTrackId || '').trim().slice(0, 40);
  if (input.bgmUrl != null) current.bgmUrl = String(input.bgmUrl || '').trim().slice(0, 500);
  if (current.bgmSource === 'uploaded' && !bgmStore.find(current.bgmTrackId)) { const err = new Error('请选择一首已上传的背景音乐'); err.status = 400; throw err; }
  if (current.bgmSource === 'url' && !/^https:\/\//i.test(current.bgmUrl)) { const err = new Error('远程音乐地址必须以 https:// 开头'); err.status = 400; throw err; }
  if (input.debugModeEnabled != null) current.debugModeEnabled = !!input.debugModeEnabled;
  if (input.debugScoresEnabled != null) current.debugScoresEnabled = !!input.debugScoresEnabled;
  if (input.debugEntryCode != null) { const code = String(input.debugEntryCode || '').trim(); if (/^\d{4}$/.test(code)) current.debugEntryCode = code; }
  atomicWrite(CONFIG_FILE, current);
  return current;
}
function publicRuntimeConfig() {
  const c = readRuntimeConfig();
  const out = Object.assign({}, c);
  delete out.debugEntryCode;
  if (c.bgmSource === 'uploaded') { const track = bgmStore.find(c.bgmTrackId); out.bgmUrl = track ? track.url : ''; }
  else if (c.bgmSource !== 'url') out.bgmUrl = '';
  delete out.bgmTrackId;
  out.lotteryEnabled = !!lottery.publicConfig().enabled;
  return out;
}

function serveBgm(req, res, id) {
  const item = bgmStore.find(id);
  if (!item) { json(res, 404, { error: '背景音乐不存在' }); return; }
  const stat = fs.statSync(item.path), total = stat.size;
  let start = 0, end = total - 1, status = 200;
  const range = String(req.headers.range || '');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return; }
    start = match[1] ? Number(match[1]) : 0; end = match[2] ? Number(match[2]) : end;
    if (start > end || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return; }
    end = Math.min(end, total - 1); status = 206;
  }
  const headers = { 'content-type': item.mime, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(item.path, { start, end }).pipe(res);
}

const DEBUG_ATTEMPTS = new Map();
function debugClientKey(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0,80); }
function allowDebugAttempt(req) {
  const key = debugClientKey(req), now = Date.now(), rec = DEBUG_ATTEMPTS.get(key) || { n:0, at:now };
  if (now - rec.at > 10*60*1000) { rec.n=0; rec.at=now; }
  rec.n++; DEBUG_ATTEMPTS.set(key, rec);
  return rec.n <= 12;
}

function incrementVisit() {
  ensureJson(VISIT_FILE, { count: 1000 });
  const d = readJson(VISIT_FILE, { count: 1000 });
  d.count = Math.max(1000, Number(d.count) || 1000) + 1;
  d.updatedAt = Date.now(); atomicWrite(VISIT_FILE, d); return d.count;
}
function readStageRecords() { ensureJson(STAGE_FILE, { stages: {},routeVersion:20 }); const d = readJson(STAGE_FILE, { stages: {} }); if (!d.stages) d.stages = {}; if((Number(d.routeVersion)||0)<20){if(Object.prototype.hasOwnProperty.call(d.stages,'19')){d.stages[20]=d.stages[19];delete d.stages[19];}d.routeVersion=20;atomicWrite(STAGE_FILE,d);}return d; }
function updateStageRecord(stageId, score) {
  const d = readStageRecords(), key = String(stageId), prev = Math.max(0, Number(d.stages[key] || 0));
  if (score > prev) { d.stages[key] = score; d.updatedAt = Date.now(); atomicWrite(STAGE_FILE, d); }
  return Math.max(prev, score);
}

function isBetterLeaderboardScore(a, b) {
  if (!b) return true;
  const as = Math.max(0, Number(a && a.score) || 0), bs = Math.max(0, Number(b && b.score) || 0);
  if (as !== bs) return as > bs;
  const ad = Math.max(0, Number(a && a.durationMs) || 0) || 9e15, bd = Math.max(0, Number(b && b.durationMs) || 0) || 9e15;
  return ad < bd;
}
function dedupeLeaderboardEntries(entries) {
  const map = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!raw) continue;
    const id = String(raw.playerId || '').trim();
    if (!id) continue;
    const item = Object.assign({}, raw, { playerId: id, score: Math.max(0, Math.floor(Number(raw.score) || 0)), durationMs: Math.max(0, Math.floor(Number(raw.durationMs) || 0)) });
    const old = map.get(id);
    if (!old) { map.set(id, item); continue; }
    const newer = Number(item.updatedAt || item.createdAt || 0) >= Number(old.updatedAt || old.createdAt || 0) ? item : old;
    const winner = isBetterLeaderboardScore(item, old) ? item : old;
    const merged = Object.assign({}, winner);
    // 成绩只保留最优；昵称头像允许使用同一玩家最近一次提交的资料刷新。
    if (newer.displayName) merged.displayName = newer.displayName;
    if (newer.avatarUrl) merged.avatarUrl = newer.avatarUrl;
    merged.verified = old.verified === true || item.verified === true;
    if (winner.source) merged.source = winner.source;
    merged.createdAt = Math.min(Number(old.createdAt || Date.now()), Number(item.createdAt || Date.now()));
    merged.updatedAt = Math.max(Number(old.updatedAt || 0), Number(item.updatedAt || 0));
    map.set(id, merged);
  }
  return Array.from(map.values());
}
function readLeaderboard() {
  ensureJson(LEADERBOARD_FILE, { entries: [] });
  const d = readJson(LEADERBOARD_FILE, { entries: [] });
  if (!Array.isArray(d.entries)) d.entries = [];
  const before = d.entries.length, deduped = dedupeLeaderboardEntries(d.entries);
  d.entries = deduped;
  // v5.49.0：发现历史重复 playerId 时自动归并为该玩家最优成绩。
  if (deduped.length !== before) { d.updatedAt = Date.now(); atomicWrite(LEADERBOARD_FILE, d); }
  return d;
}
function durationText(ms) {
  const sec = Math.max(0, Math.floor(Number(ms) || 0) / 1000), m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
function sortedEntries(entries) {
  return dedupeLeaderboardEntries(entries).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.durationMs) || 9e15) - (Number(b.durationMs) || 9e15) || (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
}
function formalSortedEntries(entries) {
  return sortedEntries((entries || []).filter((x) => x && (x.verified === true || x.source === 'wechat-verified')));
}
function submitLeaderboardEntry(entry) {
  const d = readLeaderboard(), id = String(entry.playerId || '').trim();
  let old = d.entries.find((x) => String(x.playerId) === id);
  const promoteVerified = !!(old && entry.verified === true && old.verified !== true);
  const scoreBetter = !old || isBetterLeaderboardScore(entry, old);
  const better = !old || promoteVerified || scoreBetter;
  if (better) {
    if (old) {
      // 若只是从历史未核验记录升级到正式记录，成绩仍以本次服务器核验值为准；
      // 正式记录建立后，后续只接受更高分，平分时只接受更短用时。
      Object.assign(old, entry, { updatedAt: Date.now() });
    } else d.entries.push(Object.assign({}, entry, { createdAt: Date.now(), updatedAt: Date.now() }));
  } else if (old && (entry.displayName || entry.avatarUrl)) {
    if (entry.displayName) old.displayName = entry.displayName;
    if (entry.avatarUrl) old.avatarUrl = entry.avatarUrl;
    old.updatedAt = Date.now();
  }
  d.entries = sortedEntries(d.entries).slice(0, 500);
  atomicWrite(LEADERBOARD_FILE, d);
  const finalIdx = d.entries.findIndex((x) => String(x.playerId) === id);
  const finalEntry = finalIdx >= 0 ? d.entries[finalIdx] : null;
  return { rank: finalIdx >= 0 ? finalIdx + 1 : 0, qualified: !!finalEntry, entry: finalEntry, improved: !!scoreBetter };
}

function removeLeaderboardEntry(userId) {
  const d = readLeaderboard(), before = d.entries.length;
  d.entries = d.entries.filter((x) => String(x.playerId) !== String(userId || ''));
  if (d.entries.length !== before) atomicWrite(LEADERBOARD_FILE, d);
  return before - d.entries.length;
}
function leaderboardEntryFor(userId) {
  const sorted = formalSortedEntries(readLeaderboard().entries).slice(0, 200);
  const idx = sorted.findIndex((x) => String(x.playerId) === String(userId || ''));
  if (idx < 0) return null;
  return Object.assign({ rank: idx + 1, durationText: durationText(sorted[idx].durationMs) }, sorted[idx]);
}

function summarizeSave(save) {
  const s = save || {};
  const best = s.bestScores && typeof s.bestScores === 'object' ? s.bestScores : {};
  let totalScore = Object.values(best).reduce((sum, v) => sum + Math.max(0, Number(v) || 0), 0);
  if (!best['1'] && !best[1]) totalScore += Math.max(0, Number(s.stage1Best) || 0);
  const treasures = s.treasures && typeof s.treasures === 'object' ? Object.values(s.treasures).filter(Boolean).length : 0;
  return {
    currentStage: Math.max(1, Math.min(20, Number(s.unlocked) || 1)),
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
      userId: u.userId, displayName: publicProfile(u).displayName, avatarUrl: publicProfile(u).avatarUrl,
      createdAt: u.createdAt || 0, lastLoginAt: u.lastLoginAt || 0,
      appVersion: u.appVersion || '', lastDeviceId: u.lastDeviceId || '', lastSaveAt: u.lastSaveAt || (rec && rec.serverUpdatedAt) || 0,
      progress: summarizeSave(rec && rec.save)
    };
  });
  const q = String(query.q || '').trim().toLowerCase();
  const filtered = q ? all.filter((x) => String(x.userId).toLowerCase().includes(q) || String(x.displayName||'').toLowerCase().includes(q) || String(x.appVersion).toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => Number(b.lastLoginAt) - Number(a.lastLoginAt));
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.max(10, Math.min(100, Number(query.pageSize) || 30));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  return { page, pages, total: filtered.length, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
}

function serveAdmin(res) {
  try {
    let html=fs.readFileSync(ADMIN_HTML, 'utf8');
    // 抽奖与核销员管理已整合进原后台导航，不再注入悬浮跳转入口。
    text(res, 200, html, 'text/html; charset=utf-8');
  }
  catch (e) { text(res, 500, 'admin page missing'); }
}
function serveLotteryAdmin(res) {
  try { text(res, 200, fs.readFileSync(LOTTERY_ADMIN_HTML, 'utf8'), 'text/html; charset=utf-8'); }
  catch (e) { text(res, 500, 'lottery admin page missing'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if(req.method==='GET'&&['/redeem','/redeem/','/admin/redeemers','/vendor/jsQR.js'].includes(p)){
      const file=p==='/vendor/jsQR.js'?'public/vendor/jsQR.js':p==='/admin/redeemers'?'public/admin/redeemers.html':'public/redeem.html';
      text(res,200,fs.readFileSync(path.join(__dirname,file),'utf8'),p.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');return;
    }
    if(p==='/api/admin/redeemers'){
      if(!requireAdmin(req,res))return;
      if(req.method==='GET'){json(res,200,{items:redeemers.list()});return;}
      if(req.method==='POST'){json(res,200,{ok:true,account:redeemers.save(await readBody(req,16*1024))});return;}
    }
    if(p==='/api/redeemer/login'&&req.method==='POST'){
      const key=String(req.socket.remoteAddress||''),now=Date.now();let attempt=staffAttempts.get(key);
      if(!attempt||now-attempt.at>600000){attempt={at:now,n:0};staffAttempts.set(key,attempt);}
      if(++attempt.n>20){json(res,429,{error:'登录尝试过多，请10分钟后重试'});return;}
      const b=await readBody(req,4096),a=redeemers.login(b.account,b.password);
      if(!a){json(res,401,{error:'账号或密码错误，或账号已停用'});return;}
      staffAttempts.delete(key);
      json(res,200,Object.assign({ok:true,name:a.name},issueToken(a.subject,8*3600000,'redeemer')));return;
    }
    if(p==='/api/redeemer/ticket'&&req.method==='GET'){
      if(!requireRedeemer(req,res))return;const code=String(u.searchParams.get('code')||'');
      if(!/^\d{8}$/.test(code)){json(res,400,{error:'请输入8位数字兑奖码'});return;}
      const ticket=lottery.findTicket(code);json(res,ticket?200:404,ticket?{ticket}:{error:'未找到奖券'});return;
    }
    if(p==='/api/redeemer/redeem'&&req.method==='POST'){
      const actor=requireRedeemer(req,res);if(!actor)return;const b=await readBody(req,4096);
      if(!/^\d{8}$/.test(String(b.code||''))){json(res,400,{error:'兑奖码格式错误'});return;}
      json(res,200,lottery.redeem(b.code,actor));return;
    }

    if (req.method === 'GET' && p === '/health') {
      json(res, 200, { ok: true, service: 'ponan-wechat-minigame', version: VERSION, authConfigured: !!(APPID && APPSECRET && TOKEN_SECRET.length >= 24), adminConfigured: !!ADMIN_PASSWORD }); return;
    }
    if (req.method === 'GET' && (p === '/admin' || p === '/admin/')) { serveAdmin(res); return; }
    if (req.method === 'GET' && (p === '/admin/lottery' || p === '/admin/lottery/')) { serveLotteryAdmin(res); return; }
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/media/bgm/')) { serveBgm(req, res, p.slice('/media/bgm/'.length)); return; }
    if (req.method === 'POST' && p === '/api/auth/wechat-login') { await handleLogin(req, res); return; }
    if (req.method === 'GET' && p === '/api/auth/me') {
      const userId = requireUser(req, res); if (!userId) return;
      const db = readUsersDb(), found = findUserById(db, userId);
      json(res, 200, { ok: true, userId, createdAt: found && found.user ? (found.user.createdAt || 0) : 0, lastLoginAt: found && found.user ? (found.user.lastLoginAt || 0) : 0, profile: found && found.user ? publicProfile(found.user) : null }); return;
    }
    if (p === '/api/profile' && req.method === 'GET') {
      const userId = requireUser(req, res); if (!userId) return;
      const db = readUsersDb(), found = findUserById(db, userId);
      json(res, 200, { ok: true, profile: found ? publicProfile(found.user) : null }); return;
    }
    if (p === '/api/profile' && (req.method === 'POST' || req.method === 'PUT')) {
      const userId = requireUser(req, res); if (!userId) return;
      const body = await readBody(req, 24 * 1024), profile = updateUserProfile(userId, body);
      if (!profile) { json(res, 404, { error: 'player not found' }); return; }
      // 已有榜单昵称/头像同步更新，但不改变成绩与名次。
      const oldEntry = leaderboardEntryFor(userId);
      if (oldEntry) submitLeaderboardEntry({ playerId: userId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, score: oldEntry.score || 0, durationMs: oldEntry.durationMs || 0, source: oldEntry.source || 'wechat' });
      json(res, 200, { ok: true, profile }); return;
    }
    if (req.method === 'POST' && p === '/api/save/sync') { await handleSaveSync(req, res); return; }
    if (req.method === 'GET' && p === '/api/save') {
      const userId = requireUser(req, res); if (!userId) return;
      const rec = readSaveRecord(userId); json(res, 200, { ok: true, save: rec ? rec.save : null, serverUpdatedAt: rec ? rec.serverUpdatedAt : 0 }); return;
    }

    if (req.method === 'GET' && p === '/api/config') { json(res, 200, publicRuntimeConfig()); return; }
    if (req.method === 'GET' && p === '/api/lottery/config') { json(res, 200, lottery.publicConfig()); return; }
    if (req.method === 'GET' && p === '/api/lottery/status') {
      const userId = requireUser(req, res); if (!userId) return;
      const db = readUsersDb(), found = findUserById(db, userId), rec = readSaveRecord(userId), cfg = readRuntimeConfig();
      json(res, 200, lottery.status({ userId, profile: found ? publicProfile(found.user) : null, save: rec && rec.save, debugMode: !!cfg.debugModeEnabled })); return;
    }
    if (req.method === 'POST' && p === '/api/lottery/draw') {
      const userId = requireUser(req, res); if (!userId) return;
      const body = await readBody(req, 12 * 1024), db = readUsersDb(), found = findUserById(db, userId), rec = readSaveRecord(userId), cfg = readRuntimeConfig();
      json(res, 200, lottery.draw({ userId, profile: found ? publicProfile(found.user) : null, save: rec && rec.save, debugMode: !!cfg.debugModeEnabled, debug: !!body.debug })); return;
    }
    if (req.method === 'POST' && p === '/api/lottery/debug-clear') {
      const userId = requireUser(req, res); if (!userId) return;
      const cfg = readRuntimeConfig();if (!cfg.debugModeEnabled) { json(res, 403, { error: '调试功能未开启' }); return; }
      json(res, 200, lottery.clearDebug(userId)); return;
    }
    if (req.method === 'POST' && p === '/api/debug/verify') {
      if (!allowDebugAttempt(req)) { json(res, 429, { error: 'too many attempts' }); return; }
      const body = await readBody(req, 8 * 1024), code = String(body.code || '').trim(), cfg = readRuntimeConfig();
      const ok = /^\d{4}$/.test(code) && safeEqual(code, String(cfg.debugEntryCode || '9999'));
      json(res, 200, { ok: true, forceDebug: !!ok }); return;
    }
    if (req.method === 'POST' && p === '/api/visit-counter') { json(res, 200, { count: incrementVisit() }); return; }
    if (p === '/api/stage-records' && req.method === 'GET') {
      const stage = Math.max(1, Math.min(20, Number(u.searchParams.get('stage')) || 1));
      const d = readStageRecords(); json(res, 200, { stageId: stage, score: Math.max(0, Number(d.stages[String(stage)] || 0)) }); return;
    }
    if (p === '/api/stage-records' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024), stage = Math.max(1, Math.min(20, Number(body.stageId) || 1)), score = Math.max(0, Math.floor(Number(body.score) || 0));
      json(res, 200, { ok: true, stageId: stage, score: updateStageRecord(stage, score) }); return;
    }

    if (p === '/api/leaderboard/me' && req.method === 'GET') {
      const userId = requireUser(req, res); if (!userId) return;
      const db = readUsersDb(), found = findUserById(db, userId);
      json(res, 200, { ok: true, entry: leaderboardEntryFor(userId), profile: found ? publicProfile(found.user) : null }); return;
    }
    if (p === '/api/leaderboard' && req.method === 'GET') {
      const d = readLeaderboard(), sorted = formalSortedEntries(d.entries).slice(0, 200), page = Math.max(1, Number(u.searchParams.get('page')) || 1), pageSize = Math.max(5, Math.min(20, Number(u.searchParams.get('pageSize')) || 10));
      const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
      const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((x, i) => ({ rank: (page - 1) * pageSize + i + 1, username: x.displayName || x.username || '微信玩家', displayName: x.displayName || x.username || '微信玩家', avatarUrl: x.avatarUrl || '', score: x.score || 0, durationMs: x.durationMs || 0, durationText: durationText(x.durationMs) }));
      json(res, 200, { page, pages, total: sorted.length, items }); return;
    }
    if (p === '/api/leaderboard/wechat' && req.method === 'POST') {
      const userId = requireUser(req, res); if (!userId) return;
      const body = await readBody(req, 32 * 1024);
      const rec = readSaveRecord(userId), save = rec && rec.save;
      if (!save || !save.gameCompleted || !save.completedStages?.[19] || !save.completedStages?.[20]) { json(res, 409, { error: '请先完成游戏并同步云存档' }); return; }
      const runtimeCfg = readRuntimeConfig();
      if (save.debugUsed && !runtimeCfg.debugScoresEnabled) { json(res, 403, { error: '本局使用过调试跳关，且后台未开启“调试模式记录成绩”' }); return; }
      // 正式榜单不再相信客户端传入总分：以服务器当前云存档为准。
      const authoritative = summarizeSave(save);
      const score = Math.max(0, Math.floor(Number(authoritative.totalScore) || 0));
      const startedAt = Math.max(0, Number(save.runStartedAt) || 0), completedAt = Math.max(0, Number(save.gameCompletedAt) || 0);
      let durationMs = startedAt && completedAt && completedAt >= startedAt ? completedAt - startedAt : Math.max(0, Math.floor(Number(body.durationMs) || 0));
      durationMs = Math.min(7 * 24 * 3600 * 1000, durationMs);
      const profile = updateUserProfile(userId, { displayName: body.nickname, avatarUrl: body.avatarUrl }) || { displayName: defaultDisplayName(userId), avatarUrl: '' };
      const debugAccepted = !!save.debugUsed;
      const submitted = submitLeaderboardEntry({ playerId: userId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, score, durationMs, source: debugAccepted ? 'wechat-debug-allowed' : 'wechat-verified', verified: true, debugUsed: debugAccepted });
      const formal = leaderboardEntryFor(userId);
      json(res, 200, { ok: true, rank: formal ? formal.rank : 0, qualified: !!formal, score: formal ? formal.score : score, durationMs: formal ? formal.durationMs : durationMs, attemptScore: score, attemptDurationMs: durationMs, improved: !!submitted.improved, bestOnly: true, verified: true, debugUsed: debugAccepted, debugScoresEnabled: !!runtimeCfg.debugScoresEnabled }); return;
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
      const lb = readLeaderboard(), formalCount = Math.min(200, formalSortedEntries(lb.entries).length);
      json(res, 200, Object.assign({ users: users.length, saves, completed, active7d: users.filter((x) => now - Number(x.lastLoginAt || 0) <= 7 * 86400000).length, leaderboard: formalCount, version: VERSION }, lottery.summary())); return;
    }
    if (p === '/api/admin/players' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, adminPlayers(Object.fromEntries(u.searchParams.entries()))); return; }
    if (p === '/api/admin/player' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const userId = String(u.searchParams.get('userId') || '');
      const db = readUsersDb(), found = findUserById(db, userId);
      if (!found) { json(res, 404, { error: 'player not found' }); return; }
      const rec = readSaveRecord(userId);
      json(res, 200, { user: { userId: found.user.userId, displayName: publicProfile(found.user).displayName, avatarUrl: publicProfile(found.user).avatarUrl, createdAt: found.user.createdAt || 0, lastLoginAt: found.user.lastLoginAt || 0, appVersion: found.user.appVersion || '', lastDeviceId: found.user.lastDeviceId || '', lastSaveAt: found.user.lastSaveAt || 0 }, progress: summarizeSave(rec && rec.save), leaderboard: leaderboardEntryFor(userId), save: rec ? rec.save : null, serverUpdatedAt: rec ? rec.serverUpdatedAt : 0 }); return;
    }
    if (p === '/api/admin/config' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, readRuntimeConfig()); return; }
    if (p === '/api/admin/config' && (req.method === 'PUT' || req.method === 'POST')) { if (!requireAdmin(req, res)) return; json(res, 200, writeRuntimeConfig(await readBody(req, 24 * 1024))); return; }
    if (p === '/api/admin/bgm' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, { items: bgmStore.list() }); return; }
    if (p === '/api/admin/bgm/upload' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      let name = '背景音乐'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || name)); } catch (_) {}
      json(res, 200, { ok: true, item: bgmStore.add(await readRawBody(req), name) }); return;
    }
    if (p === '/api/admin/bgm/delete' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req, 4096), id = String(body.id || ''), cfg = readRuntimeConfig();
      if (cfg.bgmSource === 'uploaded' && cfg.bgmTrackId === id) { json(res, 409, { error: '这首音乐正在使用，请先切换背景音乐并保存' }); return; }
      json(res, 200, { ok: true, removed: bgmStore.remove(id) }); return;
    }
    if (p === '/api/admin/lottery/config' && req.method === 'GET') { if (!requireAdmin(req, res)) return; json(res, 200, lottery.getConfig()); return; }
    if (p === '/api/admin/lottery/config' && (req.method === 'PUT' || req.method === 'POST')) { if (!requireAdmin(req, res)) return; json(res, 200, lottery.writeConfig(await readBody(req, 96 * 1024))); return; }
    if (p === '/api/admin/lottery/ticket' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;const code=String(u.searchParams.get('code')||'').trim();
      if(!/^\d{8}$/.test(code)){json(res,400,{error:'请输入8位兑奖码'});return;}
      const ticket=lottery.findTicket(code);if(!ticket){json(res,404,{error:'未找到该兑奖码'});return;}json(res,200,{ok:true,ticket});return;
    }
    if (p === '/api/admin/lottery/redeem' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;const body=await readBody(req,12*1024),code=String(body.code||'').trim();
      if(!/^\d{8}$/.test(code)){json(res,400,{error:'请输入8位兑奖码'});return;}json(res,200,lottery.redeem(code));return;
    }
    if (p === '/api/admin/leaderboard' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const sorted = sortedEntries(readLeaderboard().entries).slice(0, 200).map((x, i) => Object.assign({ rank: i + 1, durationText: durationText(x.durationMs) }, x));
      json(res, 200, { items: sorted, total: sorted.length }); return;
    }
    if (p === '/api/admin/leaderboard/remove' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req, 12 * 1024), userId = String(body.userId || '').trim();
      if (!userId) { json(res, 400, { error: 'userId is required' }); return; }
      json(res, 200, { ok: true, removed: removeLeaderboardEntry(userId) }); return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    const status = Number(err && err.status) || (/too large/i.test(String(err && err.message)) ? 413 : 500);
    json(res, status, { error: err && err.message ? err.message : 'internal error' });
  }
});

for (const dir of [path.dirname(DB_FILE), SAVE_DIR, path.dirname(CONFIG_FILE), path.dirname(VISIT_FILE), path.dirname(LEADERBOARD_FILE)]) fs.mkdirSync(dir, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ponan-wechat-minigame v${VERSION} listening on`, PORT);
});
