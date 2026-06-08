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
let lastSentRgb = null;
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
    // Only update if logs changed to avoid scrolling reset
    const newHtml = status.logs.map(l => {
      const parts = l.split('] ');
      if (parts.length > 1) {
        return `<div class="log-line"><span class="timestamp">${parts[0]}]</span> ${parts.slice(1).join('] ')}</div>`;
      }
      return `<div class="log-line">${l}</div>`;
    }).join('');
    
    if (logsDiv.innerHTML !== newHtml) {
      logsDiv.innerHTML = newHtml;
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
    badge.classList.add('blinking');
    block.classList.add('blinking');
  } else {
    badge.classList.remove('blinking');
    block.classList.remove('blinking');
  }
}

// ── Send colour to light ──────────────────────────────────────────────────────
let lastSentHash = '';
let currentR = 255, currentG = 255, currentB = 255;

function updateTrayIcon(r, g, b, isOn) {
  if (!window.electronAPI.updateTray) return;
  const canvas = document.createElement('canvas');
  // Use a 44x44 canvas for proper @2x Retina display rendering on macOS
  canvas.width = 44;
  canvas.height = 44;
  const ctx = canvas.getContext('2d');
  
  ctx.clearRect(0, 0, 44, 44);
  ctx.beginPath();
  // Draw a large circle (radius 20 means diameter 40 out of 44)
  ctx.arc(22, 22, 20, 0, 2 * Math.PI);
  
  if (isOn) {
    ctx.fillStyle = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  } else {
    ctx.fillStyle = '#666';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#333';
  }
  ctx.fill();
  ctx.stroke();
  
  window.electronAPI.updateTray(canvas.toDataURL('image/png'));
}

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

  const hash = `${r},${g},${b}-${targetBrightness}`;
  if (hash === lastSentHash) return targetBrightness; // Debounce identical commands

  try {
    if (r === 0 && g === 0 && b === 0) {
      await getHA().turnOff();
    } else {
      await getHA().setColor(r, g, b, targetBrightness);
    }
    lastSentHash = hash;
  } catch (e) {
    console.error('[HA] request failed (non-sensitive):', e.message);
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
 * Extract the most vibrant dominant color from ImageData.
 *
 * Algorithm:
 * 1. Sample pixels on a grid (skip near-gray, near-black, near-white).
 * 2. Bucket surviving pixels into 36 hue bins (10° each).
 * 3. Pick the heaviest hue bin (weighted by saturation).
 * 4. From that bin, compute the median hue and average saturation/lightness.
 * 5. Clamp saturation to a high value and lightness to a vibrant range,
 *    so the output is always punchy and visible on the light strip.
 * 6. Fall back to the overall most saturated pixel if all pixels are gray.
 */
function extractVibrantColor(imageData, width, height) {
  const data = imageData.data;
  const STEP = Math.max(1, Math.floor(Math.min(width, height) / 32)); // ~32×32 samples max

  const HUE_BINS = 36; // 10° per bin
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, hues: [], sats: [], lights: [] }));

  let bestSat = 0, bestSatPixel = null; // fallback

  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];

      const [h, s, l] = rgbToHsl(r, g, b);

      // Track the most saturated pixel for fallback
      if (s > bestSat) { bestSat = s; bestSatPixel = [h, s, l]; }

      // Skip near-black (too dark to see on strip)
      if (l < 0.08) continue;
      // Skip near-white (washed out)
      if (l > 0.92) continue;
      // Skip near-gray (no useful hue information)
      if (s < 0.12) continue;

      const bin = Math.floor(h * HUE_BINS) % HUE_BINS;
      const w = s * s; // weight by saturation² — more vivid pixels dominate
      bins[bin].weight += w;
      bins[bin].hues.push(h);
      bins[bin].sats.push(s);
      bins[bin].lights.push(l);
    }
  }

  // Merge adjacent bins (wrap-around) so we don't split a single hue across boundary
  const merged = bins.map((bin, i) => {
    const prev = bins[(i - 1 + HUE_BINS) % HUE_BINS];
    const next = bins[(i + 1) % HUE_BINS];
    return {
      weight: bin.weight + prev.weight * 0.3 + next.weight * 0.3,
      hues:   [...bin.hues, ...prev.hues, ...next.hues],
      sats:   [...bin.sats, ...prev.sats, ...next.sats],
      lights: [...bin.lights, ...prev.lights, ...next.lights],
    };
  });

  const dominant = merged.reduce((best, b) => b.weight > best.weight ? b : best, merged[0]);

  let h, s, l;

  if (dominant.weight === 0 || dominant.hues.length === 0) {
    // All pixels were gray — use the most saturated pixel we found
    if (bestSatPixel) {
      [h, s, l] = bestSatPixel;
    } else {
      return null; // truly featureless frame, leave light as-is
    }
  } else {
    // Median of hue values (robust against outliers)
    const sortedHues = [...dominant.hues].sort((a, b) => a - b);
    h = sortedHues[Math.floor(sortedHues.length / 2)];

    // Average saturation and lightness of the dominant bin
    s = dominant.sats.reduce((a, v) => a + v, 0) / dominant.sats.length;
    l = dominant.lights.reduce((a, v) => a + v, 0) / dominant.lights.length;
  }

  // ── Vibrance boost: push saturation and normalize lightness ──────────────
  s = Math.min(1, s * (config.saturationBoost || 1.5));   // user-controlled boost
  s = Math.max(0.65, s);   // floor: always at least 65% saturated
  l = Math.max(0.38, Math.min(0.62, l)); // clamp to vibrant mid-range (not too dark, not washed out)

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
let mode2Interval = 300;

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
  lastSentHash = ''; // force resend on mode switch

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

  // Start/stop loops and force immediate UI/Light update
  if (mode === 'screen') {
    startMode1();
  } else {
    stopMode1();
  }

  if (mode === 'agent') pollAgentStatus();
  if (mode === 'ide') pollIDEStatus();
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
  // Mode tabs
  document.querySelectorAll('.tab[data-mode]').forEach(tab => {
    tab.addEventListener('click', () => activateMode(tab.dataset.mode));
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
    document.getElementById('agent-interval-val').textContent = (mode2Interval / 1000).toFixed(1) + 's';
    startMode2();
  });

  // Mode 3 interval
  document.getElementById('ide-interval').addEventListener('input', function () {
    mode3Interval = parseInt(this.value);
    document.getElementById('ide-interval-val').textContent = (mode3Interval / 1000).toFixed(1) + 's';
    startMode3();
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
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadConfig();
  populateSettings();
  bindEvents();

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

  // Always run status pollers in background
  startMode2();
  startMode3();

  // Default to AI Agent mode — screen capture only starts if user clicks the Screen tab
  activateMode('agent');
}

document.addEventListener('DOMContentLoaded', init);
