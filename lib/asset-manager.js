// ─── BBits Studio — asset-manager.js ─────────────────────────────────────────
// Replaces asset paths in JSX scene files.
// Creates .bak backups before modifying any file.
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Replace all occurrences of oldPath with newPath across all scene JSX files in projectDir.
 * Creates a .bak copy of each modified file before writing.
 * @returns {string[]} List of files that were modified.
 */
function replaceAssetPath(projectDir, oldPath, newPath) {
  const sceneFiles = ['scenes-1.jsx','scenes-2.jsx','scenes-3.jsx','main.jsx']
    .map(f => path.join(projectDir, f))
    .filter(f => fs.existsSync(f));

  const modified = [];
  for (const file of sceneFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(oldPath)) continue;

    // Backup before modifying
    const bakPath = file + '.bak';
    if (!fs.existsSync(bakPath)) {
      // Only keep the FIRST backup (original), don't overwrite existing bak
      fs.copyFileSync(file, bakPath);
    } else {
      // Rotate backup: keep a timestamped copy
      const ts = new Date().toISOString().replace(/[:.]/g,'_');
      fs.copyFileSync(file, file + `.${ts}.bak`);
    }

    const updated = src.split(oldPath).join(newPath);
    fs.writeFileSync(file, updated, 'utf8');
    modified.push(path.basename(file));
  }
  return modified;
}

/**
 * Restore a file from its .bak backup.
 */
function restoreFromBackup(projectDir, filename) {
  const filePath = path.join(projectDir, filename);
  const bakPath = filePath + '.bak';
  if (!fs.existsSync(bakPath)) throw new Error(`No backup found for ${filename}`);
  fs.copyFileSync(bakPath, filePath);
}

/**
 * List all .bak files in projectDir.
 */
function listBackups(projectDir) {
  return fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.bak'))
    .map(f => ({ file: f, mtime: fs.statSync(path.join(projectDir, f)).mtime }));
}

module.exports = { replaceAssetPath, restoreFromBackup, listBackups };
