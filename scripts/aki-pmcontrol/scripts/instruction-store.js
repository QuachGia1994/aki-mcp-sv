const fs = require('fs');
const path = require('path');

function readNonEmpty(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.trim() ? text : null;
  } catch (e) {
    return null;
  }
}

// DESIGN LOCK: this loads the provider instruction injected into the AI (e.g. assets/prompts/postman.md). That prompt must keep its two hard-lock lines — "Always use subagent shell or Aki MCP tool cmd run instead of readFile." and "Fall back to subagent shell if run_cmd is not efficient." — do not let a prompt trim drop them (regression: commit 40008be).
function loadInstruction(sourcePaths) {
  for (const p of sourcePaths) {
    const text = readNonEmpty(p);
    if (text) return text;
  }
  return '';
}

function saveInstruction(userPath, text) {
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, String(text), 'utf8');
}

function copyDefaultIfMissing(destPath, srcPath) {
  if (readNonEmpty(destPath)) return;
  if (!fs.existsSync(srcPath)) return;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
}

module.exports = { loadInstruction, saveInstruction, copyDefaultIfMissing };
