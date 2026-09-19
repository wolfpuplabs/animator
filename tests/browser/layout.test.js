/*
 * Test browser: tata letak harus utuh di berbagai ukuran layar.
 *
 * Dua bug yang dijaga di sini:
 *
 * 1. body memakai 100vh. Di browser ponsel dan tablet, 100vh mengacu ke
 *    viewport seolah-olah toolbar tidak ada, jadi halaman lebih tinggi
 *    dari yang terlihat. Karena overflow disembunyikan, sisanya terpotong
 *    tanpa bisa di-scroll — transport bar hilang dan model, yang berada di
 *    tengah kanvas, jatuh di bawah layar.
 * 2. Memaksa tinggi minimum pada kanvas mendorong transport bar keluar
 *    layar saat jendela pendek.
 *
 * Kondisi toolbar browser tidak bisa ditiru di headless (dvh dan vh
 * bernilai sama di sana), jadi pemakaian dvh diperiksa langsung di berkas
 * CSS-nya, sementara perilaku tata letak diuji di beberapa ukuran nyata.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { buildSite, launch, createReporter, OUT } = require('./harness');

const r = createReporter('Layout');

const SIZES = [
  { w: 1440, h: 900, label: 'desktop' },
  { w: 1280, h: 800, label: 'laptop' },
  { w: 1024, h: 768, label: 'tablet melintang' },
  { w: 820, h: 1180, label: 'tablet tegak' },
  { w: 820, h: 500, label: 'tablet pendek' },
  { w: 390, h: 844, label: 'ponsel' },
  { w: 390, h: 560, label: 'ponsel dengan toolbar' },
  { w: 390, h: 420, label: 'sangat pendek' }
];

const probe = (page) => page.evaluate(() => {
  const canvas = document.querySelector('#canvas-host canvas');
  const transport = document.querySelector('.transport');
  const sidebar = document.querySelector('.sidebar');
  const cr = canvas.getBoundingClientRect();
  const tr = transport.getBoundingClientRect();
  const sr = sidebar.getBoundingClientRect();
  return {
    innerH: window.innerHeight,
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
    transportBottom: Math.round(tr.bottom),
    transportH: Math.round(tr.height),
    sidebarBottom: Math.round(sr.bottom),
    sidebarScrolls: sidebar.scrollHeight > sidebar.clientHeight + 1
  };
});

(async () => {
  const url = buildSite();

  r.section('Berkas CSS');
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'css', 'style.css'), 'utf8');
  const bodyRule = css.slice(css.indexOf('body {'), css.indexOf('body {') + 900);
  r.check('tinggi app memakai dvh', /height:\s*100dvh/.test(bodyRule),
    'tidak ada 100dvh di aturan body');
  r.check('100vh tetap ada lebih dulu sebagai cadangan',
    bodyRule.indexOf('height: 100vh') !== -1 &&
    bodyRule.indexOf('height: 100vh') < bodyRule.indexOf('height: 100dvh'));
  r.check('kanvas tidak dipaksa tinggi minimum yang keras',
    !/\.viewport\s*\{[^}]*min-height:\s*\d+px/.test(css),
    'min-height px pada .viewport mendorong transport bar keluar layar');

  const browser = await launch();
  const errors = [];

  for (const size of SIZES) {
    r.section(size.label + ' (' + size.w + '×' + size.h + ')');
    const page = await browser.newPage({ locale: 'id-ID', viewport: { width: size.w, height: size.h } });
    page.on('pageerror', e => errors.push(size.label + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(size.label + ': ' + m.text()); });

    await page.goto(url);
    await page.waitForTimeout(1600);
    const m = await probe(page);
    r.info('kanvas ' + m.canvasW + '×' + m.canvasH +
      '  transport bawah ' + m.transportBottom + '/' + m.innerH +
      (m.sidebarScrolls ? '  sidebar bisa di-scroll' : ''));

    r.check('halaman tidak lebih tinggi dari layar', m.bodyH <= m.innerH + 1,
      m.bodyH + ' > ' + m.innerH);
    r.check('transport bar utuh di dalam layar', m.transportBottom <= m.innerH + 1,
      'bawah ' + m.transportBottom + ' melewati ' + m.innerH);
    r.check('kanvas punya ukuran nyata', m.canvasW > 100 && m.canvasH > 80,
      m.canvasW + '×' + m.canvasH);
    r.check('kontrol pemutaran tidak tergencet habis', m.transportH > 30, String(m.transportH));

    if (size.label === 'ponsel dengan toolbar') {
      await page.screenshot({ path: path.join(OUT, 'layout-sempit.png') });
    }
    await page.close();
  }

  r.section('Layar ber-kerapatan tinggi');
  /*
   * Celah nyata di pengujian sebelumnya: semuanya berjalan di dpr 1.
   *
   * Dengan renderer.setSize(w, h, false), three hanya menyetel atribut
   * width/height kanvas ke ukuran buffer gambar dan tidak menyetel gaya
   * CSS-nya. Di dpr 2 elemen kanvasnya jadi dua kali lebih besar dari
   * wadahnya — model yang di tengah kanvas muncul di pojok kanan bawah,
   * ukurannya membesar, dan bar kontrol terdorong keluar. Semua test
   * lolos karena tidak satu pun berjalan di luar dpr 1.
   */
  for (const dpr of [1, 2, 3]) {
    const page = await browser.newPage({
      locale: 'id-ID', viewport: { width: 1194, height: 790 }, deviceScaleFactor: dpr
    });
    page.on('pageerror', e => errors.push('dpr' + dpr + ': ' + e.message));
    await page.goto(url);
    await page.waitForTimeout(1700);

    const m = await page.evaluate(() => {
      const host = document.getElementById('canvas-host').getBoundingClientRect();
      const cv = document.querySelector('#canvas-host canvas');
      const rect = cv.getBoundingClientRect();
      const tr = document.querySelector('.transport').getBoundingClientRect();
      return {
        dpr: window.devicePixelRatio,
        hostW: Math.round(host.width), hostH: Math.round(host.height),
        cssW: Math.round(rect.width), cssH: Math.round(rect.height),
        bufW: cv.width, bufH: cv.height,
        transportBottom: Math.round(tr.bottom), innerH: window.innerHeight
      };
    });
    r.info('dpr ' + m.dpr + ': wadah ' + m.hostW + '\u00d7' + m.hostH +
      ', kanvas CSS ' + m.cssW + '\u00d7' + m.cssH + ', buffer ' + m.bufW + '\u00d7' + m.bufH);

    r.check('dpr ' + dpr + ': kanvas tidak lebih besar dari wadahnya',
      m.cssW <= m.hostW + 2 && m.cssH <= m.hostH + 2,
      m.cssW + '\u00d7' + m.cssH + ' vs wadah ' + m.hostW + '\u00d7' + m.hostH);
    r.check('dpr ' + dpr + ': kanvas mengisi wadahnya',
      m.cssW >= m.hostW - 2 && m.cssH >= m.hostH - 2,
      m.cssW + '\u00d7' + m.cssH);
    r.check('dpr ' + dpr + ': buffer gambar tetap mengikuti kerapatan layar',
      m.bufW >= m.cssW * Math.min(m.dpr, 2) - 4, m.bufW + ' untuk css ' + m.cssW);
    r.check('dpr ' + dpr + ': bar kontrol tetap terlihat',
      m.transportBottom <= m.innerH + 1, m.transportBottom + '/' + m.innerH);
    await page.close();
  }

  r.section('Tinggi app dikunci ke area yang terlihat');
  {
    const page = await browser.newPage({ locale: 'id-ID', viewport: { width: 1024, height: 700 } });
    page.on('pageerror', e => errors.push('app-height: ' + e.message));
    await page.goto(url);
    await page.waitForTimeout(1600);

    const varValue = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim());
    r.info('--app-height = ' + varValue + ' (innerHeight ' + (await page.evaluate(() => window.innerHeight)) + ')');
    r.check('--app-height disetel oleh JavaScript', /\d+px/.test(varValue), varValue);

    // Inti pengujiannya: satuan CSS viewport tidak bisa ditiru di
    // headless, tapi PLUMBING-nya bisa. Kalau variabelnya dikecilkan
    // paksa, tata letak harus ikut mengecil dan bar kontrol tetap di
    // dalamnya — itu yang menjamin perbaikan ini bekerja di perangkat
    // yang melaporkan viewport lebih tinggi dari kenyataan.
    // Sengaja TANPA memicu event resize: handler resize akan memanggil
    // syncAppHeight dan langsung menimpa nilai paksaan ini.
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--app-height', '420px');
    });
    await page.waitForTimeout(300);

    const shrunk = await page.evaluate(() => {
      const body = document.body.getBoundingClientRect();
      const tr = document.querySelector('.transport').getBoundingClientRect();
      const cv = document.querySelector('#canvas-host canvas').getBoundingClientRect();
      return {
        bodyH: Math.round(body.height),
        transportBottom: Math.round(tr.bottom),
        transportH: Math.round(tr.height),
        canvasH: Math.round(cv.height)
      };
    });
    r.info('dipaksa 420px: body ' + shrunk.bodyH + ', transport bawah ' + shrunk.transportBottom +
      ', kanvas tinggi ' + shrunk.canvasH);
    r.check('tata letak mengikuti --app-height', Math.abs(shrunk.bodyH - 420) <= 1, String(shrunk.bodyH));
    r.check('bar kontrol tetap di dalam tinggi yang dipaksa',
      shrunk.transportBottom <= 421, String(shrunk.transportBottom));
    r.check('bar kontrol tidak tergencet habis', shrunk.transportH > 30, String(shrunk.transportH));
    r.check('kanvas masih punya ukuran', shrunk.canvasH > 60, String(shrunk.canvasH));
    await page.close();
  }

  r.section('Final');
  r.check('tidak ada error JS di ukuran mana pun', errors.length === 0, errors.join('\n      '));

  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
