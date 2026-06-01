const fs = require('fs');
const path = require('path');
const { buildStandaloneHtml } = require('./lib/extractor');

const projectDir = ''; // E.g., 'f:\\projects\\MyHyperFramesProject'

// Load project data on startup
fetch('http://localhost:4999/api/project/load', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dir: projectDir })
})
  .then(() => fetch('http://localhost:4999/api/project/info'))
  .then(r => r.json())
  .then(data => {
    const scenes = data.scenes;
    console.log(`Loaded project with ${scenes.length} scenes. Regenerating standalone extracts...`);

    const outDir = path.join(projectDir, 'extracts');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    // 1. Regenerate individual scene extracts
    scenes.forEach(s => {
      const outPath = path.join(outDir, `scene_${s.num}.html`);
      try {
        buildStandaloneHtml({
          projectDir,
          scenes: [s],
          stripHud: true,
          layerMode: 'normal',
          outputPath: outPath
        });
        console.log(`✅ Regenerated scene_${s.num}`);
      } catch (err) {
        console.error(`❌ Error regenerating scene_${s.num}:`, err.message);
      }
    });

    console.log('\nFinished regenerating extracts! Now verifying compilation...');
    
    // 2. Run verification
    const babel = require('@babel/standalone');
    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.jsx'));
    let errors = 0;

    files.forEach(f => {
      const filePath = path.join(outDir, f);
      try {
        const code = fs.readFileSync(filePath, 'utf8');
        babel.transform(code, {
          presets: ['react'],
          filename: f
        });
      } catch (err) {
        errors++;
        console.error(`❌ Compilation Error in ${f}:`);
        console.error(err.message);
        if (err.loc) {
          console.error(`At Line ${err.loc.line}, Column ${err.loc.column}`);
        }
      }
    });

    console.log(`\nVerification Complete! Errors found: ${errors}`);
  })
  .catch(err => {
    console.error('Failed to load project details from server. Make sure the server is running on port 4999.', err.message);
  });
