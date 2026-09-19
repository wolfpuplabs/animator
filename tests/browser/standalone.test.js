/*
 * Test browser untuk standalone.html — berkas tunggal yang dibagikan.
 *
 * Berkas inilah yang paling mungkin dipakai orang lain apa adanya, jadi
 * dia harus benar-benar dijalankan, bukan cuma dicek isinya.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildStandaloneSite, launch, createReporter, parseGLB, waitIdle, OUT } = require('./harness');

const r = createReporter('Standalone');

(async () => {
  const url = buildStandaloneSite();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2500);

  r.section('Boot dari satu berkas');
  r.check('tidak ada error JS', errors.length === 0, errors.join('\n      '));
  r.check('canvas WebGL terpasang', await page.locator('#canvas-host canvas').count() === 1);
  r.check('gaya ikut ter-inline (sidebar ter-layout)',
    await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width > 200));
  r.check('demo termuat', (await page.locator('#time-display').textContent()).includes('/ 2.40s'));

  r.section('Enhance');
  await page.locator('.preset[data-preset="quality"]').click();
  await page.locator('#btn-run').click();
  await waitIdle(page);
  await page.waitForTimeout(300);
  const jitter = await page.locator('#st-jitter').textContent();
  r.info('jitter=' + jitter + '  keyframe=' + (await page.locator('#st-keys').textContent()));
  r.check('jitter turun', jitter.startsWith('−'), jitter);

  r.section('Export');
  const dlP = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-export-glb').click();
  const dl = await dlP;
  const out = path.join(OUT, 'standalone_' + dl.suggestedFilename());
  await dl.saveAs(out);
  const gltf = parseGLB(fs.readFileSync(out));
  r.check('GLB valid dengan animasi',
    !!gltf && Array.isArray(gltf.animations) && gltf.animations.length > 0);

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0, errors.join('\n      '));

  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
