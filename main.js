/**
 * main.js — Electron Main Process for Light Strip Pro
 *
 * Security:
 *   - contextIsolation: true, nodeIntegration: false, sandbox: true
 *   - IPC surface limited to preload.js contextBridge
 *   - Config stored in user home dir, never hardcoded
 *   - No user input passed to shell or file paths
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');

const fs = require('fs');
const os = require('os');



const { spawnSync } = require('child_process');

// Disable GPU hardware acceleration to avoid sandbox crash on macOS
// (not needed for this app since we don't render 3D content)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');


// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'lightstrip-config.json');

const DEFAULT_CONFIG = {
  haUrl: 'http://192.168.31.179:8123',
  haToken: '',
  entityId: 'light.yeelink_strip8_3d99_light',
  mode1Interval: 1000,
  brightness: 80,
  saturationBoost: 1.2,
  colorThreshold: 15,

};

let currentConfig = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const loaded = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      currentConfig = loaded;
      return loaded;
    }
  } catch (e) {
    console.error('[Config] Load error (non-sensitive):', e.message);
  }
  currentConfig = { ...DEFAULT_CONFIG };
  return currentConfig;
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const allowed = Object.keys(DEFAULT_CONFIG);
    const sanitized = {};
    for (const key of allowed) {
      if (config[key] !== undefined) sanitized[key] = config[key];
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(sanitized, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[Config] Save error (non-sensitive):', e.message);
    return false;
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 400,
    minHeight: 620,
    resizable: true,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0A0A14',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.loadFile('index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// ─── IPC: Config ─────────────────────────────────────────────────────────────
ipcMain.handle('load-config', () => loadConfig());
ipcMain.handle('save-config', (_event, config) => saveConfig(config));

// ─── IPC: Window Controls ─────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

// ─── IPC: Mode 1 — Screen Capture ────────────────────────────────────────────
ipcMain.handle('capture-screen', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const thumbW = 160;
    const thumbH = Math.round(160 * height / width);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });

    if (!sources || sources.length === 0) return null;
    const thumbnail = sources[0].thumbnail;
    return {
      dataURL: thumbnail.toDataURL(),
      width: thumbnail.getSize().width,
      height: thumbnail.getSize().height,
    };
  } catch (e) {
    console.error('[ScreenCapture] Error (non-sensitive):', e.message);
    return null;
  }
});

// ─── Transcript Utils (shared by Modes 2 & 3) ────────────────────────────────
function findMostRecentTranscript(brainDir) {
  try {
    if (!fs.existsSync(brainDir)) return null;
    const entries = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const tp = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const stat = fs.statSync(tp);
          return { path: tp, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return entries.length > 0 ? entries[0] : null;
  } catch { return null; }
}

function tailLines(filePath, n = 150) {
  try {
    const buf = Buffer.alloc(32768);
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - 32768);
    const bytesRead = fs.readSync(fd, buf, 0, 32768, start);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString('utf-8');
    const lines = chunk.split('\n').filter(l => l.trim());
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function extractRecentLogs(lines) {
  const logs = [];
  for (const line of lines) {
    let ts = '';
    if (line.created_at) {
      const d = new Date(line.created_at);
      ts = '[' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0') + ']';
    }

    if (line.type === 'USER_INPUT') {
      logs.push(ts + ' 👤 ' + line.content.substring(0, 60).replace(/\n/g, ' '));
    } else if (line.tool_calls && line.tool_calls.length > 0) {
      for (const call of line.tool_calls) {
        let toolName = call.name || call.function?.name || 'tool';
        let summary = '';
        if (call.args) {
          try {
            summary = call.args.toolAction;
            if (summary && summary.startsWith('"') && summary.endsWith('"')) {
              summary = JSON.parse(summary);
            }
          } catch {}
        }
        logs.push(ts + ' 🛠️ ' + (summary || toolName));
      }
    } else if (line.type === 'MODEL_RESPONSE' && line.content) {
      let msg = line.content.replace(/\n/g, ' ').substring(0, 60);
      logs.push(ts + ' 🤖 ' + msg);
    }
  }
  return logs.slice(-20); // Return last 20 log events
}

function classifyStatus(brainDir) {
  const transcript = findMostRecentTranscript(brainDir);
  if (!transcript) {
    return { state: 'offline', label: 'Offline', description: 'No conversations found', logs: [] };
  }

  const ageMs = Date.now() - transcript.mtime;
  if (ageMs > 15 * 60 * 1000) {
    return { state: 'off', label: 'Off', description: 'Sleeping due to inactivity', logs: [] };
  }
  if (ageMs > 5 * 60 * 1000) {
    return { state: 'inactive', label: 'Inactive', description: 'No activity in 5+ minutes', logs: [] };
  }

  const lines = tailLines(transcript.path, 150);
  const logs = extractRecentLogs(lines);

  if (lines.length === 0) {
    return { state: 'idle', label: 'Idle', description: 'Waiting for your message', logs };
  }

  const status = classifyStatusFromLines(lines);
  return { ...status, logs };
}


// ── Tool classification maps ───────────────────────────────────────────────
const TOOL_STATES = {
  coding:      ['WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT', 'CODE_ACTION'],
  running:     ['RUN_COMMAND', 'MANAGE_TASK', 'MANAGE_SUBAGENTS'],
  researching: ['VIEW_FILE', 'GREP_SEARCH', 'SEARCH_WEB', 'READ_URL_CONTENT', 'LIST_DIR', 'READ_URL', 'LIST_PERMISSIONS'],
  delegating:  ['INVOKE_SUBAGENT', 'SEND_MESSAGE', 'DEFINE_SUBAGENT'],
  generating:  ['GENERATE_IMAGE'],
  waiting:     ['ASK_QUESTION', 'ASK_PERMISSION'],
};

const TOOL_LABELS = {
  coding:      { label: 'Coding',      description: 'Editing files' },
  running:     { label: 'Running',     description: 'Executing command' },
  researching: { label: 'Researching', description: 'Gathering context' },
  delegating:  { label: 'Delegating',  description: 'Managing subagents' },
  generating:  { label: 'Generating',  description: 'Creating image' },
  waiting:     { label: 'Waiting for You', description: 'Action pending your input' },
};

function toolNameToState(name) {
  const n = (name || '').toUpperCase().replace(/^DEFAULT_API:/, '');
  for (const [state, tools] of Object.entries(TOOL_STATES)) {
    if (tools.includes(n)) return state;
  }
  return null;
}

// Extract a short human-readable description from a tool call's args.
// Prefers toolSummary (noun phrase), then toolAction (verb phrase).
function extractToolDescription(toolCall) {
  try {
    const args = toolCall?.args || {};
    let desc = args.toolSummary || args.toolAction || '';
    // Args may be JSON-encoded strings (e.g. '"Read file"') — unwrap them
    if (typeof desc === 'string' && desc.startsWith('"') && desc.endsWith('"')) {
      desc = JSON.parse(desc);
    }
    if (typeof desc === 'string' && desc.length > 0) {
      // Trim to 50 chars for display
      return desc.length > 50 ? desc.substring(0, 47) + '...' : desc;
    }
  } catch {}
  return null;
}

// ── Core classifier ────────────────────────────────────────────────────────
// Key insight: every transcript entry has status=DONE because the file is
// written after completion. We therefore never see RUNNING/IN_PROGRESS.
// We use two strategies:
//   1. "Waiting" detection: find the last ask_permission/ask_question call
//      and check whether it has been answered yet (no GENERIC result after it).
//      This is time-UNBOUNDED so it works even if user sits on the dialog for minutes.
//   2. Active tool detection: 30-second recency window on recent tool entries.
const RECENCY_WINDOW_MS = 30_000;

function classifyStatusFromLines(lines) {
  if (!lines.length) return { state: 'idle', label: 'Idle', description: 'No activity' };

  const now = Date.now();
  const recent = lines.slice(-60);

  // --- Pass 1: Detect UNANSWERED ask_permission / ask_question ---
  // Walk backwards to find the most recent permission/question request.
  // If the entry right after it is NOT a GENERIC result (approved/denied),
  // the user is still waiting — regardless of how long ago it was asked.
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const t = (entry.type || '').toUpperCase();
    const tc = entry.tool_calls || [];

    const isPermissionCall = (
      (t === 'PLANNER_RESPONSE' && tc.length > 0 &&
        ['ASK_PERMISSION', 'ASK_QUESTION'].includes(
          (tc[0]?.name || tc[0]?.function?.name || '').toUpperCase().replace(/^DEFAULT_API:/, '')
        )
      )
    );

    if (isPermissionCall) {
      // Check if the next entry answers this (GENERIC result or USER_INPUT)
      const next = recent[i + 1];
      if (!next) {
        // Nothing after it — still waiting
        return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
      }
      const nextType = (next.type || '').toUpperCase();
      const nextContent = (next.content || '').toLowerCase();
      // GENERIC with "permission" in content = the answer arrived
      if (nextType === 'GENERIC' || nextType === 'USER_INPUT') {
        // Answered — stop looking for waiting state
        break;
      }
      // Any other type after the permission call = still pending
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }

    // If we hit a USER_INPUT before finding any permission call, user responded — stop
    if (t === 'USER_INPUT') break;
  }

  // --- Pass 2: Active tool in the last 30 seconds ---
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const age = now - new Date(entry.created_at || 0).getTime();
    if (age > RECENCY_WINDOW_MS) break;

    const t = (entry.type || '').toUpperCase();

    // PLANNER_RESPONSE with tool_calls = tool was dispatched
    if (t === 'PLANNER_RESPONSE' && entry.tool_calls && entry.tool_calls.length > 0) {
      const tc0 = entry.tool_calls[0];
      const toolName = (tc0?.name || tc0?.function?.name || '').toUpperCase().replace(/^DEFAULT_API:/, '');
      const state = toolNameToState(toolName);
      if (state && state !== 'waiting') {
        const base = TOOL_LABELS[state];
        const desc = extractToolDescription(tc0) || base.description;
        return { state, label: base.label, description: desc };
      }
    }

    // Tool result entry (RUN_COMMAND, VIEW_FILE, etc.) — look back one step for the dispatching PLANNER_RESPONSE
    const state = toolNameToState(t);
    if (state && state !== 'waiting') {
      const base = TOOL_LABELS[state];
      // The previous entry should be the PLANNER_RESPONSE that dispatched this tool
      const prev = recent[i - 1];
      const prevTc = prev?.tool_calls?.[0];
      const desc = extractToolDescription(prevTc) || base.description;
      return { state, label: base.label, description: desc };
    }
  }

  // --- Pass 3: Idle vs Thinking from the last entry ---
  const last = lines[lines.length - 1];
  const lastType = (last?.type || '').toUpperCase();
  const lastSource = last?.source || '';

  if (lastType === 'USER_INPUT') {
    return { state: 'thinking', label: 'Thinking', description: 'Processing your request' };
  }
  if (lastSource === 'SYSTEM' || lastType.includes('MESSAGE')) {
    return { state: 'thinking', label: 'Thinking', description: 'Processing…' };
  }
  if (lastType === 'PLANNER_RESPONSE' && (!last.tool_calls || last.tool_calls.length === 0)) {
    return { state: 'idle', label: 'Idle', description: 'Waiting for your message' };
  }

  return { state: 'thinking', label: 'Thinking', description: 'Processing…' };
}


// ─── IPC: Mode 2 — Antigravity App Agent Status ──────────────────────────────
const AG_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

ipcMain.handle('get-agent-status', () => classifyStatus(AG_BRAIN_DIR));

// ─── IPC: Mode 3 — Antigravity IDE Agent Status ───────────────────────────────
const IDE_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');

function isIDERunning() {
  try {
    const result = spawnSync(
      'pgrep', ['-f', 'Antigravity IDE.app/Contents/MacOS/Electron'],
      { timeout: 2000, encoding: 'utf-8' }
    );
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch { return false; }
}

ipcMain.handle('get-ide-status', () => {
  // First check if IDE is even open
  if (!isIDERunning()) {
    return { state: 'offline', label: 'IDE Closed', description: 'Antigravity IDE is not running' };
  }
  return classifyStatus(IDE_BRAIN_DIR);
});
