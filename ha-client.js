/**
 * ha-client.js — Home Assistant REST API Wrapper
 * Token is passed in per-call (loaded from config, never stored here)
 * No secrets are logged.
 */

class HAClient {
  constructor(haUrl, token, entityId) {
    this.haUrl = haUrl.replace(/\/$/, '');
    this.token = token;
    this.entityId = entityId;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async getState() {
    const res = await fetch(`${this.haUrl}/api/states/${this.entityId}`, {
      headers: this._headers(),
    });
    if (!res.ok) throw new Error(`HA getState failed: ${res.status}`);
    return res.json();
  }

  async setColor(r, g, b, brightness = 80) {
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    const bClamp = Math.max(0, Math.min(255, Math.round(brightness * 2.55)));
    const res = await fetch(`${this.haUrl}/api/services/light/turn_on`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        entity_id: this.entityId,
        rgb_color: [clamp(r), clamp(g), clamp(b)],
        brightness: bClamp,
        transition: 0.1,
      }),
    });
    if (!res.ok) throw new Error(`HA setColor failed: ${res.status}`);
    return true;
  }

  async turnOn() {
    const res = await fetch(`${this.haUrl}/api/services/light/turn_on`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ entity_id: this.entityId }),
    });
    if (!res.ok) throw new Error(`HA turnOn failed: ${res.status}`);
    return true;
  }

  async turnOff() {
    const res = await fetch(`${this.haUrl}/api/services/light/turn_off`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ entity_id: this.entityId }),
    });
    if (!res.ok) throw new Error(`HA turnOff failed: ${res.status}`);
    return true;
  }
}
