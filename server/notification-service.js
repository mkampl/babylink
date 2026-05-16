/**
 * Notification Service
 *
 * Sends push notifications via ntfy.sh for baby monitor events
 * Supports per-room notification topics with cooldown logic
 */

const axios = require('axios');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.ntfyServer = process.env.NTFY_SERVER || 'https://ntfy.sh';

    // Track last notification time per room to prevent spam
    this.lastNotificationTime = new Map();

    // Default cooldown periods (in milliseconds)
    this.cooldowns = {
      crying: 5 * 60 * 1000,      // 5 minutes for crying alerts
      disconnect: 2 * 60 * 1000,   // 2 minutes for device disconnects
      reconnect: 1 * 60 * 1000,    // 1 minute for reconnect events
      activity: 10 * 60 * 1000     // 10 minutes for general activity
    };
  }

  /**
   * Send notification to ntfy.sh topic
   *
   * @param {string} topic - ntfy.sh topic name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {object} options - Additional options (priority, tags, etc.)
   * @returns {Promise<boolean>} - Success status
   */
  async sendNotification(topic, title, message, options = {}) {
    if (!topic) {
      logger.warn('Cannot send notification: no topic specified');
      return false;
    }

    try {
      const {
        priority = 'default',  // min, low, default, high, urgent
        tags = [],
        click = null,
        actions = []
      } = options;

      const headers = {
        'Title': title,
        'Priority': priority,
        'Tags': tags.join(',')
      };

      if (click) {
        headers['Click'] = click;
      }

      if (actions.length > 0) {
        headers['Actions'] = actions.map(a => `${a.action}, ${a.label}, ${a.url || ''}`).join('; ');
      }

      await axios.post(
        `${this.ntfyServer}/${topic}`,
        message,
        { headers }
      );

      logger.info(`Notification sent to topic "${topic}": ${title}`);
      return true;

    } catch (error) {
      logger.error(`Failed to send notification to topic "${topic}":`, error.message);
      return false;
    }
  }

  /**
   * Check if notification should be sent based on cooldown period
   *
   * @param {string} roomId - Room ID
   * @param {string} eventType - Event type (crying, disconnect, etc.)
   * @returns {boolean} - True if notification should be sent
   */
  shouldSendNotification(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    const lastTime = this.lastNotificationTime.get(key);
    const cooldown = this.cooldowns[eventType] || this.cooldowns.activity;

    if (!lastTime) {
      return true;
    }

    const timeSinceLastNotification = Date.now() - lastTime;
    return timeSinceLastNotification >= cooldown;
  }

  /**
   * Record that a notification was sent
   *
   * @param {string} roomId - Room ID
   * @param {string} eventType - Event type
   */
  recordNotification(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    this.lastNotificationTime.set(key, Date.now());
  }

  /**
   * Send crying alert notification
   *
   * @param {string} topic - ntfy.sh topic
   * @param {string} roomId - Room ID
   * @param {string} babyName - Baby device name
   * @param {string} serverUrl - BabyLink server URL for click action
   * @returns {Promise<boolean>}
   */
  async sendCryingAlert(topic, roomId, babyName, serverUrl) {
    if (!this.shouldSendNotification(roomId, 'crying')) {
      logger.debug(`Skipping crying alert for room ${roomId} (cooldown active)`);
      return false;
    }

    const success = await this.sendNotification(
      topic,
      '👶 Baby is crying!',
      `${babyName} is crying in the baby monitor`,
      {
        priority: 'high',
        tags: ['baby', 'crying', 'alert'],
        click: serverUrl ? `${serverUrl}/${roomId}?role=parent` : null
      }
    );

    if (success) {
      this.recordNotification(roomId, 'crying');
    }

    return success;
  }

  /**
   * Send device disconnect notification
   *
   * @param {string} topic - ntfy.sh topic
   * @param {string} roomId - Room ID
   * @param {string} babyName - Baby device name
   * @returns {Promise<boolean>}
   */
  async sendDisconnectAlert(topic, roomId, babyName) {
    if (!this.shouldSendNotification(roomId, 'disconnect')) {
      logger.debug(`Skipping disconnect alert for room ${roomId} (cooldown active)`);
      return false;
    }

    const success = await this.sendNotification(
      topic,
      '⚠️ Baby monitor disconnected',
      `${babyName} has disconnected from the room`,
      {
        priority: 'default',
        tags: ['baby', 'warning', 'disconnect']
      }
    );

    if (success) {
      this.recordNotification(roomId, 'disconnect');
    }

    return success;
  }

  /**
   * Send device reconnect notification
   *
   * @param {string} topic - ntfy.sh topic
   * @param {string} roomId - Room ID
   * @param {string} babyName - Baby device name
   * @returns {Promise<boolean>}
   */
  async sendReconnectAlert(topic, roomId, babyName) {
    if (!this.shouldSendNotification(roomId, 'reconnect')) {
      logger.debug(`Skipping reconnect alert for room ${roomId} (cooldown active)`);
      return false;
    }

    const success = await this.sendNotification(
      topic,
      '✅ Baby monitor reconnected',
      `${babyName} has reconnected to the room`,
      {
        priority: 'low',
        tags: ['baby', 'info', 'connected']
      }
    );

    if (success) {
      this.recordNotification(roomId, 'reconnect');
    }

    return success;
  }

  /**
   * Send activity log notification
   *
   * @param {string} topic - ntfy.sh topic
   * @param {string} roomId - Room ID
   * @param {string} activity - Activity description
   * @returns {Promise<boolean>}
   */
  async sendActivityNotification(topic, roomId, activity) {
    if (!this.shouldSendNotification(roomId, 'activity')) {
      logger.debug(`Skipping activity notification for room ${roomId} (cooldown active)`);
      return false;
    }

    const success = await this.sendNotification(
      topic,
      '📝 Baby Monitor Activity',
      activity,
      {
        priority: 'low',
        tags: ['baby', 'activity', 'log']
      }
    );

    if (success) {
      this.recordNotification(roomId, 'activity');
    }

    return success;
  }

  /**
   * Clear cooldown for a specific room and event type
   * Useful for testing or manual override
   *
   * @param {string} roomId - Room ID
   * @param {string} eventType - Event type
   */
  clearCooldown(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    this.lastNotificationTime.delete(key);
    logger.debug(`Cleared cooldown for ${key}`);
  }

  /**
   * Get cooldown status for debugging
   *
   * @param {string} roomId - Room ID
   * @param {string} eventType - Event type
   * @returns {object} - Cooldown info
   */
  getCooldownStatus(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    const lastTime = this.lastNotificationTime.get(key);
    const cooldown = this.cooldowns[eventType] || this.cooldowns.activity;

    if (!lastTime) {
      return { active: false, timeRemaining: 0 };
    }

    const timeSinceLastNotification = Date.now() - lastTime;
    const timeRemaining = Math.max(0, cooldown - timeSinceLastNotification);

    return {
      active: timeRemaining > 0,
      timeRemaining: Math.ceil(timeRemaining / 1000), // in seconds
      nextAvailable: new Date(lastTime + cooldown)
    };
  }
}

// Export singleton instance
module.exports = new NotificationService();
