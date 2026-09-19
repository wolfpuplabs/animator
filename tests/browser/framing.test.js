/*
 * Test browser: model harus muncul utuh dan di tengah setelah dimuat.
 *
 * Bug yang dijaga: Box3.setFromObject memakai bounding box geometri di
 * bind pose, jadi untuk skinned mesh ukurannya bisa meleset berkali lipat
 * dan model muncul raksasa, terpotong, melenceng dari tengah.
 *
 * Diukur dari piksel yang benar-benar dirender, bukan dari angka internal,
 * supaya yang diuji adalah apa yang dilihat pengguna.
 */
'use strict';

const path = require('path');
const { buildSite, launch, createReporter, waitIdle, OUT } = require('./harness');

const r = createReporter('Framing');

/** GLB berisi rig yang bone-nya membawa vertex keluar dari kotak bind pose. */
async function makeScaledRigGLB(page) {
  const b64 = await page.evaluate(async () => {
    const SEG = 4, H = 200; // geometri "dalam cm", armature diskalakan 0.01
    const geom = new THREE.CylinderGeometry(30, 30, H, 8, SEG * 3, true);
    const pos = geom.attributes.position, si = [], sw = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + H / 2, s = (y / H) * (SEG - 1);
      const idx = Math.min(Math.floor(s), SEG - 2), w = s - idx;
      si.push(idx, idx + 1, 0, 0);
      sw.push(1 - w, w, 0, 0);
    }
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));

    const bones = [];
    let prev = null;
    for (let i = 0; i < SEG; i++) {
      const bone = new THREE.Bone();
      bone.name = 'J' + i;
      bone.position.y = i === 0 ? -H / 2 : H / (SEG - 1);
      if (prev) prev.add(bone);
      bones.push(bone);
      prev = bone;
    }

    // putih terang supaya gampang dibedakan dari latar saat piksel dipindai
    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, side: THREE.DoubleSide
    }));
    mesh.name = 'Body';

    const armature = new THREE.Group();
    armature.name = 'Armature';
    armature.scale.setScalar(0.01);
    armature.position.set(0, 1, 0);
    armature.add(bones[0]);
    armature.add(mesh);
    mesh.bind(new THREE.Skeleton(bones));

    const root = new THREE.Group();
    root.name = 'Root';
    root.add(armature);

    const fps = 8, dur = 2, n = Math.round(dur * fps) + 1, tracks = [];
    for (let b = 1; b < SEG; b++) {
      const times = [], vals = [], q = new THREE.Quaternion(), e = new THREE.Euler();
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        times.push(t);
        e.set(0, 0, Math.sin(t * 2 + b) * 0.4);
        q.setFromEuler(e);
        vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack('J' + b + '.quaternion', times, vals));
    }

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      try { exporter.parse(root, res, { binary: true, animations: [new THREE.AnimationClip('wave', dur, tracks)] }); }
      catch (err) { rej(err); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

/**
 * Kotak model dalam koordinat ternormalisasi, dipindai dari piksel terang.
 *
 * Screenshot-nya diambil Playwright lalu dikirim balik ke halaman untuk
 * di-decode. Membaca canvas WebGL langsung lewat drawImage menghasilkan
 * gambar kosong kecuali preserveDrawingBuffer dinyalakan — dan itu biaya
 * runtime yang tidak pantas dibayar hanya demi bisa diuji.
 */
const OVERLAY_SELECTORS = '.stats-card, .ab-switch, .legend, .toast, .overlay';

async function measure(page) {
  // Screenshot elemen ikut menangkap apa pun yang menumpuk di atasnya —
  // panel statistik dan pil A/B akan terbaca sebagai piksel model dan
  // membuat pengukuran ini lolos karena alasan yang salah.
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => { el.dataset.prevVis = el.style.visibility; el.style.visibility = 'hidden'; });
  }, OVERLAY_SELECTORS);

  const shot = await page.locator('#canvas-host canvas').screenshot();

  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => { el.style.visibility = el.dataset.prevVis || ''; });
  }, OVERLAY_SELECTORS);

  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = 'data:image/png;base64,' + b64;
    });
    const w = 480, h = Math.round(480 * img.height / img.width);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // model diberi emissive putih; latar dan grid jauh lebih redup
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        if (lum > 0.55) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return {
      left: minX / w, right: maxX / w, top: minY / h, bottom: maxY / h,
      cx: (minX + maxX) / 2 / w, cy: (minY + maxY) / 2 / h,
      width: (maxX - minX) / w, height: (maxY - minY) / h,
      coverage: count / (w * h)
    };
  }, shot.toString('base64'));
}

/*
 * Rentang seberapa besar model boleh mengisi frame.
 *
 * Bukan sekadar "tidak terpotong": bug bounding box yang mau dijaga di
 * sini membuat kamera dua kali terlalu dekat, dan pada rig uji ini
 * hasilnya masih muat di layar meski jelas salah. Yang membedakan adalah
 * ukurannya — 38% tinggi frame saat benar, 76% saat bounding box-nya
 * memakai bind pose. Ambang longgar akan lolos untuk dua-duanya.
 */
const MIN_FILL = 0.20;
const MAX_FILL = 0.62;

/*
 * Seberapa jauh pusat model boleh menyimpang dari pusat kanvas saat
 * pertama muncul.
 *
 * Toleransi longgar tidak berguna di sini: dengan kamera yang membidik
 * pusat kotak SEPANJANG animasi, model demo mendarat di 0.40, 0.59 —
 * jelas melenceng, tapi masih lolos ambang 0.18/0.22 yang dipakai versi
 * pertama test ini.
 */
const CENTER_TOLERANCE = 0.08;
const centered = (box) =>
  Math.abs(box.cx - 0.5) <= CENTER_TOLERANCE && Math.abs(box.cy - 0.5) <= CENTER_TOLERANCE;

const fill = (box) => Math.max(box.width, box.height);
const inBand = (box) => fill(box) >= MIN_FILL && fill(box) <= MAX_FILL;
const describe = (box) =>
  box.width.toFixed(2) + ' x ' + box.height.toFixed(2) + ' (isi ' + (fill(box) * 100).toFixed(0) + '%)';

const seek = (page, v) => page.evaluate((val) => {
  const tl = document.getElementById('timeline');
  tl.value = String(val);
  tl.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2000);

  r.section('Rig dengan armature berskala');
  const glb = await makeScaledRigGLB(page);
  await page.setInputFiles('#file-input', { name: 'scaled_rig.glb', mimeType: 'model/gltf-binary', buffer: glb });
  await waitIdle(page, 20000);
  await page.locator('#btn-play').click(); // pause supaya pengukuran stabil
  await seek(page, 0);
  await page.waitForTimeout(400);

  const box = await measure(page);
  r.check('model terlihat di viewport', !!box, 'tidak ada piksel model yang terdeteksi');
  if (!box) { await browser.close(); r.finish(); return; }
  r.info('kotak layar: x ' + box.left.toFixed(2) + '–' + box.right.toFixed(2) +
    '  y ' + box.top.toFixed(2) + '–' + box.bottom.toFixed(2) +
    '  (' + (box.coverage * 100).toFixed(1) + '% area)');

  r.check('tidak terpotong tepi kiri/kanan', box.left > 0.01 && box.right < 0.99,
    box.left.toFixed(3) + ' .. ' + box.right.toFixed(3));
  r.check('tidak terpotong tepi atas/bawah', box.top > 0.01 && box.bottom < 0.99,
    box.top.toFixed(3) + ' .. ' + box.bottom.toFixed(3));
  r.check('berada di tengah saat pertama muncul', centered(box),
    'pusat di ' + box.cx.toFixed(3) + ', ' + box.cy.toFixed(3) +
    ' (batas ' + CENTER_TOLERANCE + ')');
  r.check('mengisi frame dengan proporsi wajar', inBand(box),
    describe(box) + ' — di luar rentang ' + MIN_FILL + '–' + MAX_FILL);

  r.section('Tetap utuh sepanjang animasi');
  let worstLeft = 1, worstRight = 0, worstTop = 1, worstBottom = 0, worstFill = 0;
  for (const at of [250, 500, 750, 1000]) {
    await seek(page, at);
    await page.waitForTimeout(220);
    const b = await measure(page);
    if (!b) { r.check('frame ' + at + ' terlihat', false, 'model hilang'); continue; }
    worstLeft = Math.min(worstLeft, b.left);
    worstRight = Math.max(worstRight, b.right);
    worstTop = Math.min(worstTop, b.top);
    worstBottom = Math.max(worstBottom, b.bottom);
    worstFill = Math.max(worstFill, fill(b));
  }
  r.info('batas terjauh sepanjang klip: x ' + worstLeft.toFixed(2) + '–' + worstRight.toFixed(2) +
    '  y ' + worstTop.toFixed(2) + '–' + worstBottom.toFixed(2) +
    '  (isi maks ' + (worstFill * 100).toFixed(0) + '%)');
  r.check('model tidak keluar frame saat animasi diputar',
    worstLeft > 0.005 && worstRight < 0.995 && worstTop > 0.005 && worstBottom < 0.995);
  r.check('ukuran tetap wajar di sepanjang klip', worstFill <= MAX_FILL,
    (worstFill * 100).toFixed(0) + '% > ' + (MAX_FILL * 100) + '%');

  r.section('Model biasa tanpa skeleton tetap benar');
  await page.locator('#btn-demo').click();
  await page.waitForTimeout(900);
  await page.locator('#btn-play').click();
  await seek(page, 0);
  await page.waitForTimeout(400);
  const demo = await measure(page);
  r.check('demo terlihat', !!demo, 'tidak terdeteksi');
  if (demo) {
    r.info('demo: ' + describe(demo) + '  pusat ' + demo.cx.toFixed(2) + ', ' + demo.cy.toFixed(2));
    r.check('demo tidak terpotong',
      demo.left > 0.01 && demo.right < 0.99 && demo.top > 0.01 && demo.bottom < 0.99,
      JSON.stringify([demo.left.toFixed(2), demo.right.toFixed(2), demo.top.toFixed(2), demo.bottom.toFixed(2)]));
    r.check('demo mengisi frame dengan proporsi wajar', inBand(demo), describe(demo));
    // Demo melompat, jadi kotak sepanjang animasi jauh lebih tinggi
    // daripada modelnya sendiri — justru kasus yang paling gampang
    // membuat pose awal melenceng dari tengah.
    r.check('demo berada di tengah saat pertama muncul', centered(demo),
      'pusat di ' + demo.cx.toFixed(3) + ', ' + demo.cy.toFixed(3));
  }

  r.section('Final');
  r.check('tidak ada error JS', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'framing.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
