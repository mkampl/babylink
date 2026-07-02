/**
 * Room Configuration Management
 *
 * Manages per-room configuration including ntfy.sh notification settings,
 * PIN protection, and owner token hashes.
 *
 * NOTE: Rooms created via POST /api/rooms carry an ownerHash. Rooms that
 * exist only through a socket join have no ownerHash and cannot be managed
 * via the owner-authenticated management endpoints. This is an accepted
 * pre-1.0 limitation — clients should create rooms via the API.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Scrypt parameters: N=16384, r=8, p=1 → ~100ms on commodity hardware
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

class RoomConfigManager {
  constructor() {
    this.configs = new Map();
    this.configFile = path.join(__dirname, '../data/room-configs.json');
    this.loaded = false;
    // Serialise writes: each save chains onto the previous promise so
    // concurrent callers never interleave file I/O.
    this._writeLock = Promise.resolve();
  }

  /**
   * Load room configurations from file
   */
  async load() {
    try {
      const data = await fs.readFile(this.configFile, 'utf8');
      const configs = JSON.parse(data);

      this.configs.clear();
      for (const [roomId, config] of Object.entries(configs)) {
        this.configs.set(roomId, config);
      }

      logger.info(`Loaded ${this.configs.size} room configurations`);
      this.loaded = true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('No room configurations file found, starting fresh');
        this.loaded = true;
      } else {
        logger.error('Failed to load room configurations:', error);
      }
    }
  }

  /**
   * Save room configurations to file atomically (temp-file + rename).
   * Writes are serialised via _writeLock to prevent corruption.
   */
  async save() {
    this._writeLock = this._writeLock.then(() => this._doSave()).catch(err => {
      logger.error('Config save failed:', err);
    });
    return this._writeLock;
  }

  async _doSave() {
    const dataDir = path.dirname(this.configFile);
    await fs.mkdir(dataDir, { recursive: true });

    const configs = {};
    for (const [roomId, config] of this.configs.entries()) {
      configs[roomId] = config;
    }

    const tmp = this.configFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(configs, null, 2), 'utf8');
    await fs.rename(tmp, this.configFile);

    logger.debug(`Saved ${this.configs.size} room configurations`);
  }

  /**
   * Get configuration for a room. Returns a default shape when the room
   * has no persisted config (lazy-created rooms).
   */
  getConfig(roomId) {
    return this.configs.get(roomId) || {
      ownerHash: null,
      ntfyTopic: null,
      ntfyServer: null,
      ntfyEnabled: false,
      notifyOnCrying: true,
      notifyOnDisconnect: true,
      notifyOnActivity: false,
      pin: null,
    };
  }

  /**
   * Update configuration for a room
   */
  async updateConfig(roomId, updates) {
    const current = this.getConfig(roomId);
    const updated = { ...current, ...updates };

    this.configs.set(roomId, updated);
    await this.save();

    return updated;
  }

  /**
   * Delete configuration for a room. Called when the owning resource is
   * removed so the config store does not grow unboundedly.
   */
  async deleteConfig(roomId) {
    this.configs.delete(roomId);
    await this.save();
    logger.info(`Deleted configuration for room ${roomId}`);
  }

  // -------------------------------------------------------------------------
  // Owner token management
  // -------------------------------------------------------------------------

  /**
   * Store the SHA-256 hash of an ownerToken for a newly created room.
   * The raw token must never be persisted.
   *
   * @param {string} roomId
   * @param {string} ownerToken - raw 64-hex token
   */
  async setOwnerToken(roomId, ownerToken) {
    const ownerHash = crypto.createHash('sha256').update(ownerToken).digest('hex');
    return await this.updateConfig(roomId, { ownerHash });
  }

  /**
   * Verify an owner token against the stored hash.
   * Returns 'ok', 'no-owner' (room has no owner), or 'invalid'.
   */
  verifyOwnerToken(roomId, token) {
    const cfg = this.getConfig(roomId);
    if (!cfg.ownerHash) return 'no-owner';
    if (!token) return 'invalid';

    const presented = crypto.createHash('sha256').update(token).digest();
    const stored = Buffer.from(cfg.ownerHash, 'hex');

    // timingSafeEqual requires same-length buffers; both are SHA-256 so 32 bytes each
    if (!crypto.timingSafeEqual(presented, stored)) return 'invalid';
    return 'ok';
  }

  // -------------------------------------------------------------------------
  // PIN management (scrypt, per-room salt, timing-safe compare)
  // -------------------------------------------------------------------------

  /**
   * Hash a PIN with a fresh per-room random salt using scrypt.
   * Returns { salt, hash } strings (hex-encoded).
   */
  _hashPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
    }).toString('hex');
    return { salt, hash };
  }

  /**
   * Set PIN for a room (null to remove). PIN must be ≥6 digits.
   * Caller is responsible for length/format validation.
   */
  async setPin(roomId, pin) {
    if (pin === null || pin === undefined || pin === '') {
      return await this.updateConfig(roomId, { pin: null });
    }
    return await this.updateConfig(roomId, { pin: this._hashPin(pin) });
  }

  /**
   * Verify PIN for a room. Returns true if no PIN is set or PIN matches.
   */
  verifyPin(roomId, pin) {
    const cfg = this.getConfig(roomId);
    if (!cfg.pin) return true;  // no PIN set → always pass
    if (!pin) return false;

    const { salt, hash } = cfg.pin;
    // Support the old unsalted SHA-256 format (string) as invalid so
    // existing rooms with old PINs must be re-set rather than crashing.
    if (typeof cfg.pin === 'string' || !salt || !hash) return false;

    let candidate;
    try {
      candidate = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
      });
    } catch {
      return false;
    }

    return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
  }

  /**
   * Check if a room has a PIN set
   */
  hasPin(roomId) {
    const cfg = this.getConfig(roomId);
    return !!cfg.pin;
  }
}

// Export singleton instance
module.exports = new RoomConfigManager();
