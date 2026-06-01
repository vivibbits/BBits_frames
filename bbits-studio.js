// ─── BBits Studio — bbits-studio.js (main server) ────────────────────────────
'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const chokidar = require('chokidar');

const { parseProjectDir } = require('./lib/scene-parser');
const { buildStandaloneHtml } = require('./lib/extractor');
const { replaceAssetPath, restoreFromBackup, listBackups } = require('./lib/asset-manager');
const { addSseClient, startRender, queueRenderJobs, cancelRender } = require('./lib/renderer');

const PORT = 4999;
const app  = express();
app.use(express.json());

// Disable browser caching completely for development files so changes take effect instantly
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── State ─────────────────────────────────────────────────────────────────────
let projectDir  = '';  // Currently loaded project path
let projectData = null; // { scenes, assets }
let layerConfig = {};   // sceneNum -> 'normal' | 'greenscreen' | 'alpha'

// ── Project Management ────────────────────────────────────────────────────────
app.post('/api/project/load', (req, res) => {
  const { dir } = req.body;
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'Directory not found' });
  try {
    projectDir  = dir;
    projectData = parseProjectDir(dir);
    // Init layer config
    for (const s of projectData.scenes) {
      if (!layerConfig[s.num]) layerConfig[s.num] = 'normal';
    }
    res.json({ ok: true, scenes: projectData.scenes, assets: projectData.assets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/project/info', (req, res) => {
  if (!projectData) return res.json({ loaded: false });
  res.json({ loaded: true, dir: projectDir, scenes: projectData.scenes, assets: projectData.assets, layerConfig });
});

// Reload when JSX files change
function watchProject() {
  if (!projectDir) return;
  chokidar.watch(path.join(projectDir, '*.jsx'), { ignoreInitial: true })
    .on('change', () => { try { projectData = parseProjectDir(projectDir); } catch(_) {} });
}

// ── Scene Extractor ───────────────────────────────────────────────────────────
app.post('/api/extract', (req, res) => {
  if (!projectData) return res.status(400).json({ error: 'No project loaded' });
  const { sceneNums, stripHud, layerMode, duration } = req.body;

  const scenes = projectData.scenes.filter(s => sceneNums.includes(s.num));
  if (!scenes.length) return res.status(400).json({ error: 'No matching scenes' });

  // Override duration per scene if provided
  if (duration) scenes.forEach(s => s.duration = duration);

  const outDir = path.join(projectDir, 'extracts');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const label = scenes.length === 1 ? `scene_${scenes[0].num}` : `scenes_${sceneNums.join('_')}`;
  const outPath = path.join(outDir, `${label}.html`);

  try {
    buildStandaloneHtml({ projectDir, scenes, stripHud: !!stripHud, layerMode: layerMode || 'normal', outputPath: outPath });
    res.json({ ok: true, path: outPath, relative: path.relative(projectDir, outPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Render ────────────────────────────────────────────────────────────────────
app.get('/api/render/stream', (req, res) => addSseClient(res));

app.post('/api/render/start', (req, res) => {
  if (!projectData) return res.status(400).json({ error: 'No project loaded' });
  const { inputHtml, outputName, layerMode, pngSequence, stripHud } = req.body;
  const rendersDir = path.join(projectDir, 'renders');
  if (!fs.existsSync(rendersDir)) fs.mkdirSync(rendersDir);
  
  let outputPath;
  if (pngSequence) {
    // For PNG sequence, outputPath must be the DIRECTORY where frames land.
    // HyperFrames creates a subfolder with the given name. If we delete the folder if it exists,
    // HyperFrames will create it fresh and put the frames directly under it (no nesting).
    const seqDir = path.join(rendersDir, outputName || 'output');
    if (fs.existsSync(seqDir)) {
      fs.rmSync(seqDir, { recursive: true, force: true });
    }
    outputPath = seqDir;
  } else {
    outputPath = path.join(rendersDir, (outputName || 'output') + '.mp4');
  }

  let renderHtmlPath = inputHtml;
  const doStrip = stripHud !== undefined ? !!stripHud : true;

  // Re-extract and rebuild the standalone HTML file with the requested layerMode
  // before rendering to guarantee the correct background is captured.
  if (inputHtml) {
    let sceneNums = [];
    const baseName = path.basename(inputHtml, '.html');
    if (baseName.startsWith('scene_')) {
      sceneNums = [parseInt(baseName.replace('scene_', ''))];
    } else if (baseName.startsWith('scenes_')) {
      sceneNums = baseName.replace('scenes_', '').split('_').map(Number);
    }
    
    if (sceneNums.length > 0) {
      const scenes = projectData.scenes.filter(s => sceneNums.includes(s.num));
      if (scenes.length > 0) {
        try {
          buildStandaloneHtml({
            projectDir,
            scenes,
            stripHud: doStrip,
            layerMode, // normal, greenscreen, or alpha
            outputPath: inputHtml
          });
        } catch (e) {
          console.error('Error rebuilding HTML for render:', e.message);
        }
      }
    }
  } else {
    // Full Reel Render: compile extracts/full_reel.html with the selected layerMode
    const fullReelPath = path.join(projectDir, 'extracts', 'full_reel.html');
    try {
      buildStandaloneHtml({
        projectDir,
        scenes: projectData.scenes,
        stripHud: doStrip,
        layerMode,
        outputPath: fullReelPath
      });
      renderHtmlPath = fullReelPath;
    } catch (e) {
      console.error('Error building full reel HTML for render:', e.message);
    }
  }

  const ok = startRender({ projectDir, outputPath, inputHtml: renderHtmlPath, layerMode, pngSequence });
  res.json({ ok, outputPath });
});

app.post('/api/render/batch', (req, res) => {
  if (!projectData) return res.status(400).json({ error: 'No project loaded' });
  const { sceneNums, layerMode, pngSequence, stripHud } = req.body;

  if (!sceneNums || !sceneNums.length) {
    return res.status(400).json({ error: 'No scenes selected for batch' });
  }

  const jobs = [];
  const doStrip = stripHud !== undefined ? !!stripHud : true;
  const rendersDir = path.join(projectDir, 'renders');
  if (!fs.existsSync(rendersDir)) fs.mkdirSync(rendersDir);

  const extractsDir = path.join(projectDir, 'extracts');
  if (!fs.existsSync(extractsDir)) fs.mkdirSync(extractsDir);

  for (const num of sceneNums) {
    const scene = projectData.scenes.find(s => s.num === num);
    if (!scene) continue;

    const sceneName = `scene_${String(num).padStart(2, '0')}`;
    const sceneRendersDir = path.join(rendersDir, sceneName);

    // For PNG sequences, outputPath IS the folder where frames land.
    // Do NOT pre-create the folder on the server! If the folder already exists,
    // HyperFrames will detect it as an existing directory and create a nested subfolder.
    // Letting HyperFrames create it directly guarantees a single-level folder with no nesting.
    const outputPath = pngSequence
      ? sceneRendersDir   // frames land directly in renders/scene_02/
      : path.join(sceneRendersDir, `${sceneName}.mp4`);

    if (pngSequence) {
      if (fs.existsSync(sceneRendersDir)) {
        fs.rmSync(sceneRendersDir, { recursive: true, force: true });
      }
    } else {
      if (!fs.existsSync(sceneRendersDir)) {
        fs.mkdirSync(sceneRendersDir, { recursive: true });
      }
    }

    // Prepare standalone HTML preview path
    const inputHtml = path.join(extractsDir, `scene_${num}.html`);

    // Compile standalone HTML for the scene
    try {
      buildStandaloneHtml({
        projectDir,
        scenes: [scene],
        stripHud: doStrip,
        layerMode: layerMode || 'normal',
        outputPath: inputHtml
      });
    } catch (e) {
      console.error(`Error compiling scene ${num} for batch:`, e.message);
      continue;
    }

    jobs.push({
      projectDir,
      outputPath,
      inputHtml,
      layerMode: layerMode || 'normal',
      pngSequence: !!pngSequence,
      sceneNum: num
    });
  }

  if (!jobs.length) {
    return res.status(400).json({ error: 'Failed to prepare any scenes for batch rendering' });
  }

  const ok = queueRenderJobs(jobs);
  res.json({ ok, count: jobs.length });
});

app.post('/api/render/cancel', (_, res) => {
  res.json({ ok: cancelRender() });
});

// ── Layer Config ──────────────────────────────────────────────────────────────
app.post('/api/layer', (req, res) => {
  const { sceneNum, mode } = req.body;
  layerConfig[sceneNum] = mode;
  res.json({ ok: true });
});

// ── Asset Manager ─────────────────────────────────────────────────────────────
// Upload a new asset file to the project's uploads/ dir
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const upDir = path.join(projectDir, 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir);
    cb(null, upDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueName = `${base}_${Date.now()}${ext}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

app.post('/api/asset/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const relPath = 'uploads/' + req.file.filename;
  res.json({ ok: true, path: relPath, filename: req.file.filename });
});

// Replace an asset path across all JSX files
app.post('/api/asset/replace', (req, res) => {
  if (!projectData) return res.status(400).json({ error: 'No project loaded' });
  const { oldPath, newPath } = req.body;
  try {
    const modified = replaceAssetPath(projectDir, oldPath, newPath);
    projectData = parseProjectDir(projectDir); // Refresh
    res.json({ ok: true, modified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve project's uploads folder as static files for preview thumbnails
app.use('/uploads', (req, res, next) => {
  if (!projectDir) return res.status(400).end();
  express.static(path.join(projectDir, 'uploads'))(req, res, next);
});

// Serve the ENTIRE project directory as /project-static so extracted HTML
// files can load uploads/, assets/ etc via relative paths that resolve correctly.
app.use('/project-static', (req, res, next) => {
  if (!projectDir) return res.status(400).end();
  express.static(projectDir)(req, res, next);
});

// Serve generated extracts (HTML files)
app.use('/extracts', (req, res, next) => {
  if (!projectDir) return res.status(400).end();
  if (req.path.endsWith('.jsx')) {
    res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  }
  express.static(path.join(projectDir, 'extracts'))(req, res, next);
});

// ── Config Management ─────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  if (!projectDir) return res.status(400).json({ error: 'No project loaded' });
  const cfgPath = path.join(projectDir, 'bbits-config.json');
  if (!fs.existsSync(cfgPath)) return res.json({});
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config/save-element', (req, res) => {
  if (!projectDir) return res.status(400).json({ error: 'No project loaded' });
  const { sceneNum, elementKey, data } = req.body;
  const cfgPath = path.join(projectDir, 'bbits-config.json');
  
  let config = {};
  if (fs.existsSync(cfgPath)) {
    try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
  }
  
  if (!config.scenes) config.scenes = {};
  if (!config.scenes[sceneNum]) config.scenes[sceneNum] = {};
  
  config.scenes[sceneNum][elementKey] = data;
  
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore backup
app.post('/api/asset/restore', (req, res) => {
  const { filename } = req.body;
  try { restoreFromBackup(projectDir, filename); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/asset/backups', (req, res) => {
  if (!projectDir) return res.json({ backups: [] });
  res.json({ backups: listBackups(projectDir) });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n  ◆ BBITS Frame running at http://localhost:${PORT}\n`);
  try {
    const { default: open } = await import('open');
    open(`http://localhost:${PORT}`);
  } catch (_) {}
  watchProject();
});
