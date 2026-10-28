/*
 * Test browser: model harus terlihat berapa pun satuan ukurannya.
 *
 * Bug yang dijaga: kabut, grid, lantai, dan kamera bayangan dulu memakai
 * nilai tetap yang hanya benar untuk skena seukuran demo (sekitar 5 unit).
 * Berkas dunia nyata datang dalam satuan apa saja — FBX dari perkakas
 * motion capture umumnya sentimeter, jadi karakter 1,6 meter masuk sebagai
 * 160 unit. Dengan kabut tetap 18-55 unit, model sejauh itu dirender
 * persis warna latar: viewport tampak kosong padahal framing-nya benar.
 *
 * Diukur dari piksel, bukan dari angka internal.
 */
'use strict';

const path = require('path');
const { buildSite, launch, createReporter, waitIdle, OUT } = require('./harness');

const r = createReporter('Scale');

/** GLB berisi sosok sederhana dengan tinggi yang bisa ditentukan. */
async function makeGLB(page, height) {
  const b64 = await page.evaluate(async (H) => {
    const root = new THREE.Group();
    root.name = 'Subject';
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.85
    });
    // CapsuleGeometry baru ada di three r140; r128 belum punya.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.12, H * 0.12, H * 0.6, 14), mat);
    body.name = 'Body';
    body.position.y = H * 0.5;
    root.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.14, 20, 14), mat);
    head.position.y = H * 0.88;
    root.add(head);

    const fps = 8, dur = 2, n = Math.round(dur * fps) + 1;
    const times = [], vals = [];
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      times.push(t);
      vals.push(Math.sin(t * 3) * H * 0.15, H * 0.05 * Math.abs(Math.sin(t * 5)), 0);
    }
    const clip = new THREE.AnimationClip('Move', dur,
      [new THREE.VectorKeyframeTrack('Subject.position', times, vals)]);

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      // GLTFExporter memakai parse(input, onDone, onError, options).
      // Di tanda tangan lama options ada di slot ketiga; kalau salah,
      // binary:true dan daftar animasinya diam-diam dibuang.
      try { exporter.parse(root, res, rej, { binary: true, animations: [clip] }); }
      catch (err) { rej(err); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, height);
  return Buffer.from(b64, 'base64');
}

const OVERLAYS = '.stats-card, .ab-switch, .legend, .toast, .overlay';

/** Berapa banyak piksel yang benar-benar berbeda dari warna latar. */
async function visiblePixels(page) {
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => { el.style.visibility = 'hidden'; });
  }, OVERLAYS);
  const shot = await page.locator('#canvas-host canvas').screenshot();
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => { el.style.visibility = ''; });
  }, OVERLAYS);

  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const w = 360, h = Math.round(360 * img.height / img.width);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;

    let bright = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        if (lum > 0.5) {
          bright++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const total = w * h;
    if (maxX < 0) return { ratio: 0, total };
    return {
      ratio: bright / total, total,
      cx: (minX + maxX) / 2 / w, cy: (minY + maxY) / 2 / h,
      fill: Math.max((maxX - minX) / w, (maxY - minY) / h)
    };
  }, shot.toString('base64'));
}

const seek = (page, v) => page.evaluate((val) => {
  const tl = document.getElementById('timeline');
  tl.value = String(val);
  tl.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

(async () => {
  const url = await buildSite();
  const browser = await launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2200);

  // 160 unit meniru karakter 1,6 m yang diekspor dalam sentimeter — ukuran
  // yang keluar dari perkakas motion capture seperti RGB MoCap.
  // 0,05 unit menguji sisi sebaliknya.
  const CASES = [
    { height: 0.05, label: 'sangat kecil (0,05 unit)' },
    { height: 2, label: 'seukuran demo (2 unit)' },
    { height: 160, label: 'skala sentimeter (160 unit)' },
    { height: 5000, label: 'sangat besar (5000 unit)' }
  ];

  for (const item of CASES) {
    r.section(item.label);
    const glb = await makeGLB(page, item.height);
    await page.setInputFiles('#file-input',
      { name: 'subject.glb', mimeType: 'model/gltf-binary', buffer: glb });
    await waitIdle(page, 30000);
    await page.locator('#btn-play').click();
    await seek(page, 0);
    await page.waitForTimeout(500);

    const px = await visiblePixels(page);
    r.info('piksel terang ' + (px.ratio * 100).toFixed(2) + '%' +
      (px.cx !== undefined ? ('  pusat ' + px.cx.toFixed(2) + ', ' + px.cy.toFixed(2) +
        '  isi ' + (px.fill * 100).toFixed(0) + '%') : ''));

    r.check('model benar-benar terlihat', px.ratio > 0.004,
      (px.ratio * 100).toFixed(3) + '% piksel terang — kemungkinan tertelan kabut');
    if (px.cx !== undefined) {
      r.check('berada di tengah', Math.abs(px.cx - 0.5) < 0.1 && Math.abs(px.cy - 0.5) < 0.12,
        px.cx.toFixed(2) + ', ' + px.cy.toFixed(2));
      r.check('proporsi isi frame wajar', px.fill > 0.15 && px.fill < 0.8,
        (px.fill * 100).toFixed(0) + '%');
    }

    await page.locator('#btn-play').click();
    await page.waitForTimeout(150);
  }

  r.section('Pengkabelan FBX');
  r.check('FBXLoader tersedia di halaman',
    await page.evaluate(() => typeof THREE.FBXLoader === 'function'));
  r.check('dropzone menerima .fbx',
    (await page.locator('#file-input').getAttribute('accept')).indexOf('.fbx') !== -1,
    await page.locator('#file-input').getAttribute('accept'));
  r.check('label dropzone menyebut FBX',
    (await page.locator('#dropzone .label').textContent()).indexOf('FBX') !== -1,
    await page.locator('#dropzone .label').textContent());

  // Berkas rusak harus memberi pesan khusus FBX, bukan pesan glTF —
  // itu membuktikan ekstensinya benar-benar dirutekan ke pemuat FBX.
  await page.setInputFiles('#file-input', {
    name: 'rusak.fbx', mimeType: 'application/octet-stream',
    buffer: Buffer.from('ini jelas bukan FBX')
  });
  await page.waitForTimeout(1500);
  const toastText = await page.locator('#toast').textContent();
  r.info('pesan: ' + toastText);
  r.check('FBX rusak memberi pesan khusus FBX', /FBX/.test(toastText), toastText);
  r.check('aplikasi tidak rusak setelah gagal memuat',
    await page.locator('#canvas-host canvas').count() === 1);

  r.section('Final');
  r.check('tidak ada error JS yang tak tertangani',
    errors.filter(e => !/rusak\.fbx|FBX/i.test(e)).length === 0,
    errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'scale.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
