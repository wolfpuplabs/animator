/*
 * Test browser: alur utama aplikasi dengan klip demo.
 * Jalankan: npm run test:browser  (atau node tests/browser/app.test.js)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildSite, launch, createReporter, parseGLB, waitIdle, OUT } = require('./harness');

const r = createReporter('App');

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2500);

  r.section('Boot');
  r.check('tidak ada error JS saat boot', errors.length === 0, errors.join('\n      '));
  r.check('canvas WebGL terpasang', await page.locator('#canvas-host canvas').count() === 1);
  r.check('demo otomatis termuat', (await page.locator('#time-display').textContent()).includes('/ 2.40s'));
  r.check('tombol enhance aktif', !(await page.locator('#btn-run').isDisabled()));
  r.check('tombol Enhanced terkunci sebelum diproses', await page.locator('#btn-view-enhanced').isDisabled());

  r.section('Playback');
  const t1 = await page.locator('#time-display').textContent();
  await page.waitForTimeout(700);
  r.check('waktu berjalan saat playing', t1 !== (await page.locator('#time-display').textContent()));

  await page.locator('#btn-play').click();
  const p1 = await page.locator('#time-display').textContent();
  await page.waitForTimeout(600);
  r.check('pause benar-benar menghentikan waktu', p1 === (await page.locator('#time-display').textContent()));

  await page.locator('#btn-play').click();
  await page.locator('#btn-stop').click();
  const afterStop = parseFloat(await page.locator('#time-display').textContent());
  r.check('stop kembali ke awal', afterStop < 0.25, String(afterStop));

  // Handler scrub sendiri yang menulis label waktunya, jadi baca langsung
  // supaya tidak balapan dengan render loop.
  const scrubbed = await page.evaluate(() => {
    const tl = document.getElementById('timeline');
    tl.value = '500';
    tl.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('time-display').textContent;
  });
  r.check('scrub memindahkan waktu', /^1\.2\ds/.test(scrubbed), scrubbed);

  const seek = (v) => page.evaluate((val) => {
    const tl = document.getElementById('timeline');
    tl.value = String(val);
    tl.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  await seek(0); await page.waitForTimeout(80);
  const shotA = await page.locator('#canvas-host canvas').screenshot();
  await seek(400); await page.waitForTimeout(80);
  const shotB = await page.locator('#canvas-host canvas').screenshot();
  r.check('scrub benar-benar memindahkan pose model', !shotA.equals(shotB));
  await page.evaluate(() => document.getElementById('timeline').dispatchEvent(new Event('change', { bubbles: true })));

  r.section('Enhance');
  await page.locator('.preset[data-preset="quality"]').click();
  r.check('preset Quality menyetel fps ke 90', (await page.locator('#val-fps').textContent()) === '90 fps');

  await page.locator('#btn-run').click();
  await waitIdle(page);
  await page.waitForTimeout(300);

  const jitter = await page.locator('#st-jitter').textContent();
  const keys = await page.locator('#st-keys').textContent();
  const flips = await page.locator('#st-flips').textContent();
  r.info('jitter=' + jitter + '  keyframe=' + keys + '  flip=' + flips);
  r.check('jitter turun, bukan naik', jitter.startsWith('−'), jitter);
  r.check('penurunan jitter signifikan (>25%)', parseFloat(jitter.replace(/[^0-9.]/g, '')) > 25, jitter);
  r.check('keyframe dirapatkan dari 8 fps', /\d+ → [\d,]+/.test(keys), keys);
  r.check('quaternion flip terdeteksi & diperbaiki', parseInt(flips, 10) > 0, flips);
  r.check('view pindah otomatis ke Enhanced',
    await page.locator('#btn-view-enhanced').evaluate(e => e.classList.contains('active')));

  r.section('A/B compare');
  await page.keyboard.press('c');
  await page.waitForTimeout(200);
  r.check('tombol C kembali ke Original',
    await page.locator('#btn-view-original').evaluate(e => e.classList.contains('active')));
  const origShot = await page.locator('#canvas-host canvas').screenshot();
  await page.keyboard.press('c');
  await page.waitForTimeout(200);
  r.check('tombol C kembali ke Enhanced',
    await page.locator('#btn-view-enhanced').evaluate(e => e.classList.contains('active')));
  const enhShot = await page.locator('#canvas-host canvas').screenshot();
  r.check('pose original dan enhanced memang berbeda', !origShot.equals(enhShot));

  r.section('Motion trail');
  await page.locator('#opt-trail').check();
  await page.waitForTimeout(400);
  r.check('legend trail muncul', await page.locator('#legend').evaluate(e => e.classList.contains('visible')));
  r.check('tidak ada error setelah trail dinyalakan', errors.length === 0, errors.join('\n      '));

  r.section('Export');
  const glbDl = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-export-glb').click();
  const dl = await glbDl;
  const glbPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(glbPath);
  const buf = fs.readFileSync(glbPath);
  const gltf = parseGLB(buf);
  r.check('berkas .glb dengan header glTF biner', !!gltf, buf.slice(0, 4).toString('ascii'));
  r.check('GLB berisi animasi', !!gltf && Array.isArray(gltf.animations) && gltf.animations.length > 0,
    gltf ? JSON.stringify(Object.keys(gltf)) : '');
  if (gltf && gltf.animations) {
    const n = gltf.accessors[gltf.animations[0].samplers[0].input].count;
    r.info(gltf.animations.length + ' klip, ' + gltf.animations[0].channels.length + ' channel, ' + n + ' keyframe/sampler');
    r.check('keyframe hasil enhance ikut terekspor', n > 20, String(n));
  }

  const jsonDl = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('#btn-export-json').click();
  const jd = await jsonDl;
  const jsonPath = path.join(OUT, jd.suggestedFilename());
  await jd.saveAs(jsonPath);
  const clipJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  r.check('JSON klip valid dan berisi 3 track',
    Array.isArray(clipJson.tracks) && clipJson.tracks.length === 3, JSON.stringify(Object.keys(clipJson)));

  r.section('Reset');
  await page.locator('#btn-reset').click();
  await page.waitForTimeout(300);
  r.check('kembali ke original',
    await page.locator('#btn-view-original').evaluate(e => e.classList.contains('active')));
  r.check('tombol Enhanced terkunci lagi', await page.locator('#btn-view-enhanced').isDisabled());
  r.check('statistik dibersihkan', (await page.locator('#st-jitter').textContent()) === '—');

  await page.locator('#btn-run').click();
  await waitIdle(page);
  await page.waitForTimeout(200);
  r.check('enhance ulang setelah reset tetap jalan',
    (await page.locator('#st-jitter').textContent()) !== '—');

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'app.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
