/**
 * Checks every JavaScript file of the app for syntax errors
 * (runs `node --check` on each one). Usage: npm run check
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.name.endsWith('.js')) files.push(full);
  }
};
walk(root);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('ok   ', path.relative(root, f));
  } catch (e) {
    failed++;
    console.log('FAIL ', path.relative(root, f));
    console.log(String(e.stderr || e.message));
  }
}
console.log(failed ? `\n${failed} file(s) have syntax errors.` : `\nAll ${files.length} files OK.`);
process.exit(failed ? 1 : 0);
