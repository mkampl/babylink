/**
 * Notification Settings UI - ntfy.sh push notification configuration
 */
class NotificationUI {
  constructor(roomId) {
    this.roomId = roomId;
  }

  initialize() {
    const el = document.getElementById('notificationSettings');
    if (el) el.style.display = 'block';

    this.loadConfig();

    const saveBtn = document.getElementById('saveNotificationBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => this.saveConfig());

    const testBtn = document.getElementById('testNotificationBtn');
    if (testBtn) testBtn.addEventListener('click', () => this.testNotification());

    const topicInput = document.getElementById('ntfyTopic');
    if (topicInput) {
      topicInput.addEventListener('input', (e) => {
        const tb = document.getElementById('testNotificationBtn');
        if (tb) tb.disabled = !e.target.value.trim();
      });
    }
  }

  toggle() {
    const content = document.getElementById('notificationContent');
    const toggle = document.getElementById('notificationToggle');
    if (!content) return;
    if (content.style.display === 'none') {
      content.style.display = 'block';
      if (toggle) toggle.textContent = '\u25B2';
    } else {
      content.style.display = 'none';
      if (toggle) toggle.textContent = '\u25BC';
    }
  }

  async loadConfig() {
    try {
      const res = await fetch(`/api/rooms/${this.roomId}/config`);
      if (!res.ok) return;
      const config = await res.json();

      const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

      setVal('ntfyServer', config.ntfyServer || '');
      setVal('ntfyTopic', config.ntfyTopic || '');
      setChecked('ntfyEnabled', config.ntfyEnabled || false);
      setChecked('notifyOnCrying', config.notifyOnCrying !== false);
      setChecked('notifyOnDisconnect', config.notifyOnDisconnect !== false);
      setChecked('notifyOnActivity', config.notifyOnActivity || false);

      if (config.ntfyTopic) {
        const tb = document.getElementById('testNotificationBtn');
        if (tb) tb.disabled = false;
      }
    } catch (error) {
      console.error('Failed to load notification config:', error);
    }
  }

  async saveConfig() {
    const topic = (document.getElementById('ntfyTopic')?.value || '').trim();
    const status = document.getElementById('notificationStatus');

    if (!topic) {
      if (status) { status.textContent = 'Please enter a topic'; status.style.color = '#f44336'; }
      return;
    }

    try {
      const ntfyServer = (document.getElementById('ntfyServer')?.value || '').trim() || null;
      const res = await fetch(`/api/rooms/${this.roomId}/ntfy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          ntfyServer: ntfyServer,
          enabled: document.getElementById('ntfyEnabled')?.checked,
          notifyOnCrying: document.getElementById('notifyOnCrying')?.checked,
          notifyOnDisconnect: document.getElementById('notifyOnDisconnect')?.checked,
          notifyOnActivity: document.getElementById('notifyOnActivity')?.checked,
        })
      });

      if (!res.ok) throw new Error('Failed to save');
      if (status) { status.textContent = 'Saved!'; status.style.color = '#4caf50'; }
      const tb = document.getElementById('testNotificationBtn');
      if (tb) tb.disabled = false;
      setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    } catch (error) {
      console.error('Failed to save notification config:', error);
      if (status) { status.textContent = 'Failed to save'; status.style.color = '#f44336'; }
    }
  }

  async testNotification() {
    const btn = document.getElementById('testNotificationBtn');
    const status = document.getElementById('notificationStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    try {
      const res = await fetch(`/api/rooms/${this.roomId}/ntfy/test`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      const result = await res.json();
      if (status) {
        status.textContent = result.success ? 'Test sent! Check your phone.' : 'Failed to send';
        status.style.color = result.success ? '#4caf50' : '#f44336';
      }
      setTimeout(() => { if (status) status.textContent = ''; }, 5000);
    } catch (error) {
      console.error('Failed to send test notification:', error);
      if (status) { status.textContent = 'Error sending'; status.style.color = '#f44336'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
    }
  }
}
