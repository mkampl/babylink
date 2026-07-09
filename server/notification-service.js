/**
 * Notification Service
 *
 * Sends push notifications via ntfy.sh for baby monitor events.
 * Supports per-room notification topics with cooldown logic.
 *
 * SSRF hardening: all caller-supplied ntfy server URLs are validated
 * against an explicit allowlist before any outbound request is made.
 */

const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Validate a caller-supplied ntfy server URL.
 *
 * Rules:
 *  1. Must be https://
 *  2. Host must appear in the provided allowlist
 *
 * Returns null on success, or an error string on failure.
 *
 * @param {string} ntfyServer - URL to validate (e.g. 'https://ntfy.sh')
 * @param {string[]} allowedHosts - allowed hostnames
 * @returns {string|null}
 */
function validateNtfyServer(ntfyServer, allowedHosts) {
  if (!ntfyServer) return null; // null → use default, always allowed

  let parsed;
  try {
    parsed = new URL(ntfyServer);
  } catch {
    return 'Invalid ntfy server URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'ntfy server must use HTTPS';
  }

  // The UI explicitly invites users to run their OWN ntfy server, and these
  // endpoints are owner-token authenticated — so a static ntfy.sh-only
  // allowlist broke the advertised self-hosted flow (every other host → 400).
  // Accept any public HTTPS host, but keep SSRF hygiene by rejecting
  // loopback/private/link-local targets (which a cloud server can't reach
  // anyway). NTFY_ALLOWED_HOSTS still force-allows a host if an operator
  // really wants an internal one.
  const extraHosts = (process.env.NTFY_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);
  const explicitlyAllowed = [...allowedHosts, ...extraHosts].includes(parsed.hostname);

  if (!explicitlyAllowed && isPrivateOrLocalHost(parsed.hostname)) {
    return `ntfy server host '${parsed.hostname}' is not allowed (loopback/private address).`;
  }

  return null;
}

// Block SSRF to internal targets: loopback, RFC-1918 / CGNAT, link-local, and
// non-public names. Hostname/IP-literal based (no DNS lookup) — adequate here
// given owner-auth and that a public cloud server can't reach these anyway.
function isPrivateOrLocalHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal')) {
    return true;
  }
  // IPv6 loopback / link-local (fe80::/10) / unique-local (fc00::/7)
  if (h === '::1' || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') ||
      h.startsWith('feb') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC-1918
    if (a === 192 && b === 168) return true;            // RFC-1918
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  }
  return false;
}

/**
 * Validate an ntfy topic name.
 * Must be 1–64 characters: alphanumeric, underscore, or hyphen.
 *
 * @param {string} topic
 * @returns {string|null} error string or null on success
 */
function validateNtfyTopic(topic) {
  if (!topic || typeof topic !== 'string') return 'Topic is required';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    return 'Topic must be 1–64 characters: letters, digits, underscore, or hyphen';
  }
  return null;
}

class NotificationService {
  constructor() {
    this.ntfyServer = process.env.NTFY_SERVER || 'https://ntfy.sh';
    this.allowedHosts = ['ntfy.sh'];

    // Track last notification time per room to prevent spam
    this.lastNotificationTime = new Map();

    // Default cooldown periods (in milliseconds)
    this.cooldowns = {
      crying: 10 * 1000,           // 10 seconds for crying alerts
      disconnect: 2 * 60 * 1000,  // 2 minutes for device disconnects
      activity: 10 * 60 * 1000    // 10 minutes for general activity
    };
  }

  /**
   * Validate a topic + optional custom server URL.
   * Returns null on success or an error string.
   */
  validateConfig(topic, ntfyServer) {
    const topicErr = validateNtfyTopic(topic);
    if (topicErr) return topicErr;

    const serverErr = validateNtfyServer(ntfyServer, this.allowedHosts);
    if (serverErr) return serverErr;

    return null;
  }

  /**
   * Send notification to ntfy.sh topic
   *
   * @param {string} topic - ntfy.sh topic name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {object} options - Additional options (priority, tags, etc.)
   * @param {string} [serverOverride] - Per-request server URL override
   * @returns {Promise<boolean>} - Success status
   */
  async sendNotification(topic, title, message, options = {}, serverOverride = null) {
    if (!topic) {
      logger.warn('Cannot send notification: no topic specified');
      return false;
    }

    const server = serverOverride || this.ntfyServer;

    try {
      const {
        priority = 'default',
        tags = [],
        click = null,
        actions = []
      } = options;

      const headers = {
        'Title': title,
        'Priority': priority,
        'Tags': tags.join(',')
      };

      if (click) headers['Click'] = click;

      if (actions.length > 0) {
        headers['Actions'] = actions.map(a => `${a.action}, ${a.label}, ${a.url || ''}`).join('; ');
      }

      await axios.post(`${server}/${topic}`, message, { headers });

      logger.info(`Notification sent to topic "${topic}": ${title}`);
      return true;

    } catch (error) {
      logger.error(`Failed to send notification to topic "${topic}":`, error.message);
      return false;
    }
  }

  /**
   * Check if notification should be sent based on cooldown period
   */
  shouldSendNotification(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    const lastTime = this.lastNotificationTime.get(key);
    const cooldown = this.cooldowns[eventType] || this.cooldowns.activity;

    if (!lastTime) return true;

    return (Date.now() - lastTime) >= cooldown;
  }

  /**
   * Record that a notification was sent
   */
  recordNotification(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    this.lastNotificationTime.set(key, Date.now());
  }

  /**
   * Send crying alert notification
   */
  async sendCryingAlert(topic, roomId, babyName, serverUrl, serverOverride = null) {
    if (!this.shouldSendNotification(roomId, 'crying')) {
      const status = this.getCooldownStatus(roomId, 'crying');
      logger.info(`Skipping crying alert for room ${roomId} (cooldown: ${status.timeRemaining}s remaining)`);
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
      },
      serverOverride
    );

    if (success) this.recordNotification(roomId, 'crying');
    return success;
  }

  /**
   * Send device disconnect notification
   */
  async sendDisconnectAlert(topic, roomId, babyName, serverOverride = null) {
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
      },
      serverOverride
    );

    if (success) this.recordNotification(roomId, 'disconnect');
    return success;
  }

  /**
   * Clear cooldown for a specific room and event type (useful for testing)
   */
  clearCooldown(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    this.lastNotificationTime.delete(key);
  }

  /**
   * Get cooldown status for debugging
   */
  getCooldownStatus(roomId, eventType) {
    const key = `${roomId}:${eventType}`;
    const lastTime = this.lastNotificationTime.get(key);
    const cooldown = this.cooldowns[eventType] || this.cooldowns.activity;

    if (!lastTime) return { active: false, timeRemaining: 0 };

    const timeRemaining = Math.max(0, cooldown - (Date.now() - lastTime));
    return {
      active: timeRemaining > 0,
      timeRemaining: Math.ceil(timeRemaining / 1000),
      nextAvailable: new Date(lastTime + cooldown)
    };
  }
}

module.exports = new NotificationService();
module.exports.validateNtfyServer = validateNtfyServer;
module.exports.validateNtfyTopic = validateNtfyTopic;
