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

// ── Core classifier ────────────────────────────────────────────────────────
// Key insight: every transcript entry has status=DONE because the file is
// written after completion. We therefore never see RUNNING/IN_PROGRESS.
// Instead we scan the last N entries by created_at timestamp and use a
// 30-second recency window to determine the current state.
const RECENCY_WINDOW_MS = 30_000;

function classifyStatusFromLines(lines) {
  if (!lines.length) return { state: 'idle', label: 'Idle', description: 'No activity' };

  const now = Date.now();

  // Walk backwards through the last 40 entries looking for signals
  const recent = lines.slice(-40);

  // --- Pass 1: scan for waiting (ask_permission / ask_question) ---
  // These are highest priority — user must respond before anything else.
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const age = now - new Date(entry.created_at || 0).getTime();
    if (age > RECENCY_WINDOW_MS) break; // older than window, stop

    // PLANNER_RESPONSE with ask_permission/ask_question tool calls
    if (entry.tool_calls && entry.tool_calls.length > 0) {
      const state = toolNameToState(entry.tool_calls[0]?.name || entry.tool_calls[0]?.function?.name);
      if (state === 'waiting') {
        return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your input' };
      }
    }
    // Tool result type is ASK_PERMISSION
    const t = (entry.type || '').toUpperCase();
    if (t === 'ASK_PERMISSION' || t === 'ASK_QUESTION') {
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your input' };
    }
  }

  // --- Pass 2: find the most recent active tool action within the window ---
  let bestActiveState = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const age = now - new Date(entry.created_at || 0).getTime();
    if (age > RECENCY_WINDOW_MS) break;

    const t = (entry.type || '').toUpperCase();

    // A PLANNER_RESPONSE with tool_calls means a tool was just dispatched
    if (t === 'PLANNER_RESPONSE' && entry.tool_calls && entry.tool_calls.length > 0) {
      const toolName = entry.tool_calls[0]?.name || entry.tool_calls[0]?.function?.name || '';
      const state = toolNameToState(toolName);
      if (state && state !== 'waiting') {
        bestActiveState = { state, ...TOOL_LABELS[state] };
        break;
      }
    }

    // A tool result entry (e.g. RUN_COMMAND, VIEW_FILE) means the tool ran
    const state = toolNameToState(t);
    if (state && state !== 'waiting') {
      bestActiveState = { state, ...TOOL_LABELS[state] };
      break;
    }
  }

  if (bestActiveState) return bestActiveState;

  // --- Pass 3: determine idle vs thinking from the very last entry ---
  const last = lines[lines.length - 1];
  const lastType = (last?.type || '').toUpperCase();
  const lastSource = last?.source || '';

  // User just sent a message → agent is thinking
  if (lastType === 'USER_INPUT') {
    return { state: 'thinking', label: 'Thinking', description: 'Processing your request' };
  }

  // System ephemeral message → agent is being briefed, about to act
  if (lastSource === 'SYSTEM' || lastType.includes('MESSAGE')) {
    return { state: 'thinking', label: 'Thinking', description: 'Processing…' };
  }

  // PLANNER_RESPONSE with no tools and no recent tool activity → truly idle
  if (lastType === 'PLANNER_RESPONSE' && (!last.tool_calls || last.tool_calls.length === 0)) {
    return { state: 'idle', label: 'Idle', description: 'Waiting for your message' };
  }

  // Default: still thinking/working
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
