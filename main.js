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

const { execSync } = require('child_process');

function isCommandExecuting(cmdStr) {
  if (!cmdStr) return false;
  try {
    const stdout = execSync('ps -axww -o command', { encoding: 'utf8', stdio: 'pipe' });
    const lines = stdout.split('\n');
    let sig = cmdStr.substring(0, 40).replace(/["'\\\n\r]/g, '').trim();
    if (!sig) return false;
    const escapedSig = sig.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    for (let line of lines) {
      if (line.includes('ps -axww')) continue;
      
      const cleanLine = line.replace(/["'\\\n\r]/g, '');
      const regex = new RegExp(`\\b${escapedSig}`);
      if (regex.test(cleanLine)) {
        return true;
      }
    }
    return false;
  } catch(e) {
    return false;
  }
}

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

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('[Config] Load error (non-sensitive):', e.message);
  }
  return { ...DEFAULT_CONFIG };
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

function classifyStatus(brainDir) {
  const transcript = findMostRecentTranscript(brainDir);
  if (!transcript) {
    return { state: 'offline', label: 'Offline', description: 'No conversations found' };
  }

  const ageMs = Date.now() - transcript.mtime;
  if (ageMs > 15 * 60 * 1000) {
    return { state: 'off', label: 'Off', description: 'Sleeping due to inactivity' };
  }
  if (ageMs > 5 * 60 * 1000) {
    return { state: 'inactive', label: 'Inactive', description: 'No activity in 5+ minutes' };
  }

  const lines = tailLines(transcript.path, 150);
  if (lines.length === 0) {
    return { state: 'idle', label: 'Idle', description: 'Waiting for your message' };
  }

  // ── Track Background Tasks ────────────────────────────────────────────────
  const startedTasks = new Map();
  const finishedTasks = new Set();
  for (const line of lines) {
    if (line.content && typeof line.content === 'string') {
      const startMatch = line.content.match(/Tool is running as a background task with task id: ([^\s\n]+)/);
      if (startMatch) {
        const taskId = startMatch[1];
        let desc = 'Background task';
        const descMatch = line.content.match(/Task Description:\s*(.+)/);
        if (descMatch && descMatch[1]) {
           desc = descMatch[1].trim();
           if (desc.length > 35) desc = desc.substring(0, 32) + '...';
        }
        startedTasks.set(taskId, desc);
      }
      
      const finishMatch = line.content.match(/Task id "([^"]+)" finished/);
      if (finishMatch) finishedTasks.add(finishMatch[1]);
    }
  }
  const activeTasks = [];
  for (const [id, desc] of startedTasks.entries()) {
    if (!finishedTasks.has(id)) activeTasks.push(desc);
  }

  const last = lines[lines.length - 1];
  const rawType  = last?.type   || '';
  const type     = rawType.toUpperCase();
  const source   = last?.source || '';
  const status   = last?.status || '';
  const toolCalls = last?.tool_calls || [];

  // ── Pending confirmation ──────────────────────────────────────────────────
  if (status === 'WAITING' || status === 'PENDING') {
    return { state: 'waiting', label: 'Waiting for You', description: 'A command is pending your approval' };
  }

  // ── Deterministic State Machine ───────────────────────────────────────────
  // If the agent is currently streaming text or executing a tool:
  if (status === 'RUNNING' || status === 'IN_PROGRESS') {
    if (['ASK_QUESTION', 'ASK_PERMISSION'].includes(type)) {
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your input' };
    }
    if (type === 'RUN_COMMAND' || type === 'DEFAULT_API:RUN_COMMAND') {
      let cmd = '';
      if (toolCalls.length > 0 && toolCalls[0].args && toolCalls[0].args.CommandLine) {
        cmd = toolCalls[0].args.CommandLine;
      }
      
      if (isCommandExecuting(cmd)) {
        return { state: 'running', label: 'Running', description: 'Executing terminal command' };
      }
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }
    return getActiveState(type, toolCalls);
  }

  // If the last step is DONE, we look at what it was to know what happens next:
  if (status === 'DONE') {
    // 1. If the user just typed, the agent is thinking of a response
    if (type === 'USER_INPUT') {
      return { state: 'thinking', label: 'Thinking', description: 'Processing your request' };
    }

    // 2. If the system just sent a message (e.g. task completed, error), the agent wakes up to think
    if (source === 'SYSTEM' || type.includes('MESSAGE')) {
      return { state: 'thinking', label: 'Thinking', description: 'Reading system update' };
    }

    // 3. The agent just requested a tool. It is either executing or blocked waiting for your permission.
    if (toolCalls.length > 0) {
      let actionName = (toolCalls[0]?.name || toolCalls[0]?.function?.name || '').toUpperCase();
      actionName = actionName.replace(/^DEFAULT_API:/, '');
      
    if (['ASK_QUESTION', 'ASK_PERMISSION'].includes(actionName)) {
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your input' };
    }
    if (actionName === 'RUN_COMMAND' || type === 'DEFAULT_API:RUN_COMMAND') {
      let cmd = '';
      if (toolCalls.length > 0 && toolCalls[0].args && toolCalls[0].args.CommandLine) {
        cmd = toolCalls[0].args.CommandLine;
      }
      
      // If the command is actively executing in the OS, show running.
      // If it's NOT executing yet, it's blocked by the IDE permission dialog, so show waiting.
      if (isCommandExecuting(cmd)) {
        return { state: 'running', label: 'Running', description: 'Executing terminal command' };
      }
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }
      // Any other tool sitting in PLANNER_RESPONSE (DONE) is waiting for user permission to execute
      return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
    }

    // 4. A tool just finished executing. The LLM is thinking about the result.
    if (isToolType(type) || type === 'CODE_ACTION') {
      return { state: 'thinking', label: 'Thinking', description: 'Thinking about the result' };
    }

    // 5. If the agent just finished outputting text WITH NO TOOLS, its turn is officially over.
    if (type === 'PLANNER_RESPONSE' || type === 'GENERIC') {
      if (activeTasks.length > 0) {
        const desc = activeTasks[0];
        const d = activeTasks.length === 1 ? desc : `${activeTasks.length} tasks: ${desc}`;
        return { state: 'running', label: 'Running', description: d };
      }
      return { state: 'idle', label: 'Idle', description: 'Waiting for your message' };
    }
  }

  // Fallback
  return { state: 'thinking', label: 'Thinking', description: 'Processing…' };
}

function isToolType(type) {
  const allTools = [
    'WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT',
    'RUN_COMMAND', 'MANAGE_TASK', 'MANAGE_SUBAGENTS',
    'VIEW_FILE', 'GREP_SEARCH', 'SEARCH_WEB', 'READ_URL_CONTENT', 'LIST_DIR', 'READ_URL', 'ASK_PERMISSION', 'LIST_PERMISSIONS',
    'INVOKE_SUBAGENT', 'SEND_MESSAGE', 'DEFINE_SUBAGENT',
    'GENERATE_IMAGE', 'ASK_QUESTION', 'CODE_ACTION'
  ];
  return allTools.includes(type);
}

function getActiveState(type, toolCalls) {
  const CODING   = ['WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT', 'CODE_ACTION'];
  const COMMAND  = ['RUN_COMMAND', 'MANAGE_TASK', 'MANAGE_SUBAGENTS'];
  const RESEARCH = ['VIEW_FILE', 'GREP_SEARCH', 'SEARCH_WEB', 'READ_URL_CONTENT', 'LIST_DIR', 'READ_URL', 'ASK_PERMISSION', 'LIST_PERMISSIONS'];
  const DELEGATE = ['INVOKE_SUBAGENT', 'SEND_MESSAGE', 'DEFINE_SUBAGENT'];
  const IMAGE    = ['GENERATE_IMAGE'];
  const CONFIRM  = ['ASK_QUESTION'];

  // Determine the primary action name
  let actionName = type.toUpperCase();
  if (toolCalls && toolCalls.length > 0) {
    actionName = (toolCalls[0]?.name || toolCalls[0]?.function?.name || '').toUpperCase();
    actionName = actionName.replace(/^DEFAULT_API:/, '');
  }

  if (CODING.includes(actionName))   return { state: 'coding',      label: 'Coding',      description: 'Editing files' };
  if (COMMAND.includes(actionName))  return { state: 'running',     label: 'Running',     description: 'Executing terminal command' };
  if (RESEARCH.includes(actionName)) return { state: 'researching', label: 'Researching', description: 'Gathering context' };
  if (DELEGATE.includes(actionName)) return { state: 'delegating',  label: 'Delegating',  description: 'Managing subagents' };
  if (IMAGE.includes(actionName))    return { state: 'thinking',    label: 'Generating',  description: 'Creating image' };
  if (CONFIRM.includes(actionName))  return { state: 'waiting',     label: 'Asking You',  description: 'Awaiting your answer' };

  if (toolCalls && toolCalls.length > 0) {
    return { state: 'thinking', label: 'Thinking', description: `Using tool: ${actionName.toLowerCase()}` };
  }

  return { state: 'thinking', label: 'Thinking', description: 'Generating response' };
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
