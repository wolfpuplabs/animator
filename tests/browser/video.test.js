/*
 * Test browser: tangkap animasi dari berkas video.
 *
 * Videonya dibuat di dalam halaman dengan MediaRecorder dari satu foto
 * manusia yang digerakkan, jadi tidak ada berkas video yang perlu ikut
 * repo. Foto dan berkas model MediaPipe (5,7 MB) di-cache di
 * tests/browser/.cache dan diunduh sekali saat dibutuhkan.
 *
 * Kalau keduanya tidak tersedia dan tidak bisa diunduh, test ini MELEWAT
 * dengan keterangan, bukan gagal — kegagalan jaringan bukan kegagalan
 * kode.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const r = H.createReporter('Video');

(async () => {
  const hasModel = await H.ensureMediaPipeModel();
  const person = await H.ensurePersonImage();
  if (!hasModel || !person) {
    console.log('\n⚠️  Video: DILEWAT — aset deteksi pose tidak tersedia.');
    console.log('   Model: ' + (hasModel ? 'ada' : 'tidak ada') +
                ', foto uji: ' + (person ? 'ada' : 'tidak ada'));
    console.log('   Keduanya diunduh otomatis saat ada jaringan, lalu di-cache.\n');
    process.exit(0);
  }

  const fileUrl = H.buildSite();
  const siteDir = path.dirname(fileUrl.replace('file://', ''));

  // Deteksi pose tidak bisa jalan di file://: blob URL video diblokir dan
  // import() dari script klasik punya base URL about:blank.
  const server = await H.serveDir(siteDir);
  const browser = await H.launch();
  const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1280, height: 860 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    // sourcemap MediaPipe tidak ikut disalin; 404-nya tidak berarti apa-apa
    if (m.type() === 'error' && !/404|Failed to load resource/.test(t)) errors.push('console: ' + t.slice(0, 200));
  });

  await page.goto(server.url);
  await page.waitForTimeout(2200);

  r.section('Persiapan');
  r.check('deteksi pose diarahkan ke berkas lokal',
    !!(await page.evaluate(() => window.MFS_MEDIAPIPE)));
  r.check('panel tangkap video ada', await page.locator('#video-section').isVisible());
  r.check('menerima berkas video',
    (await page.locator('#video-input').getAttribute('accept')).indexOf('video') !== -1);

  r.section('Membuat video uji');
  const imageData = fs.readFileSync(person).toString('base64');
  const videoB64 = await page.evaluate(async (img64) => {
    const img = new Image();
    // data URL, bukan berkas: memuat lewat berkas membuat kanvas tainted
    // dan captureStream ditolak.
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/jpeg;base64,' + img64; });

    const W = 420, Hh = Math.round(420 * img.height / img.width);
    const c = document.createElement('canvas');
    c.width = W; c.height = Hh;
    c.style.position = 'fixed'; c.style.left = '0'; c.style.top = '0'; c.style.zIndex = '-1';
    document.body.appendChild(c);
    const x = c.getContext('2d');

    const draw = (el) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, W, Hh);
      x.save();
      x.translate(W / 2 + Math.sin(el * 3) * 16, Hh / 2);
      const s = 1 + Math.sin(el * 2) * 0.04;
      x.scale(s, s);
      x.drawImage(img, -W / 2, -Hh / 2, W, Hh);
      x.restore();
    };
    draw(0);

    const chunks = [];
    const rec = new MediaRecorder(c.captureStream(30),
      { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2000000 });
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
    rec.stop();
    await stopped;
    c.remove();

    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, imageData);

  const video = Buffer.from(videoB64, 'base64');
  r.info('video uji: ' + (video.length / 1024).toFixed(0) + ' KB');
  r.check('video uji terbentuk', video.length > 10000, video.length + ' byte');

  r.section('Deteksi dan pembuatan rig');
  await page.setInputFiles('#video-input',
    { name: 'uji.webm', mimeType: 'video/webm', buffer: video });
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 240000 });
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => ({
    status: document.getElementById('video-status').textContent,
    toast: document.getElementById('toast').textContent,
    clips: document.querySelectorAll('.clip-row').length,
    row: document.querySelector('.clip-row') ? document.querySelector('.clip-row').innerText.replace(/\n/g, ' | ') : '',
    duration: document.getElementById('time-display').textContent,
    skinAvailable: !document.getElementById('opt-skin').disabled,
    runEnabled: !document.getElementById('btn-run').disabled
  }));
  r.info('status ' + state.status + ' — ' + state.row);

  r.check('ada orang terdeteksi', /\d+%/.test(state.status), state.status);
  const percent = parseInt(state.status, 10) || 0;
  r.check('sebagian besar frame terdeteksi', percent >= 60, state.status);
  r.check('satu klip animasi terbentuk', state.clips === 1, String(state.clips));
  r.check('klip punya durasi', !/\/ 0\.00s/.test(state.duration), state.duration);
  r.check('rig hasilnya ber-skeleton', state.skinAvailable);
  r.check('enhance bisa dijalankan', state.runEnabled);

  r.section('Masuk ke pipeline yang sudah ada');
  await page.locator('.preset[data-preset="quality"]').click();
  await page.locator('#btn-run').click();
  await H.waitIdle(page, 120000);
  await page.waitForTimeout(500);

  const jitter = await page.locator('#st-jitter').textContent();
  const keys = await page.locator('#st-keys').textContent();
  r.info('jitter ' + jitter + ', keyframe ' + keys);
  r.check('hasil tangkapan bisa dibersihkan engine', jitter.indexOf('—') === -1, jitter);

  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#btn-export-glb').click();
  const file = await dl;
  const out = path.join(H.OUT, 'video_' + file.suggestedFilename());
  await file.saveAs(out);
  const gltf = H.parseGLB(fs.readFileSync(out));
  r.check('export GLB valid', !!gltf);
  r.check('rig ikut terekspor sebagai skin',
    !!gltf && !!gltf.skins && gltf.skins.length > 0);
  r.check('animasi ikut terekspor',
    !!gltf && !!gltf.animations && gltf.animations.length > 0);

  r.section('Sosoknya benar-benar bergerak di layar');
  // Asersi yang dulu TIDAK ADA, dan karena itu bug ini lolos.
  //
  // three r128 hanya menerapkan skinning kalau material.skinning true, dan
  // defaultnya false. GLTFLoader menyalakannya sendiri; material buatan
  // tangan di posepipeline.js tidak. Akibatnya tulang berputar, klipnya
  // benar, GLB-nya benar, dan SEMUA asersi di atas tetap lulus — tapi
  // mesh-nya membeku di bind pose. Satu-satunya yang menangkapnya adalah
  // membandingkan piksel yang benar-benar dirender pada waktu klip berbeda.
  async function poseAt(fraction) {
    await page.evaluate((f) => {
      const tl = document.getElementById('timeline');
      tl.value = String(Math.round(f * 1000));
      tl.dispatchEvent(new Event('input', { bubbles: true }));
      tl.dispatchEvent(new Event('change', { bubbles: true }));
    }, fraction);
    await page.waitForTimeout(600);
    return (await page.locator('#canvas-host').screenshot()).toString('base64');
  }

  const frameA = await poseAt(0.05);
  const frameB = await poseAt(0.55);
  const pixelDelta = await page.evaluate(async (pair) => {
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

  r.info('beda piksel antar dua waktu klip: ' + pixelDelta.toFixed(2));
  r.check('pose yang dirender berubah seiring waktu klip', pixelDelta > 1.0,
    'beda ' + pixelDelta.toFixed(2) + ' — mesh kemungkinan membeku di bind pose');

  r.section('Video tanpa orang');
  const blank = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.style.position = 'fixed'; c.style.left = '0'; c.style.zIndex = '-1';
    document.body.appendChild(c);
    const x = c.getContext('2d');
    const chunks = [];
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise(res => {
      const id = setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        x.fillStyle = 'hsl(' + (el * 120) + ',60%,50%)';
        x.fillRect(0, 0, 320, 240);
        if (el > 1.2) { clearInterval(id); res(); }
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
  });

  await page.setInputFiles('#video-input',
    { name: 'kosong.webm', mimeType: 'video/webm', buffer: Buffer.from(blank, 'base64') });
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 180000 });
  await page.waitForTimeout(1000);
  const blankToast = await page.locator('#toast').textContent();
  r.info('pesan: ' + blankToast);
  r.check('video tanpa orang memberi pesan yang jelas',
    /terdeteksi|detected/i.test(blankToast), blankToast);
  r.check('aplikasi tetap hidup', await page.locator('#canvas-host canvas').count() === 1);

  r.section('Video yang tidak bisa didekode');
  // Berkas dengan codec yang tidak didukung tetap memicu 'loadeddata' dan
  // melaporkan durasi, tapi videoWidth-nya nol. Dulu deteksi tetap jalan di
  // atas frame kosong lalu melapor "tidak ada orang terdeteksi" — pesan yang
  // menyesatkan, karena masalahnya format. Berkas uji dibuat dari header MP4
  // yang sah dengan isi sampah, jadi tidak ada berkas yang perlu ikut repo.
  const bogus = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 0]), Buffer.from('mp42isom'),
    Buffer.alloc(4096, 0x41)
  ]);
  await page.setInputFiles('#video-input',
    { name: 'rusak.mp4', mimeType: 'video/mp4', buffer: bogus });
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const codecToast = await page.locator('#toast').textContent();
  r.info('pesan: ' + codecToast);
  r.check('video tak terdekode memberi pesan format, bukan "tidak ada orang"',
    /dekode|decode|MP4|WebM/i.test(codecToast) && !/terdeteksi di video|detected in this video/i.test(codecToast),
    codecToast);

  r.section('Video kedua di sesi yang sama');
  // MediaPipe mode VIDEO menolak timestamp yang tidak naik. Tanpa
  // penghitung yang terus maju, video kedua gagal total tanpa pesan.
  await page.setInputFiles('#video-input',
    { name: 'uji2.webm', mimeType: 'video/webm', buffer: video });
  await page.waitForFunction(
    () => !document.getElementById('overlay').classList.contains('active'),
    null, { timeout: 240000 });
  await page.waitForTimeout(1200);
  const second = await page.evaluate(() => document.getElementById('video-status').textContent);
  r.info('status tangkapan kedua: ' + second);
  r.check('video kedua tetap terdeteksi', (parseInt(second, 10) || 0) >= 60, second);

  r.section('Final');
  r.check('tidak ada error JS', errors.length === 0, errors.join('\n      '));

  await page.locator('#canvas-host').screenshot({ path: path.join(H.OUT, 'video-rig.png') });
  await browser.close();
  await server.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
