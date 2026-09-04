'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createBgmStore(dataDir) {
  const dir = path.join(dataDir, 'media', 'bgm');
  const indexFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });

  function readIndex() {
    try {
      const value = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return { items: Array.isArray(value.items) ? value.items : [] };
    } catch (_) { return { items: [] }; }
  }
  function writeIndex(value) {
    const tmp = indexFile + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, indexFile);
  }
  function publicItem(item) {
    return { id: item.id, name: item.name, mime: item.mime, size: item.size, createdAt: item.createdAt, url: '/media/bgm/' + item.id };
  }
  function detect(buffer, suppliedName) {
    const name = String(suppliedName || '').toLowerCase();
    if (buffer.length >= 3 && buffer.subarray(0, 3).toString() === 'ID3') return { ext: '.mp3', mime: 'audio/mpeg' };
    if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return { ext: '.mp3', mime: 'audio/mpeg' };
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return { ext: '.wav', mime: 'audio/wav' };
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString() === 'OggS') return { ext: '.ogg', mime: 'audio/ogg' };
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString() === 'ftyp') return { ext: /\.aac$/.test(name) ? '.aac' : '.m4a', mime: 'audio/mp4' };
    const err = new Error('无法识别音频格式，请上传 MP3、M4A、AAC、WAV 或 OGG 文件'); err.status = 415; throw err;
  }
  function list() {
    const data = readIndex();
    data.items = data.items.filter((x) => x && x.id && x.file && fs.existsSync(path.join(dir, x.file)));
    return data.items.map(publicItem);
  }
  function find(id) {
    const item = readIndex().items.find((x) => x.id === String(id || ''));
    if (!item) return null;
    const file = path.join(dir, item.file);
    if (!fs.existsSync(file)) return null;
    return Object.assign({}, item, { path: file, url: '/media/bgm/' + item.id });
  }
  function add(buffer, suppliedName) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) { const err = new Error('音频文件为空'); err.status = 400; throw err; }
    const type = detect(buffer, suppliedName);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const id = hash.slice(0, 20);
    const data = readIndex();
    const existing = data.items.find((x) => x.id === id);
    if (existing && fs.existsSync(path.join(dir, existing.file))) return publicItem(existing);
    const cleanName = String(suppliedName || ('背景音乐' + type.ext)).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) || ('背景音乐' + type.ext);
    const item = { id, name: cleanName, file: id + type.ext, mime: type.mime, size: buffer.length, sha256: hash, createdAt: Date.now() };
    fs.writeFileSync(path.join(dir, item.file), buffer, { flag: 'wx' });
    data.items.unshift(item);
    writeIndex(data);
    return publicItem(item);
  }
  function remove(id) {
    const data = readIndex();
    const at = data.items.findIndex((x) => x.id === String(id || ''));
    if (at < 0) return false;
    const item = data.items[at];
    data.items.splice(at, 1);
    writeIndex(data);
    try { fs.unlinkSync(path.join(dir, item.file)); } catch (_) {}
    return true;
  }
  return { list, find, add, remove };
};
