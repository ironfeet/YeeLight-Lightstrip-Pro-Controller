/**
 * main.js — Electron Main Process for Light Strip Pro
 *
 * Security:
 *   - contextIsolation: true, nodeIntegration: false, sandbox: true
 *   - IPC surface limited to preload.js contextBridge
 *   - Config stored in user home dir, never hardcoded
 *   - No user input passed to shell or file paths
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, nativeImage, Menu } = require('electron');
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

let tray = null;

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }
  createWindow();

  // Create Menu Bar Tray Icon
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Light Strip Pro');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });

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

// ─── IPC: Window & Tray Controls ──────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.on('update-tray', (event, dataURL) => {
  if (tray && dataURL) {
    tray.setImage(nativeImage.createFromDataURL(dataURL));
  }
});

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

let lastLoggedState = '';
let lastLoggedDesc = '';

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

  // LOG STATE CHANGES TO DESKTOP SO USER CAN VERIFY APP'S INTERNAL EVALUATION
  if (status.state !== lastLoggedState || status.description !== lastLoggedDesc) {
    try {
      const logFile = path.join(__dirname, 'agent_status_log.txt');
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] State: ${status.state.padEnd(10)} | Desc: ${status.description}\n`);
    } catch(e) {}
    lastLoggedState = status.state;
    lastLoggedDesc = status.description;
  }

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
// CRITICAL INSIGHTS from transcript analysis:
//   1. Every entry is status=DONE — file is only written AFTER steps complete.
//   2. WAITING for ask_permission: transcript ends with PLANNER_RESPONSE+ask_permission
//      followed by a GENERIC result. If no GENERIC follows → still waiting.
//   3. WAITING for run_command approval: transcript ends with PLANNER_RESPONSE+run_command
//      but NO subsequent RUN_COMMAND result — user is staring at the approval dialog.
//      Once approved, RUN_COMMAND appears immediately.
//   4. Active tools: use a 30s recency window on recent tool entries.
const RECENCY_WINDOW_MS = 600_000;
// How long a tool can be "dispatched but no result" before we assume it needs approval.
// Auto-approved tools (view_file, grep_search, replace_file_content) complete in <2s.
// If a PLANNER_RESPONSE+tool has been the last entry for >3s → approval pending.
const APPROVAL_PENDING_MS = 3_000;

// Tools that require explicit user approval before executing
const APPROVAL_REQUIRED_TOOLS = new Set([
  'RUN_COMMAND', 'UNSANDBOXED',
  'WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT'
]);

function classifyStatusFromLines(lines) {
  if (!lines.length) return { state: 'idle', label: 'Idle', description: 'No activity' };

  const now = Date.now();
  const recent = lines.slice(-60);

  const last = recent[recent.length - 1];
  const lastType = (last?.type || '').toUpperCase();
  const lastTc = last?.tool_calls || [];
  const lastToolName = (lastTc[0]?.name || lastTc[0]?.function?.name || '').toUpperCase().replace(/^DEFAULT_API:/, '');
  const lastAge = now - new Date(last?.created_at || 0).getTime();

  let debugReason = 'start';

  if (lastType === 'PLANNER_RESPONSE' && lastTc.length > 0) {
    if (lastToolName === 'ASK_PERMISSION' || lastToolName === 'ASK_QUESTION') {
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }

    if (lastAge > APPROVAL_PENDING_MS) {
      const desc = extractToolDescription(lastTc[0]) || 'Action pending your approval';
      return { state: 'waiting', label: 'Waiting for You', description: desc };
    }
  }

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const t = (entry.type || '').toUpperCase();
    const tc = entry.tool_calls || [];
    const toolName = (tc[0]?.name || tc[0]?.function?.name || '').toUpperCase().replace(/^DEFAULT_API:/, '');

    if (t === 'PLANNER_RESPONSE' && (toolName === 'ASK_PERMISSION' || toolName === 'ASK_QUESTION')) {
      const next = recent[i + 1];
      if (!next) {
        return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
      }
      const nextType = (next.type || '').toUpperCase();
      if (nextType === 'GENERIC' || nextType === 'USER_INPUT') {
        break; 
      }
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }

    if (t === 'USER_INPUT') break;
    if (t === 'RUN_COMMAND' && entry.status === 'DONE') break;
  }

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const age = now - new Date(entry.created_at || 0).getTime();
    if (age > RECENCY_WINDOW_MS) {
      debugReason = 'pass3_break_age_' + age;
      break;
    }

    const t = (entry.type || '').toUpperCase();

    if (t === 'PLANNER_RESPONSE' && entry.tool_calls && entry.tool_calls.length > 0) {
      const tc0 = entry.tool_calls[0];
      const toolName = (tc0?.name || tc0?.function?.name || '').toUpperCase().replace(/^DEFAULT_API:/, '');
      
      // If we see a dispatched command but haven't hit its result yet, it's blocked on user input!
      // (We removed the APPROVAL_REQUIRED_TOOLS filter because depending on user settings, even read tools like VIEW_FILE might prompt for approval).
      if (age > APPROVAL_PENDING_MS) {
        const desc = extractToolDescription(tc0) || 'Action pending your approval';
        return { state: 'waiting', label: 'Waiting for You', description: desc };
      }

      const state = toolNameToState(toolName);
      if (state && state !== 'waiting') {
        const base = TOOL_LABELS[state];
        const desc = extractToolDescription(tc0) || base.description;
        return { state, label: base.label, description: desc };
      }
    }

    const state = toolNameToState(t);
    if (state && state !== 'waiting') {
      if (entry.status && entry.status !== 'DONE' && entry.status !== 'ERROR') {
        continue;
      }
      const base = TOOL_LABELS[state];
      const prev = recent[i - 1];
      const prevTc = prev?.tool_calls?.[0];
      const desc = extractToolDescription(prevTc) || base.description;
      return { state, label: base.label, description: desc };
    }
  }

  if (lastType === 'USER_INPUT') {
    return { state: 'thinking', label: 'Thinking', description: 'Processing your request' };
  }
  if ((last?.source || '') === 'SYSTEM' || lastType.includes('MESSAGE')) {
    return { state: 'thinking', label: 'Thinking', description: 'Processing… (' + debugReason + ')' };
  }
  if (lastType === 'PLANNER_RESPONSE' && lastTc.length === 0) {
    return { state: 'idle', label: 'Idle', description: 'Waiting for your message' };
  }

  return { state: 'thinking', label: 'Thinking', description: 'Processing… (' + debugReason + ')' };
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
