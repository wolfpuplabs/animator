/*
 * Perkakas bersama untuk test browser.
 *
 * Halaman aslinya menarik three.js dari CDN. Untuk pengujian kita salin
 * halaman itu ke direktori sementara dan arahkan tag <script>-nya ke
 * three.js dari node_modules, supaya test tidak bergantung pada jaringan
 * dan selalu memakai versi yang sama.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(__dirname, '.tmp');
const OUT = path.join(__dirname, 'out');

const THREE_FILES = [
  ['build/three.min.js', 'three.min.js'],
  ['examples/js/controls/OrbitControls.js', 'OrbitControls.js'],
  ['examples/js/loaders/GLTFLoader.js', 'GLTFLoader.js'],
  ['examples/js/exporters/GLTFExporter.js', 'GLTFExporter.js']
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Siapkan salinan situs yang memakai three.js lokal; kembalikan URL file://. */
function buildSite() {
  let threeRoot;
  try {
    threeRoot = path.dirname(require.resolve('three/package.json', { paths: [ROOT] }));
  } catch (err) {
    throw new Error('three.js belum terpasang — jalankan `npm install` lebih dulu.');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'vendor'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  copyDir(path.join(ROOT, 'js'), path.join(TMP, 'js'));
  copyDir(path.join(ROOT, 'css'), path.join(TMP, 'css'));

  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const [from, to] of THREE_FILES) {
    const src = path.join(threeRoot, from);
    if (!fs.existsSync(src)) throw new Error('File three.js tidak ditemukan: ' + src);
    fs.copyFileSync(src, path.join(TMP, 'vendor', to));
    // ganti URL CDN apa pun yang berakhir dengan nama file ini
    html = html.replace(new RegExp('https://[^"\']*/' + to.replace('.', '\\.'), 'g'), 'vendor/' + to);
  }
  fs.writeFileSync(path.join(TMP, 'index.html'), html);

  const remaining = html.match(/src="https?:\/\/[^"]+"/g);
  if (remaining) throw new Error('Masih ada script dari jaringan: ' + remaining.join(', '));

  return 'file://' + path.join(TMP, 'index.html');
}

async function launch() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    throw new Error('playwright belum terpasang — jalankan `npm install` lebih dulu.');
  }
  // CHROMIUM_PATH berguna di lingkungan yang sudah punya Chromium sendiri
  const exe = process.env.CHROMIUM_PATH;
  const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'];
  return chromium.launch(exe ? { executablePath: exe, args } : { args });
}

/** Pencatat hasil test sederhana. */
function createReporter(title) {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    section(name) { console.log('\n' + name); },
    check(name, cond, extra) {
      if (cond) { pass++; console.log('  ✓ ' + name); }
      else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
    },
    info(text) { console.log('      ' + text); },
    finish() {
      console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + title + ': ' + pass + ' passed, ' + fail + ' failed\n');
      if (fail) failures.forEach(f => console.log('  - ' + f));
      process.exit(fail ? 1 : 0);
    }
  };
}

/** Baca chunk JSON dari buffer .glb; null kalau bukan glTF biner. */
function parseGLB(buf) {
  if (buf.length < 20 || buf.slice(0, 4).toString('ascii') !== 'glTF') return null;
  return JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
}

const waitIdle = (page, timeout = 30000) =>
  page.waitForFunction(() => !document.getElementById('overlay').classList.contains('active'), null, { timeout });

module.exports = { buildSite, launch, createReporter, parseGLB, waitIdle, OUT };
