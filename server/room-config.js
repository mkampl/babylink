/**
 * Room Configuration Management
 *
 * Manages per-room configuration including ntfy.sh notification settings
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

class RoomConfigManager {
  constructor() {
    this.configs = new Map();
    this.configFile = path.join(__dirname, '../data/room-configs.json');
    this.loaded = false;
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
   * Save room configurations to file
   */
  async save() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.configFile);
      await fs.mkdir(dataDir, { recursive: true });

      const configs = {};
      for (const [roomId, config] of this.configs.entries()) {
        configs[roomId] = config;
      }

      await fs.writeFile(
        this.configFile,
        JSON.stringify(configs, null, 2),
        'utf8'
      );

      logger.debug(`Saved ${this.configs.size} room configurations`);
    } catch (error) {
      logger.error('Failed to save room configurations:', error);
    }
  }

  /**
   * Get configuration for a room
   *
   * @param {string} roomId - Room ID
   * @returns {object} - Room configuration
   */
  getConfig(roomId) {
    return this.configs.get(roomId) || {
      ntfyTopic: null,
      ntfyEnabled: false,
      notifyOnCrying: true,
      notifyOnDisconnect: true,
      notifyOnActivity: false
    };
  }

  /**
   * Update configuration for a room
   *
   * @param {string} roomId - Room ID
   * @param {object} updates - Configuration updates
   */
  async updateConfig(roomId, updates) {
    const current = this.getConfig(roomId);
    const updated = { ...current, ...updates };

    this.configs.set(roomId, updated);
    await this.save();

    logger.info(`Updated configuration for room ${roomId}:`, updates);
    return updated;
  }

  /**
   * Set ntfy.sh topic for a room
   *
   * @param {string} roomId - Room ID
   * @param {string} topic - ntfy.sh topic name
   * @param {boolean} enabled - Enable notifications
   */
  async setNtfyTopic(roomId, topic, enabled = true) {
    return await this.updateConfig(roomId, {
      ntfyTopic: topic,
      ntfyEnabled: enabled
    });
  }

  /**
   * Get ntfy.sh topic for a room
   *
   * @param {string} roomId - Room ID
   * @returns {string|null} - Topic name or null
   */
  getNtfyTopic(roomId) {
    const config = this.getConfig(roomId);
    return config.ntfyEnabled ? config.ntfyTopic : null;
  }

  /**
   * Check if notifications are enabled for a room
   *
   * @param {string} roomId - Room ID
   * @returns {boolean}
   */
  isNotificationsEnabled(roomId) {
    const config = this.getConfig(roomId);
    return config.ntfyEnabled && config.ntfyTopic;
  }

  /**
   * Delete configuration for a room
   *
   * @param {string} roomId - Room ID
   */
  async deleteConfig(roomId) {
    this.configs.delete(roomId);
    await this.save();
    logger.info(`Deleted configuration for room ${roomId}`);
  }

  /**
   * Get all room configurations (for admin)
   *
   * @returns {Array} - Array of room configs
   */
  getAllConfigs() {
    const configs = [];
    for (const [roomId, config] of this.configs.entries()) {
      configs.push({ roomId, ...config });
    }
    return configs;
  }
}

// Export singleton instance
module.exports = new RoomConfigManager();
