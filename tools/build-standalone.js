/*
 * Merakit index.html + css + js jadi satu berkas HTML yang berdiri sendiri.
 *
 * Gunanya untuk ditempel ke CodePen, dikirim lewat chat, atau dibuka
 * langsung dari disk tanpa perlu menjaga struktur folder. three.js tetap
 * diambil dari CDN — mem-bundle 600 KB ke dalamnya tidak sepadan, dan
 * halaman ini memang butuh internet untuk itu.
 *
 * Jalankan: npm run build
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'standalone.html');

const BANNER = [
  '<!--',
  '  MFS 5 — Motion Fluidity Synthesis (berkas tunggal)',
  '',
  '  DIBUAT OTOMATIS oleh tools/build-standalone.js — jangan diedit langsung.',
  '  Ubah sumbernya di index.html / css/ / js/ lalu jalankan `npm run build`.',
  '-->'
].join('\n');

function readAsset(rel) {
  const file = path.join(ROOT, rel);
  const body = fs.readFileSync(file, 'utf8');
  // Teks "</script>" di dalam isi script akan menutup tag lebih awal dan
  // merusak halaman secara diam-diam.
  if (/<\/script/i.test(body)) {
    throw new Error(rel + ' mengandung "</script>" — tidak bisa di-inline apa adanya.');
  }
  return body.replace(/\s+$/, '');
}

function build() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const styleTag = /[ \t]*<link rel="stylesheet" href="(css\/[^"]+)">\n?/g;
  let styles = 0;
  html = html.replace(styleTag, (_, href) => {
    styles++;
    return '  <style>\n' + readAsset(href) + '\n  </style>\n';
  });
  if (styles === 0) throw new Error('tidak ada <link rel="stylesheet"> yang cocok di index.html');

  const localScript = /[ \t]*<script src="(js\/[^"]+)"><\/script>\n?/g;
  let scripts = 0;
  html = html.replace(localScript, (_, src) => {
    scripts++;
    return '  <script>\n' + readAsset(src) + '\n  </script>\n';
  });
  if (scripts === 0) throw new Error('tidak ada <script src="js/..."> yang cocok di index.html');

  const leftover = html.match(/(?:src|href)="(?!https?:)[^"]+"/g);
  const external = (leftover || []).filter((m) => !m.includes('"#'));
  if (external.length) {
    throw new Error('masih ada rujukan berkas lokal: ' + external.join(', '));
  }

  html = html.replace(/^<!DOCTYPE html>/i, '<!DOCTYPE html>\n' + BANNER);
  return { html, styles, scripts };
}

if (require.main === module) {
  const { html, styles, scripts } = build();
  fs.writeFileSync(OUTPUT, html);
  console.log('standalone.html ditulis — ' + styles + ' stylesheet + ' + scripts +
    ' script di-inline, ' + (html.length / 1024).toFixed(1) + ' KB');
}

module.exports = { build, OUTPUT };
