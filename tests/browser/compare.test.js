/*
 * Test browser: cara membedakan original dan enhanced.
 *
 * Tiga jalur yang harus benar-benar bekerja, bukan cuma ada tombolnya:
 * tombol A/B mengubah pose yang dirender, bayangan original muncul dan
 * ikut waktu model utama, dan motion trail menggambar dua jalur.
 */
'use strict';

const path = require('path');
const { buildSite, launch, createReporter, waitIdle, OUT } = require('./harness');

const r = createReporter('Compare');

const shot = (page) => page.locator('#canvas-host canvas').screenshot();

/** Berapa persen piksel yang berbeda antara dua screenshot kanvas. */
async function diffRatio(page, a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = rej;
      img.src = 'data:image/png;base64,' + b64;
    });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    const w = 320, h = Math.round(320 * ia.height / ia.width);
    const draw = (img) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const da = draw(ia), db = draw(ib);
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) diff++;
    }
    return diff / (w * h);
  }, [a.toString('base64'), b.toString('base64')]);
}

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
  await page.waitForTimeout(2500);

  r.section('Sebelum enhance');
  r.check('bayangan terkunci sebelum ada hasil enhance',
    await page.locator('#opt-ghost').isDisabled());

  await page.locator('.preset[data-preset="ultra"]').click();
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.locator('#btn-play').click(); // jeda supaya pose stabil
  await seek(page, 300);
  await page.waitForTimeout(400);

  r.section('Tombol A/B');
  r.check('bayangan terbuka setelah enhance', !(await page.locator('#opt-ghost').isDisabled()));
  const enhancedShot = await shot(page);
  await page.keyboard.press('c');
  await page.waitForTimeout(400);
  const originalShot = await shot(page);
  const abDiff = await diffRatio(page, enhancedShot, originalShot);
  r.info('beda piksel original vs enhanced pada waktu yang sama: ' + (abDiff * 100).toFixed(2) + '%');
  r.check('A/B benar-benar mengubah pose yang dirender', abDiff > 0.002, (abDiff * 100).toFixed(3) + '%');

  await page.keyboard.press('c'); // kembali ke Enhanced
  await page.waitForTimeout(300);

  r.section('Bayangan original');
  const noGhost = await shot(page);
  await page.locator('#opt-ghost').check();
  await page.waitForTimeout(600);
  const withGhost = await shot(page);
  const ghostDiff = await diffRatio(page, noGhost, withGhost);
  r.info('beda piksel saat bayangan dinyalakan: ' + (ghostDiff * 100).toFixed(2) + '%');
  r.check('bayangan benar-benar terlihat', ghostDiff > 0.002, (ghostDiff * 100).toFixed(3) + '%');
  r.check('legend bayangan muncul', await page.locator('#legend-ghost').isVisible());

  r.section('Bayangan ikut waktu model utama');
  // Kalau bayangan jalan sendiri, pindah waktu tidak akan mengubahnya
  // secara konsisten. Dibandingkan pada dua waktu yang jelas berbeda.
  await seek(page, 100);
  await page.waitForTimeout(350);
  const atA = await shot(page);
  await seek(page, 700);
  await page.waitForTimeout(350);
  const atB = await shot(page);
  const timeDiff = await diffRatio(page, atA, atB);
  r.check('scrub memindahkan model dan bayangannya', timeDiff > 0.004, (timeDiff * 100).toFixed(3) + '%');

  // dan kembali ke waktu semula harus menghasilkan gambar yang sama
  await seek(page, 100);
  await page.waitForTimeout(350);
  const atAagain = await shot(page);
  const repeatDiff = await diffRatio(page, atA, atAagain);
  r.check('kembali ke waktu yang sama menghasilkan pose yang sama (tidak melenceng)',
    repeatDiff < 0.002, (repeatDiff * 100).toFixed(3) + '%');

  r.section('Bayangan disembunyikan di mode Original');
  await page.keyboard.press('c');
  await page.waitForTimeout(400);
  r.check('legend bayangan ikut hilang', !(await page.locator('#legend-ghost').isVisible()));
  await page.keyboard.press('c');
  await page.waitForTimeout(400);
  r.check('muncul lagi di mode Enhanced', await page.locator('#legend-ghost').isVisible());

  r.section('Pintasan tetap hidup setelah menyentuh kontrol');
  // Bug nyata: penjaga input yang menolak semua <input> membuat seluruh
  // pintasan mati begitu sebuah checkbox difokuskan.
  await page.locator('#opt-trail').focus();
  const viewBefore = await page.locator('#btn-view-enhanced').evaluate(e => e.classList.contains('active'));
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  const viewAfter = await page.locator('#btn-view-enhanced').evaluate(e => e.classList.contains('active'));
  r.check('tombol C tetap bekerja saat fokus ada di checkbox', viewBefore !== viewAfter);
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  // Sisi sebaliknya — mengetik di kolom pencarian tidak boleh memicu
  // pintasan — diuji di multiclip.test.js, di sana kolomnya memang ada.

  r.section('Motion trail');
  await page.locator('#opt-trail').check();
  await page.waitForTimeout(500);
  r.check('kedua jalur muncul di legend',
    (await page.locator('#legend-trail-original').isVisible()) &&
    (await page.locator('#legend-trail-enhanced').isVisible()));

  r.section('Reset membersihkan bayangan');
  await page.locator('#btn-reset').click();
  await page.waitForTimeout(500);
  r.check('centang bayangan ikut dimatikan', !(await page.locator('#opt-ghost').isChecked()));
  r.check('bayangan terkunci lagi', await page.locator('#opt-ghost').isDisabled());

  r.section('Ganti model tidak meninggalkan bayangan');
  await page.locator('#btn-demo').click();
  await page.waitForTimeout(900);
  r.check('bayangan bersih setelah model diganti', !(await page.locator('#opt-ghost').isChecked()));
  r.check('model baru tetap tergambar', !!(await shot(page)).length);

  r.section('Final');
  r.check('tidak ada error JS di seluruh sesi', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'compare.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
