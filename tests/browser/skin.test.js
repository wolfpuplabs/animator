/*
 * Test browser: perbaikan bobot skin pada model sungguhan.
 *
 * Yang diuji bukan cuma "tombolnya ada", tapi bahwa bobot di dalam mesh
 * benar-benar berubah jadi sehat, hasilnya ikut ke berkas GLB, dan
 * menjalankannya berulang tidak menumpuk efek.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildSite, launch, createReporter, parseGLB, waitIdle, OUT } = require('./harness');

const r = createReporter('Skin');

/** Rig dengan bobot yang sengaja rusak: tidak ternormalisasi, ada yatim. */
async function makeBrokenRigGLB(page) {
  const b64 = await page.evaluate(async () => {
    const SEG = 4, H = 3;
    const geom = new THREE.CylinderGeometry(0.5, 0.5, H, 12, SEG * 4, false);
    const pos = geom.attributes.position;
    const si = [], sw = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + H / 2;
      const s = (y / H) * (SEG - 1);
      const idx = Math.min(Math.floor(s), SEG - 2);
      // Bobot sengaja dirusak dengan tiga cara sekaligus:
      //  - jumlahnya jauh dari 1 (mesh akan mengempis)
      //  - sebagian vertex tidak punya pengaruh sama sekali (yatim)
      //  - ada pengaruh remeh yang cuma jadi derau
      if (i % 17 === 0) {
        si.push(0, 0, 0, 0); sw.push(0, 0, 0, 0);        // yatim
      } else {
        si.push(idx, idx + 1, (idx + 2) % SEG, 0);
        sw.push(0.35, 0.15, 0.003, 0);                    // jumlah 0.503
      }
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

    const mesh = new THREE.SkinnedMesh(geom,
      new THREE.MeshStandardMaterial({ color: 0xdddddd, side: THREE.DoubleSide }));
    mesh.name = 'Body';
    const root = new THREE.Group();
    root.name = 'Root';
    root.add(bones[0]);
    root.add(mesh);
    mesh.bind(new THREE.Skeleton(bones));

    const fps = 8, dur = 2, n = Math.round(dur * fps) + 1, tracks = [];
    for (let b = 1; b < SEG; b++) {
      const times = [], vals = [], q = new THREE.Quaternion(), e = new THREE.Euler();
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        times.push(t);
        e.set(0, 0, Math.sin(t * 2 + b) * 0.5);
        q.setFromEuler(e);
        vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack('J' + b + '.quaternion', times, vals));
    }

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      try { exporter.parse(root, res, { binary: true, animations: [new THREE.AnimationClip('bend', dur, tracks)] }); }
      catch (err) { rej(err); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

// Sama dengan minWeight yang dipakai perbaikan. Ambang yang lebih rendah
// akan meleset: normalisasi loader menaikkan bobot remeh (0.003 jadi
// 0.006 pada model uji ini), jadi metriknya harus memakai batas yang sama
// dengan yang dipakai untuk memangkas.
const TINY_WEIGHT = 0.01;

/** Ringkasan kesehatan bobot dari GLB: lewat accessor WEIGHTS_0. */
function weightHealth(gltf, buffers) {
  const prim = gltf.meshes[0].primitives[0];
  const acc = gltf.accessors[prim.attributes.WEIGHTS_0];
  const view = gltf.bufferViews[acc.bufferView];
  const offset = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;
  const data = new Float32Array(buffers.buffer, buffers.byteOffset + offset, count * 4);

  let worstError = 0, orphans = 0, tiny = 0;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let s = 0; s < 4; s++) {
      const w = data[i * 4 + s];
      sum += w;
      if (w > 0 && w < TINY_WEIGHT) tiny++;
    }
    if (sum < 1e-6) orphans++;
    else worstError = Math.max(worstError, Math.abs(sum - 1));
  }
  return { count, worstError, orphans, tiny };
}

function binChunk(buf) {
  // chunk 0 = JSON, chunk 1 = BIN
  const jsonLen = buf.readUInt32LE(12);
  const binStart = 20 + jsonLen + 8;
  const binLen = buf.readUInt32LE(20 + jsonLen);
  return buf.slice(binStart, binStart + binLen);
}

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2200);

  r.section('Model tanpa skeleton');
  r.check('opsi skinning terkunci untuk demo', await page.locator('#opt-skin').isDisabled());
  r.check('alasannya dijelaskan',
    (await page.locator('#skin-status').textContent()).includes('tanpa skeleton'),
    await page.locator('#skin-status').textContent());

  r.section('Memuat rig dengan bobot rusak');
  const glb = await makeBrokenRigGLB(page);
  const src = parseGLB(glb);
  const before = weightHealth(src, binChunk(glb));
  r.info('sebelum: ' + before.count + ' vertex, error jumlah maks ' +
    before.worstError.toFixed(3) + ', yatim ' + before.orphans + ', bobot remeh ' + before.tiny);
  r.check('model uji memang rusak', before.worstError > 0.4 && before.orphans > 0);

  await page.setInputFiles('#file-input', { name: 'broken.glb', mimeType: 'model/gltf-binary', buffer: glb });
  await waitIdle(page, 20000);
  await page.waitForTimeout(700);
  r.check('opsi skinning terbuka untuk model ber-skeleton',
    !(await page.locator('#opt-skin').isDisabled()));

  // Baseline diambil dari hasil export SEBELUM perbaikan, bukan dari isi
  // mentah berkas: GLTFLoader memanggil normalizeSkinWeights saat impor
  // (GLTFLoader.js baris 2821), jadi yang dilihat aplikasi sudah berbeda
  // dari yang ada di dalam berkas.
  const baseDlP = page.waitForEvent('download', { timeout: 40000 });
  await page.locator('#btn-export-glb').click();
  const baseDl = await baseDlP;
  const basePath = path.join(OUT, 'skin_base_' + baseDl.suggestedFilename());
  await baseDl.saveAs(basePath);
  const baseBuf = fs.readFileSync(basePath);
  const loaded = weightHealth(parseGLB(baseBuf), binChunk(baseBuf));
  r.info('sebagaimana dimuat: error jumlah maks ' + loaded.worstError.toFixed(4) +
    ', yatim ' + loaded.orphans + ', bobot remeh ' + loaded.tiny);
  r.check('loader sudah menormalisasi bobot saat impor', loaded.worstError < 0.001,
    loaded.worstError.toFixed(4));
  r.check('tapi pengaruh remeh masih tertinggal', loaded.tiny > 0, String(loaded.tiny));

  r.section('Menjalankan perbaikan');
  await page.locator('#opt-skin').check();
  await page.waitForTimeout(200);
  r.check('slider envelope muncul saat dicentang', await page.locator('#opt-envelope').isVisible());

  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);

  const verts = await page.locator('#st-skin-verts').textContent();
  const changed = await page.locator('#st-skin-fix').textContent();
  const pruned = await page.locator('#st-skin-orphan').textContent();
  const env = await page.locator('#st-skin-env').textContent();
  r.info('laporan: vertex ' + verts + ', diubah ' + changed + ', pengaruh dibuang ' + pruned + ', envelope ' + env);
  r.check('laporan skinning muncul', await page.locator('#row-skin-verts').isVisible());
  r.check('vertex yang berubah dilaporkan', parseInt(changed.replace(/\D/g, ''), 10) > 0, changed);
  r.check('pengaruh remeh yang dibuang dilaporkan', parseInt(pruned.replace(/\D/g, ''), 10) > 0, pruned);
  r.check('envelope dilaporkan dihaluskan', /titik/.test(env), env);

  r.section('Hasil ikut ke berkas GLB');
  const dlP = page.waitForEvent('download', { timeout: 40000 });
  await page.locator('#btn-export-glb').click();
  const dl = await dlP;
  const outPath = path.join(OUT, 'skin_' + dl.suggestedFilename());
  await dl.saveAs(outPath);
  const outBuf = fs.readFileSync(outPath);
  const out = parseGLB(outBuf);
  const after = weightHealth(out, binChunk(outBuf));
  r.info('sesudah: error jumlah maks ' + after.worstError.toFixed(6) +
    ', yatim ' + after.orphans + ', bobot remeh ' + after.tiny);

  r.check('jumlah vertex tidak berubah', after.count === loaded.count,
    loaded.count + ' -> ' + after.count);
  r.check('bobot tetap ternormalisasi setelah dihaluskan', after.worstError < 0.001,
    after.worstError.toFixed(5));
  r.check('tidak ada vertex yatim', after.orphans === 0, String(after.orphans));
  r.check('pengaruh remeh benar-benar hilang dari berkas', after.tiny === 0,
    loaded.tiny + ' -> ' + after.tiny);
  r.check('skin masih utuh di berkas', !!out.skins && out.skins.length > 0);

  r.section('Menjalankan ulang tidak menumpuk');
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);
  const dl2P = page.waitForEvent('download', { timeout: 40000 });
  await page.locator('#btn-export-glb').click();
  const dl2 = await dl2P;
  const out2Path = path.join(OUT, 'skin2_' + dl2.suggestedFilename());
  await dl2.saveAs(out2Path);
  const out2Buf = fs.readFileSync(out2Path);
  const after2 = weightHealth(parseGLB(out2Buf), binChunk(out2Buf));
  r.check('hasil jalan kedua sama dengan jalan pertama',
    Math.abs(after2.worstError - after.worstError) < 1e-6 && after2.orphans === after.orphans,
    'error ' + after.worstError.toFixed(6) + ' -> ' + after2.worstError.toFixed(6));

  r.section('Reset mengembalikan bobot asli');
  await page.locator('#btn-reset').click();
  await page.waitForTimeout(500);
  r.check('laporan skinning hilang', !(await page.locator('#row-skin-verts').isVisible()));
  const dl3P = page.waitForEvent('download', { timeout: 40000 });
  await page.locator('#btn-export-glb').click();
  const dl3 = await dl3P;
  const out3Path = path.join(OUT, 'skin3_' + dl3.suggestedFilename());
  await dl3.saveAs(out3Path);
  const out3Buf = fs.readFileSync(out3Path);
  const restored = weightHealth(parseGLB(out3Buf), binChunk(out3Buf));
  r.info('setelah reset: bobot remeh ' + restored.tiny + ', yatim ' + restored.orphans);
  r.check('bobot kembali persis seperti saat dimuat',
    restored.tiny === loaded.tiny && restored.orphans === loaded.orphans &&
    Math.abs(restored.worstError - loaded.worstError) < 1e-4,
    'remeh ' + loaded.tiny + ' -> ' + restored.tiny + ', yatim ' + loaded.orphans + ' -> ' + restored.orphans);

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'skin.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
