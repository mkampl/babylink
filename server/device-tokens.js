/**
 * Device tokens for ESP32 registrations (trust on first use).
 *
 * Newer firmware generates a random token once, keeps it in NVS across
 * factory resets and sends it as `deviceToken` in every `register`. The
 * server remembers a hash of the first token seen for a device IN A ROOM and
 * from then on requires it for that device in that room. Records are scoped
 * per room, so someone who only knows a device's MAC can't lock it out of
 * the room its owner provisioned it into (they'd need the room id too).
 *
 * Devices running older firmware send no token: no record is ever created
 * for them and they register exactly as before.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const TOKEN_PATTERN = /^[A-Za-z0-9]{16,128}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

class DeviceTokenStore {
  constructor() {
    this.records = new Map(); // `${roomId}:${esp32Id}` -> { hash, lastSeenAt }
    this.file = path.join(__dirname, '../data/device-tokens.json');
    this._writeLock = Promise.resolve();
  }

  static isWellFormed(token) {
    return typeof token === 'string' && TOKEN_PATTERN.test(token);
  }

  static hash(token) { return hashToken(token); }

  static matches(token, hash) {
    return DeviceTokenStore.isWellFormed(token) && sameHash(hashToken(token), hash);
  }

  _key(roomId, esp32Id) { return `${roomId}:${esp32Id}`; }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.records.clear();
      for (const [k, v] of Object.entries(data)) this.records.set(k, v);
      logger.info(`Loaded ${this.records.size} device tokens`);
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error('Failed to load device tokens:', err);
    }
  }

  save() {
    this._writeLock = this._writeLock.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    }).catch(err => logger.error('Device token save failed:', err));
    return this._writeLock;
  }

  get(roomId, esp32Id) {
    return this.records.get(this._key(roomId, esp32Id)) || null;
  }

  /**
   * Check a registration. Returns { ok: true, hash } (hash = the verified
   * token's hash, or null for a token-less legacy device) or { ok: false }.
   * A first well-formed token for (room, device) is recorded.
   */
  check(roomId, esp32Id, token, now = Date.now()) {
    const key = this._key(roomId, esp32Id);
    const rec = this.records.get(key);
    if (rec) {
      if (!DeviceTokenStore.matches(token, rec.hash)) return { ok: false };
      rec.lastSeenAt = now;
      return { ok: true, hash: rec.hash };
    }
    if (!DeviceTokenStore.isWellFormed(token)) return { ok: true, hash: null };
    const hash = hashToken(token);
    this.records.set(key, { hash, lastSeenAt: now });
    this.save();
    logger.info(`Device token recorded for ${esp32Id} in room ${roomId}`);
    return { ok: true, hash };
  }

  forget(roomId, esp32Id) {
    const existed = this.records.delete(this._key(roomId, esp32Id));
    if (existed) this.save();
    return existed;
  }

  /** Drop records not seen for maxAgeMs (persists lastSeenAt as a side effect). */
  expire(now, maxAgeMs) {
    let n = 0;
    for (const [k, rec] of this.records.entries()) {
      if (now - (rec.lastSeenAt || 0) > maxAgeMs) { this.records.delete(k); n++; }
    }
    this.save();
    return n;
  }

  clear() { this.records.clear(); }
}

module.exports = new DeviceTokenStore();
module.exports.DeviceTokenStore = DeviceTokenStore;
