'use strict';

/**
 * 坡南寻宝记 v5.33.0 微信静默登录参考服务
 * Node.js 18+，无需把 AppSecret 放进小游戏。
 *
 * 环境变量：
 *   WECHAT_APPID=微信小游戏AppID
 *   WECHAT_APPSECRET=微信小游戏AppSecret
 *   AUTH_TOKEN_SECRET=至少32位随机字符串
 *   PORT=3000
 *   USER_DB_FILE=/data/ponan-wechat-users.json   (可选)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const APPID = String(process.env.WECHAT_APPID || '').trim();
const APPSECRET = String(process.env.WECHAT_APPSECRET || '').trim();
const TOKEN_SECRET = String(process.env.AUTH_TOKEN_SECRET || '').trim();
const DB_FILE = process.env.USER_DB_FILE || path.join(__dirname, 'data', 'ponan-wechat-users.json');

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store'
  });
  res.end(data);
}

function readBody(req, limit = 16 * 1024) {
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

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ usersByOpenid: {} }, null, 2));
}

function readDb() {
  ensureDb();
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.usersByOpenid || typeof data.usersByOpenid !== 'object') data.usersByOpenid = {};
    return data;
  } catch (e) {
    return { usersByOpenid: {} };
  }
}

function writeDb(db) {
  ensureDb();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('wechat response parse failed')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('wechat request timeout')); });
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

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function issueToken(userId, ttlMs = 30 * 24 * 3600 * 1000) {
  const expiresAt = Date.now() + ttlMs;
  const payload = base64url(JSON.stringify({ sub: userId, exp: expiresAt }));
  const sig = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest());
  return { token: payload + '.' + sig, expiresAt };
}

function newUserId() {
  return 'pn_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');
}

async function handleLogin(req, res) {
  if (!APPID || !APPSECRET || TOKEN_SECRET.length < 24) {
    json(res, 503, { error: 'wechat auth server is not configured' });
    return;
  }
  const body = await readBody(req);
  const code = String(body.code || '').trim();
  if (!code) {
    json(res, 400, { error: 'code is required' });
    return;
  }

  const wxSession = await code2Session(code);
  const openid = String(wxSession.openid);
  const db = readDb();
  let user = db.usersByOpenid[openid];
  const isNewUser = !user;
  if (!user) {
    user = {
      userId: newUserId(),
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      unionid: wxSession.unionid || '',
      lastDeviceId: String(body.deviceId || '').slice(0, 80),
      appVersion: String(body.appVersion || '').slice(0, 80)
    };
    db.usersByOpenid[openid] = user;
  } else {
    user.lastLoginAt = Date.now();
    user.lastDeviceId = String(body.deviceId || '').slice(0, 80);
    user.appVersion = String(body.appVersion || '').slice(0, 80);
    if (wxSession.unionid) user.unionid = wxSession.unionid;
  }
  writeDb(db);

  const auth = issueToken(user.userId);
  json(res, 200, {
    ok: true,
    userId: user.userId,
    token: auth.token,
    expiresAt: auth.expiresAt,
    isNewUser
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && u.pathname === '/health') {
      json(res, 200, { ok: true, service: 'ponan-wechat-auth' });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/wechat-login') {
      await handleLogin(req, res);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err && err.message ? err.message : 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ponan-wechat-auth listening on', PORT);
});
