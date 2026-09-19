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

  r.section('Final');
  r.check('tidak ada error JS di ukuran mana pun', errors.length === 0, errors.join('\n      '));

  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
