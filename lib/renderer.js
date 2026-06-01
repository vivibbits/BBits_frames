// ─── BBits Studio — renderer.js ──────────────────────────────────────────────
// Spawns `npx hyperframes render` and streams stdout/stderr to a list of SSE clients.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

let activeProcess = null;
let activeBackup = null; // Store active index.html backup to restore on cancel/crash
const sseClients = new Set();
let renderQueue = [];

function addSseClient(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}

function processNextJob() {
  if (renderQueue.length === 0) {
    broadcast('batch_done', { message: 'All batch render jobs completed successfully!' });
    return;
  }

  const job = renderQueue.shift();
  const { projectDir, outputPath, inputHtml, layerMode = 'normal', pngSequence = false, sceneNum = 'Reel' } = job;

  // If a custom input HTML was given, temporarily swap index.html
  if (inputHtml && fs.existsSync(inputHtml)) {
    const indexPath = path.join(projectDir, 'index.html');
    activeBackup = { indexPath, backup: fs.readFileSync(indexPath) };
    fs.copyFileSync(inputHtml, indexPath);
  }

  const args = ['hyperframes', 'render', '--output', outputPath];
  if (pngSequence) args.push('--format', 'png-sequence');

  broadcast('start', { outputPath, layerMode, pngSequence, sceneNum, remaining: renderQueue.length });
  broadcast('log', { text: `\n[BATCH RUNNING] Scene ${sceneNum} → ${outputPath} (${renderQueue.length} remaining in queue)\n` });

  const proc = spawn('npx', args, {
    cwd: projectDir,
    shell: true,
    env: { ...process.env },
  });

  activeProcess = proc;

  proc.stdout.on('data', d => broadcast('log', { text: d.toString() }));
  proc.stderr.on('data', d => broadcast('log', { text: d.toString() }));

  proc.on('close', code => {
    // Restore original index.html if we swapped it
    if (activeBackup) {
      try {
        fs.writeFileSync(activeBackup.indexPath, activeBackup.backup);
      } catch (err) {
        console.error('Error restoring index.html:', err.message);
      }
      activeBackup = null;
    }
    
    activeProcess = null;
    broadcast('done', { code, outputPath, sceneNum });
    broadcast('log', { text: `[BATCH DONE] Scene ${sceneNum} completed with code ${code}\n` });

    // Process next queued job
    processNextJob();
  });
}

/**
 * Run a render job.
 * @param {object} opts
 * @param {string} opts.projectDir    - Path to the HyperFrames project (where index.html lives)
 * @param {string} opts.outputPath    - Absolute path for the output MP4
 * @param {string} [opts.inputHtml]   - Custom index.html override (for extracted scenes)
 * @param {string} [opts.layerMode]   - 'normal' | 'greenscreen' | 'alpha'
 * @param {boolean} [opts.pngSequence]- Export PNG sequence instead of MP4
 */
function startRender(opts) {
  if (activeProcess) {
    broadcast('error', { msg: 'A render is already running. Wait or cancel it first.' });
    return false;
  }

  renderQueue = [{ ...opts, sceneNum: opts.sceneNum || 'Reel' }];
  processNextJob();
  return true;
}

/**
 * Queue a list of render jobs for batch processing.
 * @param {Array<object>} jobs 
 */
function queueRenderJobs(jobs) {
  if (activeProcess) {
    broadcast('error', { msg: 'A render is already running. Wait or cancel it first.' });
    return false;
  }

  renderQueue = [...jobs];
  processNextJob();
  return true;
}

function cancelRender() {
  if (activeProcess) {
    const pid = activeProcess.pid;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', pid], { shell: true });
    } else {
      activeProcess.kill();
    }
    activeProcess = null;
    renderQueue = []; // Clear queue on cancel

    // Restore original index.html on cancel
    if (activeBackup) {
      try {
        fs.writeFileSync(activeBackup.indexPath, activeBackup.backup);
      } catch (err) {
        console.error('Error restoring index.html on cancel:', err.message);
      }
      activeBackup = null;
    }

    broadcast('cancelled', {});
    return true;
  }
  return false;
}

module.exports = { addSseClient, broadcast, startRender, queueRenderJobs, cancelRender };
