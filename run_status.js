const os = require('os');
const path = require('path');
const fs = require('fs');

function findMostRecentTranscript(brainDir) {
  if (!fs.existsSync(brainDir)) return null;
  const dirs = fs.readdirSync(brainDir);
  let latestDir = null;
  let latestTime = 0;

  for (const d of dirs) {
    const transcriptPath = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(transcriptPath)) {
      const stats = fs.statSync(transcriptPath);
      if (stats.mtimeMs > latestTime) {
        latestTime = stats.mtimeMs;
        latestDir = transcriptPath;
      }
    }
  }
  return latestDir ? { path: latestDir, mtime: latestTime } : null;
}

function tailLines(filePath, numLines) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  return lines.slice(-numLines).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Just copy paste the classifyStatus body manually for testing:
const mainContent = fs.readFileSync('./main.js', 'utf8');
// Just run it by exporting classifyStatus? No, let's just extract it via regex or require
