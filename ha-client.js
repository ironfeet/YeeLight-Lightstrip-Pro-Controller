/**
 * ha-client.js — Home Assistant REST API Wrapper
 * Token is passed in per-call (loaded from config, never stored here)
 * No secrets are logged.
 */

class HAClient {
  constructor(haUrl, token, entityId, timeoutMs = 5000) {
    this.haUrl = haUrl.replace(/\/$/, '');
    this.token = token;
    this.entityId = entityId;
    this.timeoutMs = timeoutMs;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  // Wraps the request via IPC to the main process so we bypass the strict CORS
  // enforcement of webSecurity: true, since HA APIs do not emit CORS headers.
  async _fetch(url, options = {}) {
    if (!window.electronAPI || !window.electronAPI.haRequest) {
      throw new Error('IPC proxy haRequest not available');
    }
    return window.electronAPI.haRequest(url, options, this.timeoutMs);
  }

  async getState() {
    const res = await this._fetch(`${this.haUrl}/api/states/${this.entityId}`, {
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`HA getState failed: ${res.status} ${res.error || ''}`);
    return res.data;
  }

  async setColor(r, g, b, brightness = 80) {
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    const bClamp = Math.max(0, Math.min(255, Math.round(brightness * 2.55)));
    const res = await this._fetch(`${this.haUrl}/api/services/light/turn_on`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        entity_id: this.entityId,
        rgb_color: [clamp(r), clamp(g), clamp(b)],
        brightness: bClamp,
        transition: 0.1,
      }),
    });
    if (!res.ok) throw new Error(`HA setColor failed: ${res.status} ${res.error || ''}`);
    return true;
  }

  async turnOn() {
    const res = await this._fetch(`${this.haUrl}/api/services/light/turn_on`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ entity_id: this.entityId }),
    });
    if (!res.ok) throw new Error(`HA turnOn failed: ${res.status} ${res.error || ''}`);
    return true;
  }

  async turnOff() {
    const res = await this._fetch(`${this.haUrl}/api/services/light/turn_off`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ entity_id: this.entityId }),
    });
    if (!res.ok) throw new Error(`HA turnOff failed: ${res.status} ${res.error || ''}`);
    return true;
  }
}
