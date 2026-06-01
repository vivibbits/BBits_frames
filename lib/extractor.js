// ─── BBits Studio — extractor.js ─────────────────────────────────────────────
// Generates a standalone HyperFrames index.html containing only the selected scenes.
// Optionally strips SceneLabel, ScenePanel, TimecodeBar HUD elements.
'use strict';
const fs = require('fs');
const path = require('path');
const { extractSceneSrc } = require('./scene-parser');

// Tags to strip when HUD removal is requested
const HUD_STRIP_PATTERNS = [
  /<SceneLabel[\s\S]*?\/>/g,           // self-closing <SceneLabel ... />
  /<SceneLabel[\s\S]*?<\/SceneLabel>/g, // wrapped <SceneLabel>...</SceneLabel>
  // ScenePanel and TimecodeBar are in main.jsx, handled by regenerating the schedule
];

function stripHud(src) {
  let out = src;
  for (const pat of HUD_STRIP_PATTERNS) out = out.replace(pat, '{/* HUD stripped */}');
  return out;
}

/**
 * Build a standalone index.html for the given subset of scenes.
 * @param {object} opts
 * @param {string} opts.projectDir  - Path to the target project
 * @param {Array}  opts.scenes      - Array of scene objects { fn, filePath, num }
 * @param {boolean} opts.stripHud  - Remove SceneLabel overlays
 * @param {string} opts.layerMode   - 'normal' | 'greenscreen' | 'alpha'
 * @param {string} opts.outputPath  - Where to write the standalone HTML
 */
function buildStandaloneHtml(opts) {
  const { projectDir, scenes, stripHud: doStrip, layerMode = 'normal', outputPath } = opts;

  // Read config if it exists
  const cfgPath = path.join(projectDir, 'bbits-config.json');
  let configStr = '{}';
  if (fs.existsSync(cfgPath)) {
    try { configStr = fs.readFileSync(cfgPath, 'utf8'); } catch (_) {}
  }

  // Read shared files
  const sharedSrc   = fs.readFileSync(path.join(projectDir, 'shared.jsx'), 'utf8');
  const animSrc     = fs.readFileSync(path.join(projectDir, 'animations.jsx'), 'utf8');
  const origIndex   = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8');

  // Collect full scene files instead of just functions to include dependencies
  const uniquePaths = [...new Set(scenes.map(s => path.resolve(projectDir, s.filePath)))];
  const sceneSrcs = uniquePaths.map(filePath => {
    let src = fs.readFileSync(filePath, 'utf8');
    // Strip top-level Easing declarations completely to resolve conflicts with animations.jsx
    src = src.replace(/const Easing = window\.Easing \|\| \{\};/g, '');
    src = src.replace(/var Easing = window\.Easing \|\| \{\};/g, '');
    if (doStrip) src = stripHud(src);
    return src;
  });

  // Build the FRMR_SCHEDULE for only selected scenes (each gets equal time slice)
  const totalDuration = scenes.length * 5; // 5 seconds per scene default
  const scheduleEntries = scenes.map((s, i) => {
    const start = i * 5;
    const end = start + 5;
    return `  { fn: ${s.fn}, start: ${start}, end: ${end} },`;
  }).join('\n');

  // Rewrite relative asset paths in all inlined JSX source so that uploads/ and
  // assets/ resolve correctly when served from localhost:4999/extracts/<file>.html
  function rewriteAssetPaths(src) {
    return src
      .replace(/(["'])uploads\//g, '$1/project-static/uploads/')
      .replace(/(["'])assets\//g, '$1/project-static/assets/');
  }
  const rewrittenSceneSrcs = sceneSrcs.map(rewriteAssetPaths);
  const rewrittenShared    = rewriteAssetPaths(sharedSrc);
  const rewrittenAnim      = rewriteAssetPaths(animSrc);

  // Extract <link> tags from the original index.html (fonts etc.)
  const linkTags = (origIndex.match(/<link[^>]+>/g) || []).join('\n  ');

  // Background color override string (used at bottom of babel script)
  const bgOverride = layerMode === 'greenscreen'
    ? `document.body.style.background = '#00FF00';`
    : layerMode === 'alpha'
    ? `document.body.style.background = 'transparent';`
    : '';

  const jsxFilename = path.basename(outputPath).replace(/\.html$/, '.jsx');
  const jsxPath = outputPath.replace(/\.html$/, '.jsx');

  const jsxContent = `// ─── Shared ───────────────────────────────────────────────────────────────
${rewrittenShared}
// ─── Animations ───────────────────────────────────────────────────────────
${rewrittenAnim}
// ─── Scene Functions ──────────────────────────────────────────────────────
${rewrittenSceneSrcs.join('\n\n')}
// ─── Schedule ─────────────────────────────────────────────────────────────
const FRMR_SCHEDULE = [
${scheduleEntries}
];
const TOTAL_DURATION = ${totalDuration};

// ─── Render Root Composition ──────────────────────────────────────────────
const rootElement = document.getElementById('root');
const compositionId = rootElement.getAttribute('data-composition-id') || 'extracted-scene';

// Expose setTime wrapper for pending seeks before React fully mounts
window.__setTime = (t) => {
  window.__pendingSeek = t;
};

// Mount the real Stage from animations.jsx
ReactDOM.createRoot(rootElement).render(
  React.createElement(
    Stage,
    {
      width: 1920,
      height: 1080,
      duration: TOTAL_DURATION,
      background: "${layerMode === 'greenscreen' ? '#00FF00' : layerMode === 'alpha' ? 'transparent' : '#050507'}",
      persistKey: compositionId,
      autoplay: true
    },
    FRMR_SCHEDULE.map((s, i) =>
      React.createElement(
        Sprite,
        { key: i, start: s.start, end: s.end },
        React.createElement(s.fn, null)
      )
    )
  )
);
`;

  fs.writeFileSync(jsxPath, jsxContent, 'utf8');

  // Build the full standalone HTML with NO inline scripts containing JSX
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>BBITS Frame Extract — ${scenes.map(s => s.fn).join(', ')}</title>
  ${linkTags}
  <script>
    window.__bbits_config = ${configStr};
    window.__bbits_layer_mode = "${layerMode}";
    window.__hf = {
      duration: ${totalDuration},
      seek: function(t) {
        document.body.classList.add('rendering');
        if (window.__setTime) {
          window.__setTime(t);
        } else {
          window.__pendingSeek = t;
        }
      }
    };
    window.__timelines = window.__timelines || {};
    window.__timelines['extracted-scene'] = {
      duration: function() { return ${totalDuration}; },
      seek: function(t) {
        document.body.classList.add('rendering');
        if (window.__setTime) {
          window.__setTime(t);
        } else {
          window.__pendingSeek = t;
        }
      },
      pause: function() {},
      paused: function() { return true; }
    };
    
    // Always fetch latest config on load to ensure it is up-to-date even after iframe reloads
    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        window.__bbits_config = d;
        if (window.__setTime && window.__pendingSeek !== undefined) {
          window.__setTime(window.__pendingSeek);
        }
      })
      .catch(() => {});
  </script>
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:1920px; height:1080px; overflow:hidden; background:${layerMode === 'greenscreen' ? '#00FF00' : layerMode === 'alpha' ? 'transparent' : '#000'}; }
    #root { position:absolute; inset:0; }
    /* Hide all player UI and playback bars completely during render captures */
    body.rendering #preview-bar,
    body.rendering #root > div > div:nth-child(2) {
      display: none !important;
    }
  </style>
</head>
<body>
<div id="root" data-composition-id="extracted-scene" data-width="1920" data-height="1080" data-start="0"></div>
<script>
  const script = document.createElement('script');
  script.type = 'text/babel';
  if (window.location.pathname.includes('/extracts/')) {
    script.src = '${jsxFilename}';
  } else {
    script.src = 'extracts/${jsxFilename}';
  }
  document.body.appendChild(script);
</script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

module.exports = { buildStandaloneHtml };

