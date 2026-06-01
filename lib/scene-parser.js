// ─── BBits Studio — scene-parser.js ─────────────────────────────────────────
// Parses HyperFrames JSX scene files to extract:
//   - Scene function names and their scene numbers
//   - All asset/image references (src="...", url('...'), uploads/ paths)
'use strict';
const fs = require('fs');
const path = require('path');

// Match function Scene##Name() patterns
const SCENE_FN_RE = /function\s+(Scene\d{2}\w+)\s*\(/g;
// Match src={...} string literals and uploads/ paths
const ASSET_SRC_RE = /src=\{["']([^"']+)["']\}|src="([^"]+)"|url\(['"]([^'"]+)['"]\)|["'](uploads\/[^"']+)["']/g;

function parseProjectDir(projectDir) {
  const sceneFiles = ['scenes-1.jsx','scenes-2.jsx','scenes-3.jsx']
    .map(f => path.join(projectDir, f))
    .filter(f => fs.existsSync(f));

  const scenes = [];
  const assets = new Map(); // assetPath -> [{file, line, colStart, colEnd, raw}]

  for (const file of sceneFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const basename = path.basename(file);

    // Extract scene function names
    let m;
    SCENE_FN_RE.lastIndex = 0;
    while ((m = SCENE_FN_RE.exec(src)) !== null) {
      const fnName = m[1];
      const numMatch = fnName.match(/Scene(\d+)/);
      scenes.push({
        num: numMatch ? parseInt(numMatch[1]) : 0,
        fn: fnName,
        file: basename,
        filePath: file,
      });
    }

    // Extract asset references with line numbers
    ASSET_SRC_RE.lastIndex = 0;
    let am;
    while ((am = ASSET_SRC_RE.exec(src)) !== null) {
      const assetPath = am[1] || am[2] || am[3] || am[4];
      if (!assetPath) continue;
      // Find line number
      const before = src.slice(0, am.index);
      const lineNum = before.split('\n').length;
      const entry = { file: basename, filePath: file, line: lineNum, raw: am[0] };
      if (!assets.has(assetPath)) assets.set(assetPath, []);
      assets.get(assetPath).push(entry);
    }
  }

  scenes.sort((a, b) => a.num - b.num);
  return { scenes, assets: Object.fromEntries(assets) };
}

// Extract the full source of a single scene function from its file
function extractSceneSrc(filePath, fnName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) return null;
  // Walk braces to find the matching closing brace
  let depth = 0, i = start, inStr = false, strChar = '';
  while (i < src.length) {
    const c = src[i];
    if (!inStr && (c === '"' || c === "'" || c === '`')) { inStr = true; strChar = c; }
    else if (inStr && c === strChar && src[i-1] !== '\\') { inStr = false; }
    else if (!inStr && c === '{') depth++;
    else if (!inStr && c === '}') { depth--; if (depth === 0) { i++; break; } }
    i++;
  }
  return src.slice(start, i);
}

module.exports = { parseProjectDir, extractSceneSrc };
