/*
 * Test browser: tangkapan video dipindahkan ke model yang diunggah.
 *
 * Alurnya persis yang dilakukan pengguna: muat karakter ber-rig lebih
 * dulu, baru jatuhkan videonya. Yang dipastikan di sini bukan cuma klip
 * tangkapan terbentuk, tapi bahwa MODELNYA yang bergerak — model asli
 * tetap ada di layar, dan posenya berubah seiring waktu klip.
 *
 * Model ujinya dibangun di dalam halaman dengan nama tulang ala Mixamo,
 * jadi tidak ada berkas yang perlu ikut repo dan pencocokan namanya ikut
 * teruji di jalur yang sebenarnya.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const H = require('./harness');

const r = H.createReporter('Retarget');

(async () => {
  if (!await H.ensureMediaPipeModel()) {
    console.log('\n⚠️  Retarget: DILEWAT — model deteksi pose tidak tersedia.\n');
    process.exit(0);
  }
  const person = await H.ensurePersonImage();
  if (!person) {
    console.log('\n⚠️  Retarget: DILEWAT — foto uji tidak tersedia.\n');
    process.exit(0);
  }

  const url = await H.buildSite();
  const browser = await H.launch();
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
  await page.waitForTimeout(2200);

  /* ---------------------------------------------------------------- *
   * Karakter ber-rig, dinamai ala Mixamo
   * ---------------------------------------------------------------- */

  r.section('Memuat karakter ber-rig');
  const modelB64 = await page.evaluate(async () => {
    // Humanoid sederhana: satu tulang per anggota badan, nama Mixamo.
    const spec = [
      ['mixamorig:Hips', null, [0, 1.0, 0]],
      ['mixamorig:Spine', 'mixamorig:Hips', [0, 0.22, 0]],
      ['mixamorig:Spine2', 'mixamorig:Spine', [0, 0.24, 0]],
      ['mixamorig:LeftArm', 'mixamorig:Spine2', [0.18, 0.16, 0]],
      ['mixamorig:LeftForeArm', 'mixamorig:LeftArm', [0.27, 0, 0]],
      ['mixamorig:LeftHand', 'mixamorig:LeftForeArm', [0.25, 0, 0]],
      ['mixamorig:RightArm', 'mixamorig:Spine2', [-0.18, 0.16, 0]],
      ['mixamorig:RightForeArm', 'mixamorig:RightArm', [-0.27, 0, 0]],
      ['mixamorig:RightHand', 'mixamorig:RightForeArm', [-0.25, 0, 0]],
      ['mixamorig:LeftUpLeg', 'mixamorig:Hips', [0.10, -0.05, 0]],
      ['mixamorig:LeftLeg', 'mixamorig:LeftUpLeg', [0, -0.45, 0]],
      ['mixamorig:LeftFoot', 'mixamorig:LeftLeg', [0, -0.45, 0]],
      ['mixamorig:RightUpLeg', 'mixamorig:Hips', [-0.10, -0.05, 0]],
      ['mixamorig:RightLeg', 'mixamorig:RightUpLeg', [0, -0.45, 0]],
      ['mixamorig:RightFoot', 'mixamorig:RightLeg', [0, -0.45, 0]]
    ];

    const bones = [], byName = {};
    spec.forEach(([name, parent, pos]) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(pos[0], pos[1], pos[2]);
      byName[name] = b;
      if (parent) byName[parent].add(b);
      bones.push(b);
    });

    // Satu batang per tulang, berbobot penuh ke tulangnya sendiri.
    const root = new THREE.Group();
    root.name = 'Karakter';
    root.add(bones[0]);
    root.updateMatrixWorld(true);

    // Satu kotak padat per tulang. Bentuk yang terlalu tipis membuat
    // perubahan siluetnya nyaris tak terukur dari piksel, padahal
    // modelnya benar-benar bergerak — jadi sosoknya dibuat berisi.
    const pos = [], idx = [], wgt = [], tri = [];
    const FACES = [
      [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
      [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
      [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]
    ];
    bones.forEach((bone, i) => {
      const o = new THREE.Vector3();
      bone.getWorldPosition(o);
      const h = /Hips|Spine/.test(bone.name) ? 0.17 : 0.11;
      const base = pos.length / 3;
      for (const sy of [-1, 1]) {
        for (const d of [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]]) {
          pos.push(o.x + d[0] * h, o.y + sy * h, o.z + d[2] * h);
          idx.push(i, 0, 0, 0);
          wgt.push(1, 0, 0, 0);
        }
      }
      FACES.forEach(f => tri.push(base + f[0], base + f[1], base + f[2]));
    });

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
    geom.setIndex(tri);
    geom.computeVertexNormals();

    const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial({
      color: 0xffcc66, emissive: 0x332200, side: THREE.DoubleSide
    }));
    mesh.name = 'Badan';
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));

    // Satu klip bawaan, supaya bisa dipastikan klip asli model TIDAK
    // hilang saat tangkapan ditambahkan.
    const t = new Float32Array([0, 1]);
    const v = new Float32Array([0, 0, 0, 1, 0, 0, 0.26, 0.97]);
    const clip = new THREE.AnimationClip('Idle', 1, [
      new THREE.QuaternionKeyframeTrack(bones[1].uuid + '.quaternion', t, v)
    ]);

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      exporter.parse(root, res, rej, { binary: true, animations: [clip] });
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });

  const modelBuf = Buffer.from(modelB64, 'base64');
  r.check('GLB karakter terbentuk', modelBuf.length > 1000, modelBuf.length + ' byte');

  await page.setInputFiles('#file-input',
    { name: 'karakter.glb', mimeType: 'model/gltf-binary', buffer: modelBuf });
  await H.waitIdle(page);
  await page.waitForTimeout(800);

  const loaded = await page.evaluate(() => {
    const names = [];
    document.querySelectorAll('.clip-row').forEach(el => names.push(el.innerText.split('\n')[0]));
    return { clips: document.querySelectorAll('.clip-row').length, names };
  });
  r.info('klip model: ' + loaded.names.join(' | '));
  r.check('karakter termuat dengan klip bawaannya', loaded.clips === 1, JSON.stringify(loaded));

  /* ---------------------------------------------------------------- *
   * Video, lalu retarget
   * ---------------------------------------------------------------- */

  r.section('Menangkap video lalu memindahkannya');
  const img64 = fs.readFileSync(person).toString('base64');
  const videoB64 = await page.evaluate(async (img) => {
    const image = new Image();
    await new Promise((res, rej) => { image.onload = res; image.onerror = rej; image.src = 'data:image/jpeg;base64,' + img; });
    const W = 420, Hh = Math.round(420 * image.height / image.width);
    const c = document.createElement('canvas');
    c.width = W; c.height = Hh;
    const x = c.getContext('2d');
    const draw = (el) => {
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, Hh);
      x.save();
      x.translate(W / 2, Hh / 2);
      x.rotate(Math.min(el / 2.2, 1) * 45 * Math.PI / 180);
      x.scale(0.78, 0.78);
      x.drawImage(image, -W / 2, -Hh / 2, W, Hh);
      x.restore();
    };
    draw(0);
    const chunks = [];
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2000000 });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise(res => {
      const id = setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        draw(el);
        if (el > 2.2) { clearInterval(id); res(); }
      }, 33);
    });
    rec.requestData();
    await new Promise(res => setTimeout(res, 250));
    rec.stop(); await stopped;
    c.remove();
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, img64);

  const video = Buffer.from(videoB64, 'base64');
  r.check('video uji terbentuk', video.length > 10000, video.length + ' byte');

  await page.setInputFiles('#video-input',
    { name: 'gerak.webm', mimeType: 'video/webm', buffer: video });
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 300000 });
  await page.waitForTimeout(1500);

  const after = await page.evaluate(() => {
    const names = [];
    document.querySelectorAll('.clip-row').forEach(el => names.push(el.innerText.split('\n')[0]));
    return { toast: document.getElementById('toast').textContent.trim(), clips: names.length, names };
  });
  r.info('pesan: ' + after.toast);
  r.info('klip sekarang: ' + after.names.join(' | '));

  r.check('pesan menyebut pemindahan ke model, bukan sosok batang',
    /dipindahkan|transferred/i.test(after.toast), after.toast);
  r.check('klip tangkapan ditambahkan ke model', after.clips === 2, JSON.stringify(after.names));
  r.check('klip bawaan model tidak hilang',
    after.names.some(n => /Idle/i.test(n)), JSON.stringify(after.names));

  // Yang menentukan: MODEL pengguna yang bergerak, bukan sosok batang.
  r.section('Model pengguna yang bergerak');
  async function poseAt(fraction) {
    await page.evaluate((f) => {
      const tl = document.getElementById('timeline');
      tl.value = String(Math.round(f * 1000));
      tl.dispatchEvent(new Event('input', { bubbles: true }));
      tl.dispatchEvent(new Event('change', { bubbles: true }));
    }, fraction);
    await page.waitForTimeout(500);
    return (await page.locator('#canvas-host').screenshot()).toString('base64');
  }
  const frameA = await poseAt(0.05);
  const frameB = await poseAt(0.55);
  const delta = await page.evaluate(async (pair) => {
    async function gray(b64) {
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 160, 120);
      const d = x.getImageData(0, 0, 160, 120).data;
      const g = new Float32Array(160 * 120);
      for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      return g;
    }
    const a = await gray(pair[0]), b = await gray(pair[1]);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }, [frameA, frameB]);
  r.info('beda piksel antar dua waktu klip: ' + delta.toFixed(2));
  r.check('pose model berubah seiring waktu klip', delta > 1.0, delta.toFixed(2));

  r.section('Masih bisa masuk pipeline lama');
  await page.locator('#btn-run').click();
  await H.waitIdle(page);
  await page.waitForTimeout(600);
  const jitter = await page.locator('#st-jitter').textContent();
  r.info('jitter ' + jitter);
  r.check('hasil retarget bisa dibersihkan engine', jitter.indexOf('—') === -1, jitter);

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#btn-export-glb').click();
  const file = await dl;
  const out = path.join(H.OUT, 'retarget_' + file.suggestedFilename());
  await file.saveAs(out);
  const gltf = H.parseGLB(fs.readFileSync(out));
  r.check('export GLB valid', !!gltf);
  r.check('rig pengguna ikut terekspor', !!gltf && !!gltf.skins && gltf.skins.length > 0);
  r.check('dua klip ikut terekspor',
    !!gltf && !!gltf.animations && gltf.animations.length === 2,
    gltf && gltf.animations ? String(gltf.animations.length) : 'n/a');

  r.section('Final');
  r.check('tidak ada error JS', errors.length === 0, errors.join('\n      '));

  await page.locator('#canvas-host').screenshot({ path: path.join(H.OUT, 'retarget.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
