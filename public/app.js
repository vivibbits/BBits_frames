/* ─── BBits Studio — app.js (frontend logic) ───────────────────────────── */
'use strict';

let state = {
  loaded: false,
  projectDir: '',
  scenes: [],
  assets: {},
  layerConfig: {},
  selectedScenes: new Set(),
  extracts: [],
  replaceTarget: null,   // { oldPath } being replaced
  sseSource: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = id => document.getElementById(id)?.classList.remove('hidden');
const hide = id => document.getElementById(id)?.classList.add('hidden');

function logConsole(text) {
  const el = $('console-output');
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

function setRenderRunning(running) {
  const dot   = $('console-dot');
  const label = $('console-status-label');
  const btn   = $('btn-quick-render');
  if (running) {
    dot.classList.add('running');
    label.textContent = 'Rendering…';
    if (btn) btn.disabled = true;
    $('render-status').textContent = '⏳ Rendering…';
  } else {
    dot.classList.remove('running');
    label.textContent = 'Idle';
    if (btn) btn.disabled = !state.loaded;
    $('render-status').textContent = '';
  }
}

// ── SSE Render Stream ─────────────────────────────────────────────────────
function connectSse() {
  if (state.sseSource) return;
  const es = new EventSource('/api/render/stream');
  es.addEventListener('start', e => { 
    const d = JSON.parse(e.data);
    setRenderRunning(true); 
    logConsole(`\n[RENDER START] Scene ${d.sceneNum || 'Reel'} → ${d.outputPath}\n`); 
  });
  es.addEventListener('log', e => logConsole(JSON.parse(e.data).text));
  es.addEventListener('done', e => { 
    const d = JSON.parse(e.data);
    logConsole(`\n[RENDER SCENE DONE] Scene ${d.sceneNum || 'Reel'} completed with code ${d.code} → ${d.outputPath}\n`); 
  });
  es.addEventListener('batch_done', e => {
    const d = JSON.parse(e.data);
    setRenderRunning(false);
    logConsole(`\n[BATCH COMPLETED] ${d.message}\n`);
  });
  es.addEventListener('cancelled', () => { 
    setRenderRunning(false); 
    logConsole('\n[RENDER CANCELLED]\n'); 
  });
  es.addEventListener('error', e => { 
    if (e.data) logConsole('\n[ERROR] ' + JSON.parse(e.data).msg + '\n'); 
  });
  state.sseSource = es;
}
connectSse();

// ── Console Sidebar Toggle & Resize ───────────────────────────────────────
const consoleBtn = $('btn-toggle-console');
const sidebarConsole = $('sidebar-console');
const consoleResizer = $('console-resizer');

function ensureConsoleOpen() {
  if (sidebarConsole.classList.contains('hidden')) {
    sidebarConsole.classList.remove('hidden');
    consoleBtn.classList.add('active');
    localStorage.setItem('bbits-console-visible', 'true');
  }
}

// Load initial state and custom width
const isConsoleVisible = localStorage.getItem('bbits-console-visible') !== 'false';
const savedWidth = localStorage.getItem('bbits-console-width') || '360';
sidebarConsole.style.width = savedWidth + 'px';

if (isConsoleVisible) {
  sidebarConsole.classList.remove('hidden');
  consoleBtn.classList.add('active');
} else {
  sidebarConsole.classList.add('hidden');
  consoleBtn.classList.remove('active');
}

consoleBtn.addEventListener('click', () => {
  const isHidden = sidebarConsole.classList.toggle('hidden');
  localStorage.setItem('bbits-console-visible', !isHidden ? 'true' : 'false');
  if (!isHidden) {
    consoleBtn.classList.add('active');
  } else {
    consoleBtn.classList.remove('active');
  }
});

// Drag resizing logic
if (consoleResizer) {
  consoleResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sidebarConsole.classList.add('resizing');
    const startX = e.clientX;
    const startWidth = parseInt(document.defaultView.getComputedStyle(sidebarConsole).width, 10);
    
    const onMouseMove = (ev) => {
      const dx = startX - ev.clientX; // Moving left increases width for right sidebar
      const newWidth = Math.max(240, Math.min(800, startWidth + dx));
      sidebarConsole.style.width = newWidth + 'px';
      localStorage.setItem('bbits-console-width', newWidth);
    };
    
    const onMouseUp = () => {
      sidebarConsole.classList.remove('resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    tab.classList.add('active');
    const panel = $('tab-' + tab.dataset.tab);
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
    
    // Auto-recompile and reload the scene preview when returning to the Comp Editor tab
    if (tab.dataset.tab === 'comp-editor' && editorState.activeSceneNum) {
      const selectEl = $('comp-scene-select');
      if (selectEl) {
        selectEl.dispatchEvent(new Event('change'));
      }
    }
  });
});

// ── Load Project ──────────────────────────────────────────────────────────
$('btn-load-project').addEventListener('click', () => show('load-modal'));
$('btn-cancel-load').addEventListener('click',  () => hide('load-modal'));

$('btn-confirm-load').addEventListener('click', async () => {
  const dir = $('project-path-input').value.trim();
  if (!dir) return;
  const res = await fetch('/api/project/load', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dir }) });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + data.error); return; }
  hide('load-modal');
  applyProject(data);
});

function applyProject(data) {
  state.loaded    = true;
  state.scenes    = data.scenes || [];
  state.assets    = data.assets || {};
  state.layerConfig = data.layerConfig || {};
  state.selectedScenes.clear();

  const badge = $('project-badge');
  badge.textContent = data.dir || state.projectDir;
  badge.classList.add('loaded');
  $('btn-quick-render').disabled = false;

  renderSceneGrid();
  renderAssetGrid();
  renderLayerGrid();
  updateExtractBtn();
  populateCompSceneSelect();
}

// Auto-load from server if already loaded
fetch('/api/project/info').then(r => r.json()).then(d => { if (d.loaded) { state.projectDir = d.dir; applyProject(d); } });

// ── Scene Grid ────────────────────────────────────────────────────────────
function renderSceneGrid() {
  const grid = $('scene-grid');
  const empty = $('scene-empty');
  if (!state.scenes.length) { if (empty) empty.style.display=''; return; }
  if (empty) empty.style.display='none';

  grid.innerHTML = '';
  for (const s of state.scenes) {
    const selected = state.selectedScenes.has(s.num);
    const layer    = state.layerConfig[s.num] || 'normal';
    const card = document.createElement('div');
    card.className = 'scene-card' + (selected ? ' selected' : '');
    card.dataset.num = s.num;

    // Make a readable display name from function name
    const readableName = s.fn.replace(/^Scene\d+/, '').replace(/([A-Z])/g, ' $1').trim();

    card.innerHTML = `
      <div class="scene-card-check">${selected ? '✓' : ''}</div>
      <div class="scene-card-num">SCENE ${String(s.num).padStart(2,'0')}</div>
      <div class="scene-card-name">${readableName || s.fn}</div>
      <div class="scene-card-file">${s.file}</div>
      <div class="scene-card-layer ${layer !== 'normal' ? layer : ''}">${
        layer === 'greenscreen' ? '🟩 Greenscreen' :
        layer === 'overlay'    ? '🎭 Overlay'     : '◼ Normal'
      }</div>`;

    card.addEventListener('click', () => {
      if (state.selectedScenes.has(s.num)) state.selectedScenes.delete(s.num);
      else state.selectedScenes.add(s.num);
      renderSceneGrid();
      updateExtractBtn();
    });
    grid.appendChild(card);
  }
}

$('btn-select-all').addEventListener('click', () => {
  state.scenes.forEach(s => state.selectedScenes.add(s.num));
  renderSceneGrid(); updateExtractBtn();
});
$('btn-deselect-all').addEventListener('click', () => {
  state.selectedScenes.clear();
  renderSceneGrid(); updateExtractBtn();
});

function updateExtractBtn() {
  const count = state.selectedScenes.size;
  $('selected-count').textContent = `${count} selected`;
  $('btn-extract').disabled = count === 0 || !state.loaded;
  $('btn-batch-render').disabled = count === 0 || !state.loaded;
}

// ── Extract ───────────────────────────────────────────────────────────────
$('btn-extract').addEventListener('click', async () => {
  if (!state.selectedScenes.size) return;
  const stripHud = $('chk-strip-hud').checked;
  const duration = parseInt($('scene-duration').value) || 8;
  const layerMode = $('extract-layer-mode').value || 'normal';
  const sceneNums = [...state.selectedScenes].sort((a,b)=>a-b);
  const res = await fetch('/api/extract', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sceneNums, stripHud, duration, layerMode }),
  });
  const data = await res.json();
  if (!res.ok) { alert('Extract error: ' + data.error); return; }

  // Add to extracts list
  state.extracts.push(data);
  renderExtractsList();
  logConsole(`\n[EXTRACTED] ${data.path}\n`);

  // Ensure sidebar console is visible
  ensureConsoleOpen();
});

// ── Batch Render ──────────────────────────────────────────────────────────
$('btn-batch-render').addEventListener('click', async () => {
  if (!state.selectedScenes.size) return;
  const layerMode = $('extract-layer-mode').value || 'normal';
  const pngSequence = layerMode === 'alpha';
  const sceneNums = [...state.selectedScenes].sort((a,b)=>a-b);
  const stripHud = $('chk-strip-hud').checked;

  const confirmMsg = `Are you sure you want to batch render ${sceneNums.length} scenes?\nEach animation will be exported to its own dedicated folder under "renders/".`;
  if (!confirm(confirmMsg)) return;

  logConsole(`\n[BATCH RENDER QUEUED] Initiating batch render for scenes: ${sceneNums.join(', ')}\n`);
  ensureConsoleOpen();

  const res = await fetch('/api/render/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneNums, layerMode, pngSequence, stripHud }),
  });
  
  const data = await res.json();
  if (!res.ok) {
    alert('Batch render error: ' + data.error);
    logConsole(`[BATCH ERROR] ${data.error}\n`);
    return;
  }

  logConsole(`[BATCH STARTED] ${data.count} render jobs successfully queued!\n`);
});

function renderExtractsList() {
  const bar  = $('extracts-bar');
  const list = $('extracts-list');
  bar.style.display = state.extracts.length ? '' : 'none';
  list.innerHTML = '';
  for (const ex of state.extracts) {
    const item = document.createElement('div');
    item.className = 'extract-item';
    item.innerHTML = `
      <div class="extract-path">${ex.relative || ex.path}</div>
      <div class="extract-actions">
        <button class="btn btn-sm btn-ghost" onclick="previewExtract('${ex.path.replace(/\\/g,'/')}')">👁 Preview</button>
        <button class="btn btn-sm btn-accent" onclick="renderExtract('${ex.path.replace(/\\/g,'/')}')">▶ Render</button>
      </div>`;
    list.appendChild(item);
  }
}

window.previewExtract = (htmlPath) => {
  window.open('/extracts/' + htmlPath.split('/extracts/').pop(), '_blank');
};

window.renderExtract = (htmlPath) => {
  // Pre-fill render modal with derived output name
  const baseName = htmlPath.split('/').pop().replace('.html','');
  $('render-output-name').value = baseName;
  $('render-modal').dataset.inputHtml = htmlPath;
  show('render-modal');
};

// ── Render Modal ──────────────────────────────────────────────────────────
$('btn-cancel-render').addEventListener('click', () => hide('render-modal'));
$('btn-confirm-render').addEventListener('click', async () => {
  const outputName = $('render-output-name').value.trim() || 'output';
  const layerMode  = document.querySelector('input[name="render-mode"]:checked')?.value || 'normal';
  const pngSequence = layerMode === 'alpha';
  const inputHtml  = $('render-modal').dataset.inputHtml || null;
  const stripHud   = $('chk-render-strip-hud').checked;
  hide('render-modal');

  await fetch('/api/render/start', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ outputName, layerMode, pngSequence, inputHtml, stripHud }),
  });

  // Ensure sidebar console is visible
  ensureConsoleOpen();
});

$('btn-quick-render').addEventListener('click', () => {
  $('render-output-name').value = 'bbits_reel';
  $('render-modal').dataset.inputHtml = '';
  show('render-modal');
});

$('btn-cancel-render-console').addEventListener('click', () =>
  fetch('/api/render/cancel', { method:'POST' })
);

$('btn-clear-console').addEventListener('click', () => {
  $('console-output').textContent = '';
});

// ── Asset Grid ────────────────────────────────────────────────────────────
let assetFilter = '';
$('asset-search').addEventListener('input', e => { assetFilter = e.target.value.toLowerCase(); renderAssetGrid(); });

function renderAssetGrid() {
  const grid = $('asset-grid');
  const entries = Object.entries(state.assets).filter(([p]) => !assetFilter || p.toLowerCase().includes(assetFilter));
  if (!entries.length) { grid.innerHTML = '<div class="empty-state">No assets found</div>'; return; }

  grid.innerHTML = '';
  for (const [assetPath, refs] of entries) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(assetPath);
    const thumbSrc = isImg ? '/uploads/' + assetPath.replace('uploads/','') : '';

    card.innerHTML = `
      <div class="asset-thumb ${isImg ? '' : 'no-preview'}">
        ${isImg ? `<img src="${thumbSrc}" alt="" onerror="this.style.display='none'; this.parentElement.textContent='📄'"/>` : '📄'}
      </div>
      <div class="asset-body">
        <div class="asset-path">${assetPath}</div>
        <div class="asset-refs">Used in: ${refs.map(r=>r.file).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}</div>
        <div class="asset-actions">
          <button class="btn btn-sm btn-accent" onclick="openReplaceModal('${assetPath.replace(/'/g,"\\'")}')">⇄ Replace</button>
        </div>
      </div>`;
    grid.appendChild(card);
  }
}

// ── Replace Modal ─────────────────────────────────────────────────────────
window.openReplaceModal = (oldPath) => {
  state.replaceTarget = { oldPath };
  $('replace-old-path').textContent = oldPath;
  $('replace-file-input').value = '';
  $('replace-preview-new').src = '';
  $('replace-preview-new').style.opacity = '0.3';

  const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(oldPath);
  const oldSrc = isImg ? '/uploads/' + oldPath.replace('uploads/','') : '';
  $('replace-preview-old').src = oldSrc;
  $('replace-preview-old').style.display = isImg ? '' : 'none';

  show('replace-modal');
};

$('replace-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    $('replace-preview-new').src = ev.target.result;
    $('replace-preview-new').style.opacity = '1';
  };
  reader.readAsDataURL(file);
});

$('btn-cancel-replace').addEventListener('click', () => { hide('replace-modal'); state.replaceTarget = null; });

$('btn-confirm-replace').addEventListener('click', async () => {
  const file = $('replace-file-input').files[0];
  if (!file || !state.replaceTarget) return;

  // 1. Upload the file
  const form = new FormData();
  form.append('file', file);
  const upRes = await fetch('/api/asset/upload', { method:'POST', body: form });
  const upData = await upRes.json();
  if (!upRes.ok) { alert('Upload error: ' + upData.error); return; }

  // 2. Replace path in JSX
  const repRes = await fetch('/api/asset/replace', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ oldPath: state.replaceTarget.oldPath, newPath: upData.path }),
  });
  const repData = await repRes.json();
  if (!repRes.ok) { alert('Replace error: ' + repData.error); return; }

  hide('replace-modal');
  logConsole(`\n[ASSET REPLACED] ${state.replaceTarget.oldPath} → ${upData.path}\n  Modified: ${repData.modified?.join(', ')}\n`);

  // Refresh project data
  const info = await fetch('/api/project/info').then(r=>r.json());
  if (info.loaded) {
    state.assets = info.assets;
    renderAssetGrid();
  }
  
  // Reload preview iframe if active to reflect the global asset swap
  const iframe = $('comp-preview-iframe');
  if (iframe && iframe.style.display !== 'none') {
    iframe.src = iframe.src;
  }
});

// ── Upload New Asset ──────────────────────────────────────────────────────
$('btn-upload-new').addEventListener('click', () => $('global-upload-input').click());
$('global-upload-input').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const form = new FormData(); form.append('file', file);
  const res = await fetch('/api/asset/upload', { method:'POST', body: form });
  const data = await res.json();
  if (res.ok) logConsole(`\n[UPLOAD] ${data.path}\n`);
  e.target.value = '';
});

// ── Restore Backup ────────────────────────────────────────────────────────
$('btn-restore-backup').addEventListener('click', async () => {
  const res  = await fetch('/api/asset/backups');
  const data = await res.json();
  if (!data.backups.length) { alert('No backups found.'); return; }
  const choice = data.backups.map((b,i)=>`${i+1}. ${b.file}`).join('\n');
  const idx = parseInt(prompt('Backups:\n' + choice + '\n\nEnter number to restore:')) - 1;
  if (isNaN(idx) || idx < 0 || idx >= data.backups.length) return;
  const filename = data.backups[idx].file.replace(/\.bak$/, '');
  const r = await fetch('/api/asset/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ filename }) });
  const d = await r.json();
  if (d.ok) logConsole(`\n[RESTORED] ${filename} from backup\n`);
  else alert('Restore error: ' + d.error);
});

// ── Layer Grid ────────────────────────────────────────────────────────────
function renderLayerGrid() {
  const grid = $('layer-grid');
  if (!state.scenes.length) { grid.innerHTML = '<div class="empty-state">Load a project to configure layers</div>'; return; }
  grid.innerHTML = '';
  for (const s of state.scenes) {
    const mode = state.layerConfig[s.num] || 'normal';
    const readableName = s.fn.replace(/^Scene\d+/, '').replace(/([A-Z])/g, ' $1').trim();
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.innerHTML = `
      <div class="layer-num">SCENE ${String(s.num).padStart(2,'0')}</div>
      <div class="layer-name">${readableName}</div>
      <div class="layer-btns">
        <button class="layer-btn ${mode==='normal'?'active-normal':''}" data-scene="${s.num}" data-mode="normal">Normal</button>
        <button class="layer-btn ${mode==='greenscreen'?'active-greenscreen':''}" data-scene="${s.num}" data-mode="greenscreen">Greenscreen</button>
        <button class="layer-btn ${mode==='overlay'?'active-overlay':''}" data-scene="${s.num}" data-mode="overlay">Overlay</button>
      </div>`;
    grid.appendChild(row);
  }

  grid.addEventListener('click', async e => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    const sceneNum = parseInt(btn.dataset.scene);
    const newMode  = btn.dataset.mode;
    state.layerConfig[sceneNum] = newMode;
    await fetch('/api/layer', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sceneNum, mode: newMode }) });
    renderLayerGrid();
    renderSceneGrid(); // Update layer badge on scene cards too
  });
}

// Global Set All Scenes Mode helper
async function setAllSceneLayers(mode) {
  if (!state.scenes.length) return;
  const label = $('console-status-label');
  const oldLabel = label ? label.textContent : '';
  if (label) label.textContent = 'Updating all layers...';
  
  const promises = state.scenes.map(s => {
    state.layerConfig[s.num] = mode;
    return fetch('/api/layer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneNum: s.num, mode })
    });
  });
  
  await Promise.all(promises);
  if (label) label.textContent = oldLabel;
  
  renderLayerGrid();
  renderSceneGrid();
}

$('btn-layer-all-normal')?.addEventListener('click', () => setAllSceneLayers('normal'));
$('btn-layer-all-greenscreen')?.addEventListener('click', () => setAllSceneLayers('greenscreen'));
$('btn-layer-all-overlay')?.addEventListener('click', () => setAllSceneLayers('overlay'));


// ─── COMPOSITION EDITOR INTEGRATION ─────────────────────────────────────────

let editorState = {
  activeSceneNum: null,
  activeElementKey: null,
  activeTime: 0, // ms, 0 to 5000
  config: {}, // complete bbits-config JSON from server
  selectedKeyframeIdx: null,
  isPlaying: false,
  playTimer: null,
  // elementsMap is built dynamically from config — no hardcoding
  elementsMap: {
    2: ['Logo1', 'Logo2', 'Logo3'],
    3: ['Logo'],
    15: ['Mockup'],
    25: ['Avatar'],
    26: ['ViviTarget', 'MascotTarget']
  }
};

function populateCompSceneSelect() {
  const sel = $('comp-scene-select');
  if (!sel) return;
  
  const showOnlyEditable = $('chk-filter-editable')?.checked ?? false;
  const currentVal = sel.value;
  
  sel.innerHTML = '<option value="">-- Choose Scene --</option>';
  
  state.scenes.forEach(s => {
    const readableName = s.fn.replace(/^Scene\d+/, '').replace(/([A-Z])/g, ' $1').trim();
    const hasElements = (editorState.elementsMap[s.num] || []).length > 0;
    
    if (showOnlyEditable && !hasElements) {
      return; // Skip non-editable scenes
    }
    
    const opt = document.createElement('option');
    opt.value = s.num;
    opt.textContent = `Scene ${String(s.num).padStart(2,'0')} - ${readableName}${hasElements ? ' ✦' : ''}`;
    sel.appendChild(opt);
  });
  
  if (currentVal && [...sel.options].some(o => o.value === currentVal)) {
    sel.value = currentVal;
  }
}

// Bind checkbox filter
$('chk-filter-editable')?.addEventListener('change', () => {
  populateCompSceneSelect();
});

// Bind active scene select
$('comp-scene-select')?.addEventListener('change', async (e) => {
  const sceneNum = parseInt(e.target.value);
  if (isNaN(sceneNum)) {
    editorState.activeSceneNum = null;
    editorState.activeElementKey = null;
    $('comp-element-select').disabled = true;
    $('comp-element-select').value = '';
    $('comp-preview-iframe').style.display = 'none';
    $('comp-canvas-empty').style.display = '';
    hideSidebarSections();
    return;
  }
  
  editorState.activeSceneNum = sceneNum;
  editorState.activeElementKey = null;
  
  // Populate element dropdown — build from elementsMap + any keys found in config
  const elSel = $('comp-element-select');
  const configKeys = Object.keys((editorState.config.scenes || {})[sceneNum] || {});
  const hardcodedKeys = editorState.elementsMap[sceneNum] || [];
  const allKeys = [...new Set([...hardcodedKeys, ...configKeys])];
  
  if (allKeys.length > 0) {
    elSel.disabled = false;
    elSel.innerHTML = '<option value="">-- Choose Element --</option>';
    allKeys.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      elSel.appendChild(opt);
    });
  } else {
    // No editable elements for this scene — disable element picker, just show preview
    elSel.disabled = true;
    elSel.innerHTML = '<option value="">No elements (preview only)</option>';
  }
  
  // Render loading state on canvas
  $('comp-canvas-empty').textContent = 'Compiling scene preview...';
  $('comp-canvas-empty').style.display = '';
  $('comp-preview-iframe').style.display = 'none';
  
  // Trigger single-scene extract to compile the standalone HTML preview
  const res = await fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneNums: [sceneNum], stripHud: true, layerMode: 'normal' })
  });
  const data = await res.json();
  if (!res.ok) {
    $('comp-canvas-empty').textContent = 'Compilation failed: ' + data.error;
    return;
  }
  
  // Load iframe
  const iframe = $('comp-preview-iframe');
  iframe.src = `/extracts/scene_${sceneNum}.html?edit=1`;
  iframe.style.display = '';
  $('comp-canvas-empty').style.display = 'none';
  
  // Scale preview iframe dynamically inside its viewport container
  const viewport = $('comp-canvas-viewport');
  const scaleIframe = () => {
    const containerW = viewport.clientWidth;
    const containerH = viewport.clientHeight;
    const ratio = 1920 / 1080;
    
    let w = containerW;
    let h = containerW / ratio;
    if (h > containerH) {
      h = containerH;
      w = containerH * ratio;
    }
    
    const scale = w / 1920;
    iframe.style.transform = `scale(${scale})`;
    iframe.style.width = '1920px';
    iframe.style.height = '1080px';
    iframe.style.position = 'absolute';
  };
  window.addEventListener('resize', scaleIframe);
  iframe.onload = () => {
    scaleIframe();
    initTimelineRuler();
    seekTimeline(0);
  };
  
  hideSidebarSections();
});

// Bind active element select
$('comp-element-select')?.addEventListener('change', async (e) => {
  const key = e.target.value;
  if (!key) {
    editorState.activeElementKey = null;
    hideSidebarSections();
    return;
  }
  
  editorState.activeElementKey = key;
  show('comp-asset-override-section');
  show('comp-properties-section');
  
  // Enable timeline buttons
  $('btn-add-keyframe').disabled = false;
  $('btn-delete-keyframe').disabled = false;
  $('btn-comp-play').disabled = false;
  $('timeline-scrubber').disabled = false;
  
  await refreshConfigFromDisk();
  renderTimelineKeyframes();
  syncSlidersToActiveTime();
});

function hideSidebarSections() {
  hide('comp-asset-override-section');
  hide('comp-properties-section');
  $('btn-add-keyframe').disabled = true;
  $('btn-delete-keyframe').disabled = true;
  $('btn-comp-play').disabled = true;
  $('timeline-scrubber').disabled = true;
}

// Fetch config from server
async function refreshConfigFromDisk() {
  const res = await fetch('/api/config');
  const data = await res.json();
  editorState.config = data;
  
  // Sync bbits config to iframe window if possible
  const iframe = $('comp-preview-iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.__bbits_config = data;
  }
}

// Save active overrides config to disk
async function saveActiveElementConfig(elementData) {
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  
  const res = await fetch('/api/config/save-element', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneNum, elementKey: key, data: elementData })
  });
  const data = await res.json();
  if (res.ok) {
    editorState.config = data.config;
    
    // Inject immediately into iframe to prevent laggy server reload trips
    const iframe = $('comp-preview-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.__bbits_config = data.config;
      iframe.contentWindow.__hf.seek(editorState.activeTime / 1000);
    }
    
    renderTimelineKeyframes();
    syncSlidersToActiveTime();
  }
}

// Dual-directional sync when iframe drag releases
window.syncEditorSliders = function(sceneNum, elementKey, updatedOverrides) {
  if (editorState.activeSceneNum === sceneNum && editorState.activeElementKey === elementKey) {
    editorState.config.scenes = editorState.config.scenes || {};
    editorState.config.scenes[sceneNum] = editorState.config.scenes[sceneNum] || {};
    editorState.config.scenes[sceneNum][elementKey] = updatedOverrides;
    
    renderTimelineKeyframes();
    syncSlidersToActiveTime();
  }
};

// Sync properties side-panel sliders to the active timecode values
function syncSlidersToActiveTime() {
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key) return;
  
  const defaultsMap = {
    Logo1: { src: 'uploads/openclaw_logo.png', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    Logo2: { src: 'uploads/hermesagent.png', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    Logo3: { src: 'uploads/claude-ai_logo.svg', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    Logo: { src: 'default_logo', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    Mockup: { src: 'default_mockup', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    Avatar: { src: 'uploads/Vivi_full_front.png', x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
  };
  const defaults = defaultsMap[key] || { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  
  // Calculate interpolated values for active playhead time
  const t = editorState.activeTime / 1000;
  
  // Mock window.getBbitsKeyframeOverride logic inside client for side-panel sync
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  const fitMode = overrides.fitMode ?? 'fit';
  const keyframes = overrides.keyframes || [];
  
  // Update Nesting mode radio buttons
  const radios = document.getElementsByName('comp-fit-mode');
  radios.forEach(r => {
    r.checked = r.value === fitMode;
  });
  
  // Render media swap preview box
  const previewDiv = $('comp-media-preview');
  if (overrides.src && overrides.src !== defaults.src) {
    const isVideo = /\.(mp4|webm|mov|ogg)$/i.test(overrides.src);
    if (isVideo) {
      previewDiv.innerHTML = `<video src="${overrides.src}" autoPlay loop muted playsInline style="width:100%;height:100%"></video>`;
    } else {
      previewDiv.innerHTML = `<img src="${overrides.src}" style="width:100%;height:100%;object-fit:contain"/>`;
    }
  } else {
    previewDiv.innerHTML = `<span style="font-size:11px;color:var(--text-faint)">Default template asset active</span>`;
  }
  
  let x = overrides.x ?? defaults.x ?? 0;
  let y = overrides.y ?? defaults.y ?? 0;
  let scale = overrides.scale ?? defaults.scale ?? 1;
  let rotation = overrides.rotation ?? defaults.rotation ?? 0;
  let opacity = overrides.opacity ?? defaults.opacity ?? 1;
  
  let activeKfIdx = null;
  
  if (keyframes.length > 0) {
    const sorted = [...keyframes].sort((a,b) => a.time - b.time);
    
    // Find if playhead is exactly sitting on a keyframe
    const idx = sorted.findIndex(k => Math.abs(k.time - t) < 0.05);
    if (idx >= 0) {
      activeKfIdx = keyframes.findIndex(k => k.time === sorted[idx].time);
      x = sorted[idx].x ?? 0;
      y = sorted[idx].y ?? 0;
      scale = sorted[idx].scale ?? 1;
      rotation = sorted[idx].rotation ?? 0;
      opacity = sorted[idx].opacity ?? 1;
    } else {
      // Linear lerp interpolation
      if (t <= sorted[0].time) {
        const k = sorted[0];
        x = k.x; y = k.y; scale = k.scale; rotation = k.rotation; opacity = k.opacity;
      } else if (t >= sorted[sorted.length - 1].time) {
        const k = sorted[sorted.length - 1];
        x = k.x; y = k.y; scale = k.scale; rotation = k.rotation; opacity = k.opacity;
      } else {
        for (let i = 0; i < sorted.length - 1; i++) {
          const k0 = sorted[i];
          const k1 = sorted[i + 1];
          if (t >= k0.time && t <= k1.time) {
            const prog = (t - k0.time) / (k1.time - k0.time);
            const lerp = (v0, v1, p) => v0 + (v1 - v0) * p;
            x = lerp(k0.x ?? 0, k1.x ?? 0, prog);
            y = lerp(k0.y ?? 0, k1.y ?? 0, prog);
            scale = lerp(k0.scale ?? 1, k1.scale ?? 1, prog);
            rotation = lerp(k0.rotation ?? 0, k1.rotation ?? 0, prog);
            opacity = lerp(k0.opacity ?? 1, k1.opacity ?? 1, prog);
            break;
          }
        }
      }
    }
  }
  
  editorState.selectedKeyframeIdx = activeKfIdx;
  
  // Highlight active diamond if selected
  document.querySelectorAll('.timeline-keyframe').forEach((dia, dIdx) => {
    if (activeKfIdx !== null && dIdx === activeKfIdx) {
      dia.classList.add('selected');
    } else {
      dia.classList.remove('selected');
    }
  });
  
  // Set slider properties values
  $('slider-pos-x').value = Math.round(x);
  $('slider-pos-y').value = Math.round(y);
  $('slider-scale').value = parseFloat(scale).toFixed(2);
  $('slider-rotation').value = Math.round(rotation);
  $('slider-opacity').value = parseFloat(opacity).toFixed(2);
  
  $('val-pos-x').textContent = Math.round(x) + 'px';
  $('val-pos-y').textContent = Math.round(y) + 'px';
  $('val-scale').textContent = parseFloat(scale).toFixed(2);
  $('val-rotation').textContent = Math.round(rotation) + '°';
  $('val-opacity').textContent = parseFloat(opacity).toFixed(2);
}

// Bind properties sliders changes
function handleSliderChange() {
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key) return;
  
  const x = parseInt($('slider-pos-x').value);
  const y = parseInt($('slider-pos-y').value);
  const scale = parseFloat($('slider-scale').value);
  const rotation = parseInt($('slider-rotation').value);
  const opacity = parseFloat($('slider-opacity').value);
  
  $('val-pos-x').textContent = x + 'px';
  $('val-pos-y').textContent = y + 'px';
  $('val-scale').textContent = scale.toFixed(2);
  $('val-rotation').textContent = rotation + '°';
  $('val-opacity').textContent = opacity.toFixed(2);
  
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  const t = editorState.activeTime / 1000;
  
  if (overrides.keyframes && overrides.keyframes.length > 0) {
    // If a keyframe sits at this timecode, update it
    const activeKfIdx = overrides.keyframes.findIndex(k => Math.abs(k.time - t) < 0.15);
    if (activeKfIdx >= 0) {
      overrides.keyframes[activeKfIdx] = { time: overrides.keyframes[activeKfIdx].time, x, y, scale, rotation, opacity };
    } else {
      // Or append a new keyframe
      overrides.keyframes.push({ time: parseFloat(t.toFixed(2)), x, y, scale, rotation, opacity });
    }
  } else {
    // Update static offsets
    overrides.x = x;
    overrides.y = y;
    overrides.scale = scale;
    overrides.rotation = rotation;
    overrides.opacity = opacity;
  }
  
  saveActiveElementConfig(overrides);
}

['slider-pos-x', 'slider-pos-y', 'slider-scale', 'slider-rotation', 'slider-opacity'].forEach(id => {
  $(id)?.addEventListener('input', handleSliderChange);
});

// Bind Nesting Mode toggles
document.getElementsByName('comp-fit-mode').forEach(r => {
  r.addEventListener('change', (e) => {
    const sceneNum = editorState.activeSceneNum;
    const key = editorState.activeElementKey;
    if (!sceneNum || !key) return;
    
    const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
    overrides.fitMode = e.target.value;
    
    saveActiveElementConfig(overrides).then(() => {
      // Nest mode changes require structures inside the iframe to remount, trigger reload
      const iframe = $('comp-preview-iframe');
      if (iframe) iframe.src = iframe.src;
    });
  });
});

// Bind Swapped File uploads
$('btn-comp-upload-media')?.addEventListener('click', () => $('comp-media-input')?.click());
$('comp-media-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key) return;
  
  const form = new FormData();
  form.append('file', file);
  
  $('btn-comp-upload-media').textContent = 'Uploading...';
  const upRes = await fetch('/api/asset/upload', { method: 'POST', body: form });
  const upData = await upRes.json();
  $('btn-comp-upload-media').textContent = '⊕ Upload Media';
  
  if (!upRes.ok) {
    alert('Upload failed: ' + upData.error);
    return;
  }
  
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  overrides.src = upData.path;
  
  await saveActiveElementConfig(overrides);
  
  // Force the preview iframe to reload and render the newly swapped image immediately
  const iframe = $('comp-preview-iframe');
  if (iframe) {
    iframe.src = iframe.src;
  }
  
  e.target.value = '';
});

// Timeline Keyframe track renderer
function renderTimelineKeyframes() {
  const track = $('timeline-track');
  if (!track) return;
  
  // Clean old keyframe diamonds
  track.querySelectorAll('.timeline-keyframe').forEach(d => d.remove());
  
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key) return;
  
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  const keyframes = overrides.keyframes || [];
  
  keyframes.forEach((kf, idx) => {
    const dia = document.createElement('div');
    dia.className = 'timeline-keyframe';
    const percent = (kf.time / 5.0) * 100;
    dia.style.left = `${percent}%`;
    dia.dataset.index = idx;
    
    // Clicking selects the keyframe and moves the playhead directly to it
    dia.addEventListener('click', (e) => {
      e.stopPropagation();
      const timeMs = kf.time * 1000;
      seekTimeline(timeMs);
    });
    
    // Drag keyframe in timecode
    let startMx = 0;
    let startPercent = 0;
    const onKeyframeDrag = (ev) => {
      ev.preventDefault();
      const dx = ev.clientX - startMx;
      const containerW = track.clientWidth;
      const deltaPercent = (dx / containerW) * 100;
      const newPercent = Math.max(0, Math.min(100, startPercent + deltaPercent));
      const newTime = parseFloat(((newPercent / 100) * 5.0).toFixed(2));
      
      kf.time = newTime;
      dia.style.left = `${newPercent}%`;
      
      // Live seek
      seekTimeline(newTime * 1000);
    };
    
    const onKeyframeDragEnd = () => {
      window.removeEventListener('mousemove', onKeyframeDrag);
      window.removeEventListener('mouseup', onKeyframeDragEnd);
      saveActiveElementConfig(overrides);
    };
    
    dia.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      startMx = ev.clientX;
      startPercent = percent;
      window.addEventListener('mousemove', onKeyframeDrag);
      window.addEventListener('mouseup', onKeyframeDragEnd);
    });
    
    track.appendChild(dia);
  });
}

// Add Keyframe node
$('btn-add-keyframe')?.addEventListener('click', () => {
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key) return;
  
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  overrides.keyframes = overrides.keyframes || [];
  
  const t = parseFloat((editorState.activeTime / 1000).toFixed(2));
  
  // Capture current slider values
  const x = parseInt($('slider-pos-x').value);
  const y = parseInt($('slider-pos-y').value);
  const scale = parseFloat($('slider-scale').value);
  const rotation = parseInt($('slider-rotation').value);
  const opacity = parseFloat($('slider-opacity').value);
  
  // If keyframe exists at time, update it. If not, push it
  const idx = overrides.keyframes.findIndex(k => Math.abs(k.time - t) < 0.15);
  if (idx >= 0) {
    overrides.keyframes[idx] = { time: overrides.keyframes[idx].time, x, y, scale, rotation, opacity };
  } else {
    // If we're upgrading from static offsets, initialize keyframes with active values
    if (overrides.keyframes.length === 0) {
      // Add first keyframe at 0s using current coordinates
      overrides.keyframes.push({ time: 0, x, y, scale, rotation, opacity });
    }
    overrides.keyframes.push({ time: t, x, y, scale, rotation, opacity });
  }
  
  saveActiveElementConfig(overrides);
});

// Delete Keyframe node
$('btn-delete-keyframe')?.addEventListener('click', () => {
  const sceneNum = editorState.activeSceneNum;
  const key = editorState.activeElementKey;
  if (!sceneNum || !key || editorState.selectedKeyframeIdx === null) return;
  
  const overrides = editorState.config.scenes?.[sceneNum]?.[key] || {};
  overrides.keyframes.splice(editorState.selectedKeyframeIdx, 1);
  
  editorState.selectedKeyframeIdx = null;
  saveActiveElementConfig(overrides);
});

// Timeline playhead ruler ticks
function initTimelineRuler() {
  const ruler = $('timeline-ruler');
  if (!ruler) return;
  ruler.innerHTML = '';
  
  const trackW = ruler.clientWidth;
  const totalTicks = 20; // tick every 0.25s
  for (let i = 0; i <= totalTicks; i++) {
    const tick = document.createElement('div');
    tick.className = 'timeline-ruler-tick' + (i % 4 === 0 ? ' major' : '');
    const percent = (i / totalTicks) * 100;
    tick.style.left = `${percent}%`;
    
    if (i % 4 === 0) {
      const seconds = (i / 4).toFixed(1) + 's';
      tick.setAttribute('data-time', seconds);
    }
    ruler.appendChild(tick);
  }
}

// Timeline seeking
function seekTimeline(timeMs) {
  editorState.activeTime = Math.max(0, Math.min(5000, timeMs));
  
  // Update playhead labels and scrubber values
  $('timeline-time-label').textContent = `${(editorState.activeTime / 1000).toFixed(2)}s / 5.00s`;
  $('timeline-scrubber').value = editorState.activeTime;
  
  const percent = (editorState.activeTime / 5000) * 100;
  $('timeline-playhead-needle').style.left = `${percent}%`;
  
  // Call seek inside preview iframe
  const iframe = $('comp-preview-iframe');
  if (iframe && iframe.contentWindow && iframe.contentWindow.__hf) {
    iframe.contentWindow.__hf.seek(editorState.activeTime / 1000);
  }
  
  syncSlidersToActiveTime();
}

// Scrubber events
$('timeline-scrubber')?.addEventListener('input', (e) => {
  seekTimeline(parseInt(e.target.value));
});

// Play / Pause loop
$('btn-comp-play')?.addEventListener('click', () => {
  const btn = $('btn-comp-play');
  if (editorState.isPlaying) {
    // Pause
    editorState.isPlaying = false;
    btn.textContent = '▶';
    clearInterval(editorState.playTimer);
  } else {
    // Play
    editorState.isPlaying = true;
    btn.textContent = '⏸';
    
    const startTime = Date.now() - editorState.activeTime;
    editorState.playTimer = setInterval(() => {
      let current = Date.now() - startTime;
      if (current >= 5000) {
        current = 0;
        seekTimeline(0);
        // Reset play loop start
        btn.click();
        btn.click();
      } else {
        seekTimeline(current);
      }
    }, 33);
  }
});
