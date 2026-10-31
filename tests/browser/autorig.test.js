/*
 * Test browser: pasang rangka otomatis pada model yang tidak punya tulang.
 *
 * Mutu tebakannya diukur di tests/autorig.test.js, terhadap rangka
 * avatar yang posisinya sudah diketahui. Yang TIDAK bisa dibuktikan di
 * sana, dan karena itu diuji di sini, adalah rantai aplikasinya:
 * tombolnya muncul tepat ketika ada yang bisa ditolong, menekannya
 * benar-benar membuka opsi skinning, rig yang jadi selamat sampai ke
 * berkas GLB, dan model yang bukan humanoid ditolak dengan alasan
 * alih-alih dirusak.
 */
'use strict';

const path = require('path');
const { buildSite, launch, createReporter, parseGLB, OUT } = require('./harness');

const r = createReporter('Auto-rig');

/**
 * GLB sosok humanoid pose T TANPA tulang sama sekali — persis bentuk
 * model yang jadi alasan fitur ini ada: hasil scan atau konversi OBJ.
 */
async function makeStatueGLB(page) {
  const b64 = await page.evaluate(async () => {
    const parts = [];
    const add = (w, h, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d, 4, 8, 4);
      g.translate(x, y, z);
      parts.push(g);
    };
    //                w     h     d      x      y      z
    add(0.40, 0.54, 0.24,  0.00, 1.17, 0);   // badan
    add(0.18, 0.22, 0.20,  0.00, 1.55, 0);   // kepala
    add(0.72, 0.13, 0.13,  0.56, 1.40, 0);   // lengan kiri
    add(0.72, 0.13, 0.13, -0.56, 1.40, 0);   // lengan kanan
    add(0.17, 0.90, 0.17,  0.12, 0.45, 0);   // tungkai kiri
    add(0.17, 0.90, 0.17, -0.12, 0.45, 0);   // tungkai kanan
    add(0.17, 0.08, 0.30,  0.12, 0.04, 0.07); // telapak kiri
    add(0.17, 0.08, 0.30, -0.12, 0.04, 0.07); // telapak kanan

    const merged = THREE.BufferGeometryUtils
      ? THREE.BufferGeometryUtils.mergeGeometries(parts)
      : null;

    const root = new THREE.Group();
    root.name = 'Patung';
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.85
    });
    if (merged) {
      const m = new THREE.Mesh(merged, mat);
      m.name = 'Body';
      root.add(m);
    } else {
      // Tanpa BufferGeometryUtils tiap bagian jadi mesh sendiri. Itu
      // justru lebih mirip model sungguhan, yang sering terpecah per
      // material.
      parts.forEach((g, i) => {
        const m = new THREE.Mesh(g, mat);
        m.name = 'Part' + i;
        root.add(m);
      });
    }

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      try { exporter.parse(root, res, rej, { binary: true }); }
      catch (e) { rej(e); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

/** GLB kotak polos — bentuk yang HARUS ditolak. */
async function makeBoxGLB(page) {
  const b64 = await page.evaluate(async () => {
    const g = new THREE.BoxGeometry(1, 2, 1, 8, 16, 8);
    const root = new THREE.Group();
    root.name = 'Kotak';
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    m.name = 'Body';
    root.add(m);
    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => exporter.parse(root, res, rej, { binary: true }));
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

const state = (page) => page.evaluate(() => ({
  buttonShown: document.getElementById('btn-autorig').style.display !== 'none',
  noteShown: document.getElementById('autorig-note').style.display !== 'none',
  skinLocked: document.getElementById('opt-skin').disabled,
  skinStatus: document.getElementById('skin-status').textContent,
  toast: document.getElementById('toast').textContent
}));

(async () => {
  const url = await buildSite();
  const browser = await launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1280, height: 860 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/404|Failed to load resource/.test(t)) {
      errors.push('console: ' + t.slice(0, 200));
    }
  });

  await page.goto(url);
  await page.waitForTimeout(2000);

  r.section('Tombolnya cuma muncul saat ada yang bisa ditolong');

  const fresh = await state(page);
  r.check('tidak ditawarkan sebelum ada model', !fresh.buttonShown);

  await page.locator('#btn-demo').click();
  await page.waitForTimeout(1200);
  const onDemo = await state(page);
  r.check('tidak ditawarkan untuk avatar bawaan yang sudah ber-rig',
    !onDemo.buttonShown, 'tombolnya muncul padahal avatarnya sudah punya tulang');

  r.section('Patung tanpa tulang');

  const statue = await makeStatueGLB(page);
  r.info('GLB patung: ' + (statue.length / 1024).toFixed(0) + ' KB');
  await page.setInputFiles('#file-input',
    { name: 'patung.glb', mimeType: 'model/gltf-binary', buffer: statue });
  await page.waitForTimeout(2500);

  const loaded = await state(page);
  r.info('setelah dimuat: ' + loaded.skinStatus);
  r.check('opsi skinning terkunci untuk patung', loaded.skinLocked);
  r.check('rangka otomatis ditawarkan', loaded.buttonShown);
  r.check('alasannya dijelaskan', loaded.noteShown);

  r.section('Memasang rangka');

  await page.locator('#btn-autorig').click();
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 120000 });
  await page.waitForTimeout(800);

  const rigged = await state(page);
  r.info('pesan: ' + rigged.toast);
  r.check('opsi skinning terbuka setelah rangka terpasang', !rigged.skinLocked,
    rigged.skinStatus);
  r.check('tawaran rangka hilang setelah dipakai', !rigged.buttonShown);
  r.check('jumlah tulang dilaporkan', /\d+\s*tulang|\d+\s*bones/.test(rigged.toast),
    rigged.toast);

  const matched = /(\d+)\s*(?:dari|of)\s*15/.exec(rigged.toast);
  r.check('tulang kanonik dilaporkan tercocok', !!matched, rigged.toast);
  if (matched) {
    r.info('tulang kanonik tercocok: ' + matched[1] + '/15');
    r.check('seluruh 15 tulang kanonik dikenali retarget',
      parseInt(matched[1], 10) === 15, matched[1] + '/15');
  }

  r.section('Rig-nya selamat sampai ke berkas');

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#btn-export-glb').click();
  const file = await dl;
  const out = path.join(OUT, 'autorig_' + file.suggestedFilename());
  await file.saveAs(out);
  const fs = require('fs');
  const gltf = parseGLB(fs.readFileSync(out));
  r.check('GLB hasil ekspor valid', !!gltf);
  r.check('skin ikut terekspor', !!gltf && !!gltf.skins && gltf.skins.length > 0,
    gltf && gltf.skins ? String(gltf.skins.length) : 'tidak ada');
  if (gltf && gltf.skins && gltf.skins.length) {
    const joints = gltf.skins[0].joints.length;
    r.info('skin berisi ' + joints + ' joint');
    r.check('jumlah joint masuk akal', joints >= 15 && joints <= 32, String(joints));
  }

  r.section('Bentuk yang bukan sosok berdiri ditolak');

  const box = await makeBoxGLB(page);
  await page.setInputFiles('#file-input',
    { name: 'kotak.glb', mimeType: 'model/gltf-binary', buffer: box });
  await page.waitForTimeout(2000);

  const boxLoaded = await state(page);
  r.check('rangka otomatis ditawarkan juga untuk kotak', boxLoaded.buttonShown);

  await page.locator('#btn-autorig').click();
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 120000 });
  await page.waitForTimeout(600);

  const boxRigged = await state(page);
  r.info('pesan: ' + boxRigged.toast);
  r.check('kotak ditolak, bukan dirusak', boxRigged.skinLocked,
    'opsi skinning terbuka padahal rangkanya tidak dipasang');
  r.check('alasan penolakan disebut',
    /rentang lengan|bahu|arm span|shoulder/i.test(boxRigged.toast), boxRigged.toast);
  r.check('tawaran rangka tetap ada setelah ditolak', boxRigged.buttonShown);

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0,
    errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'autorig.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
