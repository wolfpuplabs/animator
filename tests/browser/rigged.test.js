/*
 * Test browser: rig skinned sungguhan, bukan klip sintetis.
 *
 * Alurnya persis yang dilakukan pengguna: bikin GLB ber-skeleton, muat
 * lewat file input, enhance, ekspor ulang, lalu muat lagi hasilnya.
 * Ini yang membuktikan hierarki bone dan skin selamat melewati export.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildSite, launch, createReporter, parseGLB, waitIdle, OUT } = require('./harness');

const r = createReporter('Rigged');

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2000);

  r.section('Menyiapkan rig skinned + GLB sumber');
  const b64 = await page.evaluate(async () => {
    const SEG = 5, H = 4;
    const geom = new THREE.CylinderGeometry(0.4, 0.4, H, 8, SEG * 3, true);
    const pos = geom.attributes.position;
    const skinIndices = [], skinWeights = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + H / 2;
      const s = (y / H) * (SEG - 1);
      const idx = Math.min(Math.floor(s), SEG - 2);
      const w = s - idx;
      skinIndices.push(idx, idx + 1, 0, 0);
      skinWeights.push(1 - w, w, 0, 0);
    }
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

    const bones = [];
    let prev = null;
    for (let i = 0; i < SEG; i++) {
      const bone = new THREE.Bone();
      bone.name = 'Joint_' + i;
      bone.position.y = i === 0 ? -H / 2 : H / (SEG - 1);
      if (prev) prev.add(bone);
      bones.push(bone);
      prev = bone;
    }

    const mesh = new THREE.SkinnedMesh(geom,
      new THREE.MeshStandardMaterial({ color: 0x88ccff, side: THREE.DoubleSide }));
    mesh.name = 'Tentacle';
    const root = new THREE.Group();
    root.name = 'RigRoot';
    root.add(bones[0]);
    root.add(mesh);
    mesh.bind(new THREE.Skeleton(bones));

    // animasi stepped 6 fps dengan jitter — persis kasus yang mau dibenahi
    const fps = 6, dur = 3;
    const n = Math.round(dur * fps) + 1;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const tracks = [];
    for (let b = 1; b < SEG; b++) {
      const times = [], vals = [];
      const q = new THREE.Quaternion(), e = new THREE.Euler();
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        times.push(t);
        e.set(0, 0, Math.sin(t * 2.2 + b * 0.7) * 0.45 + rnd() * 0.09);
        q.setFromEuler(e);
        vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack('Joint_' + b + '.quaternion', times, vals));
    }

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      try { exporter.parse(root, res, { binary: true, animations: [new THREE.AnimationClip('wiggle', dur, tracks)] }); }
      catch (err) { rej(err); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });

  const srcBuf = Buffer.from(b64, 'base64');
  const src = parseGLB(srcBuf);
  r.check('GLB sumber punya skin (rig sungguhan)', !!src && !!src.skins && src.skins.length > 0,
    src ? JSON.stringify(Object.keys(src)) : 'gagal parse');
  r.info(src.nodes.length + ' node, ' + src.animations[0].channels.length + ' channel, ' +
    src.accessors[src.animations[0].samplers[0].input].count + ' keyframe/sampler');

  r.section('Muat lewat file input aplikasi');
  await page.setInputFiles('#file-input',
    { name: 'tentacle.glb', mimeType: 'model/gltf-binary', buffer: srcBuf });
  await waitIdle(page, 20000);
  await page.waitForTimeout(600);
  r.check('klip rigged terbaca', (await page.locator('#time-display').textContent()).includes('/ 3.00s'));
  r.check('tidak ada error saat memuat rig', errors.length === 0, errors.join('\n      '));

  r.section('Enhance');
  await page.locator('.preset[data-preset="ultra"]').click();
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);
  const jitter = await page.locator('#st-jitter').textContent();
  const tracksLabel = await page.locator('#st-tracks').textContent();
  r.info('jitter=' + jitter + '  keyframe=' + (await page.locator('#st-keys').textContent()) +
    '  track=' + tracksLabel);
  r.check('jitter rig turun', jitter.startsWith('−'), jitter);
  r.check('keempat track bone diproses', tracksLabel.startsWith('4'), tracksLabel);

  r.section('Export ulang');
  const dlP = page.waitForEvent('download', { timeout: 40000 });
  await page.locator('#btn-export-glb').click();
  const dl = await dlP;
  const outPath = path.join(OUT, 'rigged_' + dl.suggestedFilename());
  await dl.saveAs(outPath);
  const outBuf = fs.readFileSync(outPath);
  const out = parseGLB(outBuf);

  r.check('hasil export tetap GLB biner', !!out, 'magic: ' + outBuf.slice(0, 4).toString('ascii'));
  r.check('skin ikut terekspor (hierarki bone utuh)', !!out && !!out.skins && out.skins.length > 0);
  r.check('jumlah joint sama dengan sumber',
    !!out && out.skins[0].joints.length === src.skins[0].joints.length,
    out && out.skins ? out.skins[0].joints.length + ' vs ' + src.skins[0].joints.length : '');
  r.check('animasi hasil enhance ikut terekspor',
    !!out && Array.isArray(out.animations) && out.animations.length > 0);

  if (out && out.animations) {
    const before = src.accessors[src.animations[0].samplers[0].input].count;
    const after = out.accessors[out.animations[0].samplers[0].input].count;
    r.info('keyframe/sampler: ' + before + ' → ' + after);
    r.check('kerapatan keyframe naik setelah enhance', after > before * 2, before + ' -> ' + after);
    r.check('setiap channel tetap menunjuk node bone',
      out.animations[0].channels.every(c => typeof c.target.node === 'number'));
  }

  r.section('Round-trip');
  await page.setInputFiles('#file-input',
    { name: 'roundtrip.glb', mimeType: 'model/gltf-binary', buffer: outBuf });
  await waitIdle(page, 20000);
  await page.waitForTimeout(600);
  r.check('hasil export bisa dimuat kembali',
    (await page.locator('#time-display').textContent()).includes('/ 3.00s'));
  r.check('tidak ada error di seluruh sesi rig', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'rigged.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
