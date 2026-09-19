/*
 * Test browser: model dengan banyak animasi.
 *
 * Yang diuji bukan cuma "bisa ganti klip", tapi hal-hal yang gampang
 * rusak diam-diam: stats per-klip tidak tertukar, memproses satu klip
 * tidak membatalkan hasil klip lain, dan export tidak kehilangan animasi
 * yang belum diproses.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildSite, launch, createReporter, parseGLB, waitIdle, OUT } = require('./harness');

const r = createReporter('Multi-clip');

/** GLB dengan beberapa klip berbeda nama, durasi, dan amplitudo. */
async function makeMultiClipGLB(page, names) {
  const b64 = await page.evaluate(async (clipNames) => {
    const root = new THREE.Group();
    root.name = 'Multi';
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    box.name = 'Cube';
    root.add(box);

    const clips = clipNames.map((name, k) => {
      const fps = 8, dur = 1 + k * 0.4, amp = 0.5 + k * 0.3;
      const n = Math.round(dur * fps) + 1;
      const times = [], vals = [];
      let seed = 11 + k * 97;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        times.push(t);
        vals.push(Math.sin(t * 3) * amp + rnd() * 0.06,
                  Math.abs(Math.sin(t * 5)) * amp + rnd() * 0.06, 0);
      }
      return new THREE.AnimationClip(name, dur, [new THREE.VectorKeyframeTrack('Cube.position', times, vals)]);
    });

    const exporter = new THREE.GLTFExporter();
    const buf = await new Promise((res, rej) => {
      try { exporter.parse(root, res, { binary: true, animations: clips }); }
      catch (err) { rej(err); }
    });
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, names);
  return Buffer.from(b64, 'base64');
}

const rowText = (page, i) => page.locator('.clip-row').nth(i).innerText();
const activeIndex = (page) => page.evaluate(() => {
  const el = document.querySelector('.clip-row.active');
  return el ? parseInt(el.dataset.index, 10) : -1;
});

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2000);

  r.section('Daftar klip');
  const names = ['Idle', 'Walk', 'Run', 'Jump'];
  const glb = await makeMultiClipGLB(page, names);
  await page.setInputFiles('#file-input', { name: 'multi.glb', mimeType: 'model/gltf-binary', buffer: glb });
  await waitIdle(page, 20000);
  await page.waitForTimeout(600);

  r.check('panel animasi muncul', await page.locator('#clip-section').isVisible());
  r.check('semua klip terdaftar', await page.locator('.clip-row').count() === 4,
    String(await page.locator('.clip-row').count()));
  r.check('jumlah klip dilaporkan', (await page.locator('#clip-count').textContent()).includes('4 klip'),
    await page.locator('#clip-count').textContent());
  const first = await rowText(page, 0);
  r.info('baris pertama: ' + first.replace(/\n/g, ' | '));
  r.check('baris memuat nama', first.includes('Idle'), first);
  r.check('baris memuat durasi dan jumlah key', /\d+\.\d{2}s/.test(first) && /key/.test(first), first);
  r.check('klip pertama aktif secara default', await activeIndex(page) === 0);
  r.check('filter disembunyikan untuk daftar pendek', !(await page.locator('#clip-filter').isVisible()));

  r.section('Berpindah klip');
  await page.locator('.clip-row').nth(2).click();
  await page.waitForTimeout(400);
  r.check('klik memilih klip', await activeIndex(page) === 2, String(await activeIndex(page)));
  const runDur = await page.locator('#time-display').textContent();
  r.check('durasi timeline ikut klip terpilih', runDur.includes('/ 1.75s'), runDur);

  await page.keyboard.press(']');
  await page.waitForTimeout(300);
  r.check('tombol ] maju ke klip berikutnya', await activeIndex(page) === 3, String(await activeIndex(page)));
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await page.waitForTimeout(300);
  r.check('tombol [ mundur', await activeIndex(page) === 1, String(await activeIndex(page)));

  r.section('Memproses satu klip saja');
  await page.locator('#opt-all-clips').uncheck();
  await page.locator('.preset[data-preset="quality"]').click();
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);

  const walkJitter = await page.locator('#st-jitter').textContent();
  r.check('klip aktif terproses', walkJitter.startsWith('−'), walkJitter);
  r.check('hitungan "diproses" menunjukkan 1',
    (await page.locator('#clip-count').textContent()).includes('1 diproses'),
    await page.locator('#clip-count').textContent());
  r.check('hanya satu baris bertanda selesai',
    await page.locator('.clip-badge.done').count() === 1,
    String(await page.locator('.clip-badge.done').count()));
  r.check('baris klip terproses menunjukkan key sebelum → sesudah',
    /\d+ → \d+ key/.test(await rowText(page, 1)), await rowText(page, 1));

  r.section('Klip lain tetap apa adanya');
  await page.locator('.clip-row').nth(0).click();
  await page.waitForTimeout(400);
  r.check('stats klip yang belum diproses tidak memakai angka klip lain',
    (await page.locator('#st-jitter').textContent()) === 'belum diproses',
    await page.locator('#st-jitter').textContent());
  r.check('catatan export memperingatkan ada klip yang belum diproses',
    (await page.locator('#export-note').textContent()).includes('belum diproses'),
    await page.locator('#export-note').textContent());

  r.section('Memproses sisanya tidak membatalkan yang lama');
  await page.locator('#opt-all-clips').check();
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);
  r.check('semua klip kini terproses',
    await page.locator('.clip-badge.done').count() === 4,
    String(await page.locator('.clip-badge.done').count()));

  // stats tiap klip harus berbeda — kalau sama persis, indeksnya tertukar
  const perClip = [];
  for (let i = 0; i < 4; i++) {
    await page.locator('.clip-row').nth(i).click();
    await page.waitForTimeout(250);
    perClip.push({
      name: names[i],
      jitter: await page.locator('#st-jitter').textContent(),
      keys: await page.locator('#st-keys').textContent(),
      dur: await page.locator('#time-display').textContent()
    });
  }
  perClip.forEach(c => r.info(c.name + ': jitter=' + c.jitter + '  key=' + c.keys + '  ' + c.dur.split('/')[1].trim()));
  r.check('setiap klip punya statistik sendiri',
    new Set(perClip.map(c => c.keys)).size === 4,
    perClip.map(c => c.keys).join(' / '));
  r.check('durasi tiap klip berbeda sesuai sumbernya',
    new Set(perClip.map(c => c.dur.split('/')[1].trim())).size === 4);

  r.section('Filter untuk daftar panjang');
  const many = [];
  for (let i = 0; i < 12; i++) many.push((i % 2 ? 'Attack_' : 'Idle_') + i);
  const bigGlb = await makeMultiClipGLB(page, many);
  await page.setInputFiles('#file-input', { name: 'many.glb', mimeType: 'model/gltf-binary', buffer: bigGlb });
  await waitIdle(page, 20000);
  await page.waitForTimeout(600);
  r.check('filter muncul untuk daftar panjang', await page.locator('#clip-filter').isVisible());
  await page.locator('#clip-filter').fill('attack');
  await page.waitForTimeout(300);
  r.check('filter menyaring tanpa peduli huruf besar/kecil',
    await page.locator('.clip-row').count() === 6,
    String(await page.locator('.clip-row').count()));
  await page.locator('#clip-filter').fill('zzz');
  await page.waitForTimeout(300);
  r.check('pesan "tidak ada yang cocok" muncul', await page.locator('#clip-empty').isVisible());
  await page.locator('#clip-filter').fill('');
  await page.waitForTimeout(300);
  r.check('daftar pulih setelah filter dikosongkan',
    await page.locator('.clip-row').count() === 12,
    String(await page.locator('.clip-row').count()));

  r.section('Mengetik di pencarian tidak memicu pintasan');
  // Penjaga input harus membedakan kolom teks dari checkbox: yang satu
  // menerima ketikan, yang lain tidak boleh mematikan pintasan.
  await page.locator('.clip-row').nth(3).click();
  await page.waitForTimeout(250);
  const before = await activeIndex(page);
  await page.locator('#clip-filter').focus();
  await page.keyboard.type('c[]');
  await page.waitForTimeout(300);
  r.check('huruf yang diketik masuk ke kolom', (await page.locator('#clip-filter').inputValue()) === 'c[]',
    await page.locator('#clip-filter').inputValue());

  // Saat difilter tidak ada baris yang tampil, jadi klip aktif baru bisa
  // dibaca lagi setelah filter dikosongkan.
  await page.locator('#clip-filter').fill('');
  await page.waitForTimeout(300);
  r.check('tombol [ dan ] tidak ikut memindah klip saat mengetik',
    (await activeIndex(page)) === before,
    'sebelum=' + before + ' sesudah=' + (await activeIndex(page)));

  r.section('Export');
  await page.locator('#btn-run').click();
  await waitIdle(page, 120000);
  await page.waitForTimeout(400);
  const dlP = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#btn-export-glb').click();
  const dl = await dlP;
  const out = path.join(OUT, 'multiclip_' + dl.suggestedFilename());
  await dl.saveAs(out);
  const gltf = parseGLB(fs.readFileSync(out));
  r.check('semua 12 klip ikut terekspor',
    !!gltf && gltf.animations.length === 12,
    gltf ? String(gltf.animations.length) : 'gagal parse');
  r.check('nama klip dipertahankan',
    !!gltf && gltf.animations.every(a => many.indexOf(a.name) !== -1),
    gltf ? gltf.animations.map(a => a.name).join(',') : '');

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'multiclip.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
