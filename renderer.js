/**
 * renderer.js — UI Logic for Light Strip Pro
 *
 * Security notes:
 * - HA token never logged (uses masked display only)
 * - All DOM updates use textContent / safe element methods (no innerHTML with user data)
 * - Communicates with main process only via electronAPI contextBridge
 */

'use strict';

// ── State colours ─────────────────────────────────────────────────────────────
const STATE_COLORS = {
  coding:      [16,  185, 129],   // #10B981
  running:     [6,   182, 212],   // #06B6D4
  waiting:     [245, 158, 11],    // #F59E0B
  researching: [59,  130, 246],   // #3B82F6
  delegating:  [99,  102, 241],   // #6366F1
  thinking:    [139, 92,  246],   // #8B5CF6
  generating:  [236, 72,  153],   // #EC4899
  idle:        [148, 163, 184],   // #94A3B8
  inactive:    [120, 53,  15],    // #78350F
  offline:     [30,  41,  59],    // #1E293B
  off:         [0,   0,   0],     // #000000
};

function stateToRgb(state) {
  return STATE_COLORS[state] || STATE_COLORS.idle;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToCss(r, g, b) { return `rgb(${r},${g},${b})`; }

// ── Config ────────────────────────────────────────────────────────────────────
let config = {
  haUrl: 'http://192.168.31.179:8123',
  haToken: '',
  entityId: 'light.yeelink_strip8_3d99_light',
  mode1Interval: 1000,
  brightness: 80,
  saturationBoost: 1.2,
  colorThreshold: 15,
};

async function loadConfig() {
  try {
    const saved = await window.electronAPI.loadConfig();
    if (saved) config = { ...config, ...saved };
  } catch (e) {
    console.error('[Config] Failed to load (non-sensitive)');
  }
}

async function persistConfig() {
  try {
    await window.electronAPI.saveConfig(config);
  } catch (e) {
    console.error('[Config] Failed to save (non-sensitive)');
  }
}

// ── HA Client wrapper ─────────────────────────────────────────────────────────
function getHA() {
  return new HAClient(config.haUrl, config.haToken, config.entityId);
}

// ── Light state ───────────────────────────────────────────────────────────────
let lightOn = true;
let currentMode = 'screen';

// ── UI helpers ────────────────────────────────────────────────────────────────
function setAccentColor(r, g, b) {
  const css = rgbToCss(r, g, b);
  const hex = rgbToHex(r, g, b);
  document.getElementById('color-strip-inner').style.background = css;
  document.getElementById('color-strip-glow').style.background = css;
  document.getElementById('current-color-swatch').style.background = css;
  document.getElementById('current-color-label').textContent = hex;
  document.querySelector(':root').style.setProperty('--accent', css);
}

function updateStatusPanel(prefix, status) {
  const badge = document.getElementById(`${prefix}-badge`);
  const label = document.getElementById(`${prefix}-state-label`);
  const desc  = document.getElementById(`${prefix}-state-desc`);
  const block = document.getElementById(`${prefix}-color-block`);
  const logsDiv = document.getElementById(`${prefix}-logs`);

  if (label) label.textContent = status.label;
  if (desc)  desc.textContent  = status.description;

  if (logsDiv && status.logs) {
    // Build a change-detection key without using innerHTML with user data.
    const changeKey = status.logs.join('\n');
    if (logsDiv.dataset.changeKey !== changeKey) {
      logsDiv.dataset.changeKey = changeKey;
      // Build DOM nodes safely using textContent — never innerHTML — so that
      // user messages or tool summaries containing HTML characters cannot
      // inject markup or execute scripts.
      const fragment = document.createDocumentFragment();
      for (const l of status.logs) {
        const row = document.createElement('div');
        row.className = 'log-line';
        const parts = l.split('] ');
        if (parts.length > 1) {
          const ts = document.createElement('span');
          ts.className = 'timestamp';
          ts.textContent = parts[0] + ']';
          row.appendChild(ts);
          row.appendChild(document.createTextNode(' ' + parts.slice(1).join('] ')));
        } else {
          row.textContent = l;
        }
        fragment.appendChild(row);
      }
      logsDiv.replaceChildren(fragment);
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }
  }

  const [r, g, b] = stateToRgb(status.state);
  const css = rgbToCss(r, g, b);

  if (badge) {
    badge.style.background = css;
    badge.className = `status-badge badge-${status.state}`;
  }
  if (block) {
    block.style.background = css;
  }

  if (status.state === 'waiting') {
    if (badge) badge.classList.add('blinking');
    if (block) block.classList.add('blinking');
  } else {
    if (badge) badge.classList.remove('blinking');
    if (block) block.classList.remove('blinking');
  }
}

// ── Send colour to light ──────────────────────────────────────────────────────
let lastSentHash = '';
let currentR = 255, currentG = 255, currentB = 255;

function updateTrayIcon(r, g, b, isOn) {
  if (!window.electronAPI.updateTray) return;
  const canvas = document.createElement('canvas');
  // Revert to 22x22 canvas to prevent macOS from cropping the edges
  canvas.width = 22;
  canvas.height = 22;
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, 22, 22);
  ctx.beginPath();
  // Draw a circle with radius 9 (diameter 18) to leave a 2px safe margin
  ctx.arc(11, 11, 9, 0, 2 * Math.PI);
  
  if (isOn) {
    ctx.fillStyle = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  } else {
    ctx.fillStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#333';
  }
  ctx.fill();
  ctx.stroke();
  
  window.electronAPI.updateTray(canvas.toDataURL('image/png'));
}

let lastSentR = -1, lastSentG = -1, lastSentB = -1, lastSentBright = -1;
let lastMeaningfulChangeTime = Date.now();
let screenAutoOffTriggered = false;

async function sendColor(r, g, b, scaleLuminance = false) {
  currentR = r; currentG = g; currentB = b;
  updateTrayIcon(r, g, b, lightOn);

  // Always update the UI preview strip immediately
  setAccentColor(r, g, b);

  let targetBrightness = config.brightness;
  if (scaleLuminance) {
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const scale = Math.max(0.05, luminance);
    targetBrightness = Math.round(config.brightness * scale);
  }

  if (!lightOn || !config.haToken) return targetBrightness;

  // Utilize the colorThreshold setting to prevent network spam for microscopic color changes
  const threshold = config.colorThreshold || 15;
  const colorDiff = Math.abs(r - lastSentR) + Math.abs(g - lastSentG) + Math.abs(b - lastSentB);
  
  if (colorDiff < threshold && Math.abs(targetBrightness - lastSentBright) < 5) {
    // Screen Mode Auto-Off: If the color hasn't changed meaningfully in 10 minutes, turn it off
    if (currentMode === 'screen' && !screenAutoOffTriggered) {
      if (Date.now() - lastMeaningfulChangeTime > 10 * 60 * 1000) {
        screenAutoOffTriggered = true;
        getHA().turnOff().catch(() => {});
        console.log('[Mode1] 10 minute inactivity reached. Turning light off.');
      }
    }
    return targetBrightness; // Changes are below user threshold, debounce
  }

  // A meaningful color change occurred!
  // Only track this for the screen auto-off timer — agent/IDE mode color
  // changes must not reset the screen inactivity clock.
  if (currentMode === 'screen') {
    lastMeaningfulChangeTime = Date.now();
    screenAutoOffTriggered = false;
  }

  try {
    if (r === 0 && g === 0 && b === 0) {
      await getHA().turnOff();
    } else {
      await getHA().setColor(r, g, b, targetBrightness);
    }
    lastSentR = r; lastSentG = g; lastSentB = b; lastSentBright = targetBrightness;
    
    // Clear connection error if it was showing
    const errBanner = document.getElementById('connection-error');
    if (errBanner) errBanner.classList.add('hidden');
  } catch (e) {
    console.error('[HA] request failed (non-sensitive):', e.message);
    const errBanner = document.getElementById('connection-error');
    if (errBanner) errBanner.classList.remove('hidden');
  }

  return targetBrightness;
}

// ── Mode 1: Screen Ambient ────────────────────────────────────────────────────
const canvas  = document.createElement('canvas');
const ctx     = canvas.getContext('2d', { willReadFrequently: true });
let mode1Timer = null;

// ── Color Utilities ───────────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

/**
 * Extract an Ambilight-style ambient color from the screen.
 * Averages the entire screen to create a highly responsive ambient glow.
 */
function extractVibrantColor(imageData, width, height) {
  const data = imageData.data;
  const STEP = Math.max(1, Math.floor(Math.min(width, height) / 32)); 

  let sumR = 0, sumG = 0, sumB = 0;
  let count = 0;

  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      // Skip pure black pixels (letterboxing in movies, etc)
      if (luminance < 10) continue;

      // Weight brighter pixels more so the ambient light glows
      const weight = 1 + (luminance / 255); 
      
      sumR += r * weight;
      sumG += g * weight;
      sumB += b * weight;
      count += weight;
    }
  }

  if (count === 0) return null;

  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;

  let [h, s, l] = rgbToHsl(avgR, avgG, avgB);

  // Averaging inherently desaturates, so we boost saturation heavily
  s = Math.min(1, s * (config.saturationBoost || 2.0)); 
  s = Math.max(0.4, s); // Ensure it's not totally washed out
  
  // Keep lightness in a nice glowing range
  l = Math.max(0.3, Math.min(0.7, l));

  return hslToRgb(h, s, l);
}

async function captureAndSend() {
  try {
    const frame = await window.electronAPI.captureScreen();
    if (!frame) return;

    const img = new Image();
    // Update the live preview image if visible
    const previewImg = document.getElementById('screen-capture-img');
    if (previewImg && document.getElementById('screen-show-preview').checked) {
      previewImg.src = frame.dataURL;
    }
    
    img.onload = async () => {
      canvas.width  = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const result = extractVibrantColor(imageData, img.width, img.height);

      if (!result) return; // featureless frame, skip

      const [r, g, b] = result;

      // Update screen panel UI
      const hex = rgbToHex(r, g, b);
      document.getElementById('screen-color-preview').style.background = rgbToCss(r, g, b);
      document.getElementById('screen-hex').textContent = hex;
      document.getElementById('screen-rgb').textContent = `rgb(${r}, ${g}, ${b})`;

      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const scale = Math.max(0.05, luminance);
      const targetBrightness = Math.round(config.brightness * scale);
      const bEl = document.getElementById('screen-brightness');
      if (bEl) bEl.textContent = `Brightness: ${targetBrightness}%`;

      sendColor(r, g, b, true);
    };
    img.src = frame.dataURL;
  } catch (e) {
    console.error('[Mode1] Capture error (non-sensitive):', e.message);
  }
}


function startMode1() {
  stopMode1();
  captureAndSend();
  mode1Timer = setInterval(captureAndSend, config.mode1Interval || 1000);
}
function stopMode1() {
  if (mode1Timer) { clearInterval(mode1Timer); mode1Timer = null; }
}

// ── Mode 2: Antigravity AI Agent ──────────────────────────────────────────────
let mode2Timer = null;
let mode2Interval = 500; // matches the HTML slider default (value="500")

async function pollAgentStatus() {
  try {
    const status = await window.electronAPI.getAgentStatus();
    updateStatusPanel('agent', status);

    if (currentMode === 'agent') {
      const [r, g, b] = stateToRgb(status.state);
      sendColor(r, g, b);
    }
  } catch (e) {
    console.error('[Mode2] Poll error (non-sensitive):', e.message);
  }
}

function startMode2() {
  stopMode2();
  pollAgentStatus();
  mode2Timer = setInterval(pollAgentStatus, mode2Interval);
}
function stopMode2() {
  if (mode2Timer) { clearInterval(mode2Timer); mode2Timer = null; }
}

// ── Mode 3: Antigravity IDE Agent ─────────────────────────────────────────────
let mode3Timer = null;
let mode3Interval = 1000;

async function pollIDEStatus() {
  try {
    const status = await window.electronAPI.getIDEStatus();
    updateStatusPanel('ide', status);

    if (currentMode === 'ide') {
      const [r, g, b] = stateToRgb(status.state);
      sendColor(r, g, b);
    }
  } catch (e) {
    console.error('[Mode3] Poll error (non-sensitive):', e.message);
  }
}

function startMode3() {
  stopMode3();
  pollIDEStatus();
  mode3Timer = setInterval(pollIDEStatus, mode3Interval);
}
function stopMode3() {
  if (mode3Timer) { clearInterval(mode3Timer); mode3Timer = null; }
}

// ── Mode Switching ────────────────────────────────────────────────────────────
function activateMode(mode) {
  currentMode = mode;
  lastSentR = -1; lastSentG = -1; lastSentB = -1; // force resend on mode switch
  lastMeaningfulChangeTime = Date.now(); // reset auto-off timer
  screenAutoOffTriggered = false;

  // Sync state back to the Tray Menu
  window.electronAPI.updateModeState(mode);

  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.mode === mode;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });

  // Panels
  document.querySelectorAll('.mode-panel').forEach(p => {
    p.classList.remove('active');
  });
  const panel = document.getElementById(`panel-${mode}`);
  if (panel) panel.classList.add('active');

  // Stop all timers first, then start only the one for the active mode.
  // This ensures at most one polling loop runs at any time.
  stopMode1();
  stopMode2();
  stopMode3();

  if (mode === 'screen') startMode1();
  else if (mode === 'agent') startMode2();
  else if (mode === 'ide') startMode3();
}

// ── Power Toggle ──────────────────────────────────────────────────────────────
function setLightOn(on) {
  lightOn = on;
  updateTrayIcon(currentR, currentG, currentB, lightOn);
  
  const toggle = document.getElementById('power-toggle');
  const label  = document.getElementById('power-label');
  toggle.setAttribute('aria-checked', String(on));
  label.textContent = on ? 'ON' : 'OFF';

  if (on) {
    getHA().turnOn().catch(() => {});
  } else {
    getHA().turnOff().catch(() => {});
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
function populateSettings() {
  document.getElementById('ha-url').value    = config.haUrl || '';
  document.getElementById('ha-token').value  = config.haToken || '';
  document.getElementById('ha-entity').value = config.entityId || '';
  const brightEl = document.getElementById('brightness-pct');
  brightEl.value = config.brightness || 80;
  document.getElementById('brightness-val').textContent = `${brightEl.value}%`;
  showTokenStatus();
}

function showTokenStatus() {
  const token = config.haToken || '';
  const statusEl = document.getElementById('token-status');
  if (!token) {
    statusEl.textContent = 'No token set';
    return;
  }
  // Mask: show first 4 + last 4 chars
  const masked = token.length > 10
    ? token.slice(0, 4) + '***' + token.slice(-4)
    : '***';
  statusEl.textContent = `Token: ${masked}`;
}

function setSettingsStatus(msg, type = '') {
  const el = document.getElementById('settings-status');
  el.textContent = msg;
  el.className = `settings-status ${type}`;
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function bindEvents() {
  // UI Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      activateMode(t.dataset.mode);
      config.appMode = t.dataset.mode;
      persistConfig();
    });
  });

  // Tray Menu Sync
  window.electronAPI.onSetMode((event, mode) => {
    activateMode(mode);
    config.appMode = mode;
    persistConfig();
  });

  // Power toggle
  const powerToggle = document.getElementById('power-toggle');
  powerToggle.addEventListener('click', () => setLightOn(!lightOn));
  powerToggle.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setLightOn(!lightOn); }
  });

  // Mode 1 sliders
  const screenInterval = document.getElementById('screen-interval');
  screenInterval.addEventListener('input', () => {
    config.mode1Interval = parseInt(screenInterval.value);
    document.getElementById('screen-interval-val').textContent =
      (config.mode1Interval / 1000).toFixed(1) + 's';
    if (currentMode === 'screen') startMode1();
  });

  document.getElementById('screen-saturation').addEventListener('input', function () {
    config.saturationBoost = parseFloat(this.value);
    document.getElementById('screen-saturation-val').textContent = config.saturationBoost.toFixed(2) + '×';
  });

  document.getElementById('screen-threshold').addEventListener('input', function () {
    config.colorThreshold = parseInt(this.value);
    document.getElementById('screen-threshold-val').textContent = this.value;
  });

  document.getElementById('screen-show-preview').addEventListener('change', function () {
    document.getElementById('screen-capture-wrap').classList.toggle('visible', this.checked);
  });

  // Mode 2 interval
  document.getElementById('agent-interval').addEventListener('input', function () {
    mode2Interval = parseInt(this.value);
    config.mode2Interval = mode2Interval;
    document.getElementById('agent-interval-val').textContent = (mode2Interval / 1000).toFixed(1) + 's';
    if (currentMode === 'agent') startMode2();
  });

  // Mode 3 interval
  document.getElementById('ide-interval').addEventListener('input', function () {
    mode3Interval = parseInt(this.value);
    config.mode3Interval = mode3Interval;
    document.getElementById('ide-interval-val').textContent = (mode3Interval / 1000).toFixed(1) + 's';
    if (currentMode === 'ide') startMode3();
  });

  // Settings: show/hide token
  let tokenVisible = false;
  document.getElementById('btn-show-token').addEventListener('click', () => {
    tokenVisible = !tokenVisible;
    document.getElementById('ha-token').type = tokenVisible ? 'text' : 'password';
  });

  // Brightness slider
  document.getElementById('brightness-pct').addEventListener('input', function () {
    config.brightness = parseInt(this.value);
    document.getElementById('brightness-val').textContent = `${this.value}%`;
  });

  // Test connection
  document.getElementById('btn-test-ha').addEventListener('click', async () => {
    setSettingsStatus('Testing…');
    const testToken = document.getElementById('ha-token').value;
    const testUrl   = document.getElementById('ha-url').value;
    const testEnt   = document.getElementById('ha-entity').value;
    const ha = new HAClient(testUrl, testToken, testEnt);
    try {
      const state = await ha.getState();
      setSettingsStatus(`✓ Connected — light is ${state.state}`, 'ok');
    } catch (e) {
      setSettingsStatus('✗ Connection failed — check URL and token', 'error');
    }
  });

  // Save settings
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    config.haUrl     = document.getElementById('ha-url').value.trim();
    config.haToken   = document.getElementById('ha-token').value.trim();
    config.entityId  = document.getElementById('ha-entity').value.trim();
    config.brightness = parseInt(document.getElementById('brightness-pct').value);

    await persistConfig();
    showTokenStatus();
    setSettingsStatus('Settings saved', 'ok');
    setTimeout(() => setSettingsStatus(''), 2000);
  });

  // Check for updates
  document.getElementById('btn-check-update').addEventListener('click', async () => {
    const statusEl = document.getElementById('update-status');
    statusEl.textContent = 'Checking GitHub...';
    statusEl.style.color = 'var(--text-dim)';
    try {
      const res = await window.electronAPI.haRequest(
        'https://api.github.com/repos/ironfeet/YeeLight-Lightstrip-Pro-Controller/releases/latest',
        { headers: { 'User-Agent': 'YeeLight-Controller' } },
        5000
      );
      if (res && res.ok && res.data && res.data.tag_name) {
        const currentVersion = await window.electronAPI.getAppVersion();
        const latestVersion = res.data.tag_name.replace(/^v/, '');
        
        const isNewerVersion = (v1, v2) => {
          const p1 = v1.split('.').map(Number);
          const p2 = v2.split('.').map(Number);
          for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
            const n1 = p1[i] || 0;
            const n2 = p2[i] || 0;
            if (n1 > n2) return true;
            if (n1 < n2) return false;
          }
          return false;
        };

        if (isNewerVersion(latestVersion, currentVersion)) {
          statusEl.textContent = `New update available! (v${latestVersion})`;
          statusEl.style.color = 'var(--status-ok)';
        } else {
          statusEl.textContent = 'You are on the latest version!';
          statusEl.style.color = 'var(--text-dim)';
        }
      } else {
        statusEl.textContent = 'Failed to fetch releases';
        statusEl.style.color = 'var(--status-err)';
      }
    } catch (e) {
      statusEl.textContent = 'Error checking for updates';
      statusEl.style.color = 'var(--status-err)';
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadConfig();
  populateSettings();
  bindEvents();

  const appVersion = await window.electronAPI.getAppVersion();
  document.getElementById('app-version-label').textContent = `Version v${appVersion}`;

  // Sync slider UI values from config
  document.getElementById('screen-interval').value = config.mode1Interval || 1000;
  document.getElementById('screen-interval-val').textContent =
    ((config.mode1Interval || 1000) / 1000).toFixed(1) + 's';
  document.getElementById('screen-saturation').value = config.saturationBoost || 1.2;
  document.getElementById('screen-saturation-val').textContent =
    (config.saturationBoost || 1.2).toFixed(2) + '×';
  document.getElementById('screen-threshold').value = config.colorThreshold || 15;
  document.getElementById('screen-threshold-val').textContent = config.colorThreshold || 15;
  document.getElementById('brightness-pct').value = config.brightness || 80;
  document.getElementById('brightness-val').textContent = `${config.brightness || 80}%`;

  // Restore agent and IDE poll intervals from config
  mode2Interval = config.mode2Interval || 500;
  document.getElementById('agent-interval').value = mode2Interval;
  document.getElementById('agent-interval-val').textContent = (mode2Interval / 1000).toFixed(1) + 's';
  mode3Interval = config.mode3Interval || 1000;
  document.getElementById('ide-interval').value = mode3Interval;
  document.getElementById('ide-interval-val').textContent = (mode3Interval / 1000).toFixed(1) + 's';

  // activateMode handles starting the correct timer — no need to pre-start all modes.
  activateMode(config.appMode || 'agent');
}

document.addEventListener('DOMContentLoaded', init);
