const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron'); // Mock it?
// Just copy classifyStatus
const main = fs.readFileSync('/Users/ironfeet/Projects/Light Strip Pro/main.js', 'utf8');
const classifyStatusMatch = main.match(/function classifyStatus\([\s\S]*?\n\n/);
