/*
 * Menjaga standalone.html tetap sinkron dengan sumbernya.
 *
 * Berkas hasil rakitan gampang basi tanpa disadari: orang mengedit
 * js/app.js, lupa menjalankan build, lalu berkas satu-file yang beredar
 * diam-diam berisi versi lama. Test ini menolak keadaan itu.
 */
'use strict';

const fs = require('fs');
const { build, OUTPUT } = require('../tools/build-standalone.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (err) { fail++; console.log('  ✗ ' + name + '\n      ' + err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\nStandalone build');

test('standalone.html ada', function () {
  assert(fs.existsSync(OUTPUT), 'belum dibuat — jalankan `npm run build`');
});

test('standalone.html sinkron dengan sumbernya', function () {
  const fresh = build().html;
  const current = fs.readFileSync(OUTPUT, 'utf8');
  assert(fresh === current, 'sudah basi — jalankan `npm run build` lalu commit ulang');
});

test('tidak ada rujukan berkas lokal yang tertinggal', function () {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert(!/src="js\//.test(html), 'masih merujuk js/ dari luar');
  assert(!/href="css\//.test(html), 'masih merujuk css/ dari luar');
});

test('isi engine benar-benar ikut ter-inline', function () {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert(html.includes('Motion Fluidity Synthesis) core engine'), 'fluidizer tidak ter-inline');
  assert(html.includes('ThreeAdapter'), 'adapter tidak ter-inline');
  assert(html.includes('function runEnhance'), 'app tidak ter-inline');
});

test('three.js tetap dari CDN lewat import map (tidak ikut dibundel)', function () {
  const html = fs.readFileSync(OUTPUT, 'utf8');

  // Sejak three dimuat sebagai modul, tidak ada lagi tag <script src>
  // ke jaringan: yang menentukan asalnya cuma import map.
  const cdnTags = html.match(/<script src="https?:\/\/[^"]+"><\/script>/g) || [];
  assert(cdnTags.length === 0,
    'masih ada tag script jaringan: ' + cdnTags.join(', '));

  assert(/<script type="importmap">/.test(html), 'import map tidak ada');
  const map = html.match(/"three":\s*"(https:\/\/[^"]+)"/);
  assert(map, 'specifier "three" tidak menunjuk CDN');
  assert(/\/three@\d+\.\d+\.\d+\/build\/three\.module\.js$/.test(map[1]),
    'URL three tidak menyebut versi pasti: ' + map[1]);
  const addons = html.match(/"three\/addons\/":\s*"(https:\/\/[^"]+)"/);
  assert(addons, 'prefiks "three/addons/" tidak ada di import map');
  assert(addons[1].endsWith('/examples/jsm/'), 'prefiks addons salah: ' + addons[1]);

  ['OrbitControls', 'GLTFLoader', 'FBXLoader', 'GLTFExporter', 'SkeletonUtils']
    .forEach(function (name) {
      assert(html.indexOf("three/addons/") !== -1 && html.indexOf(name) !== -1,
        name + ' tidak diimpor');
    });

  // Kalau three ikut ter-inline, berkasnya akan membengkak ratusan KB.
  assert(html.indexOf('class WebGLRenderer') === -1, 'three ikut ter-bundel');
});

test('build menolak script yang mengandung penutup tag', function () {
  const path = require('path');
  const tmp = path.join(__dirname, '..', 'js', '__probe.js');
  fs.writeFileSync(tmp, 'var s = "</scr" + "ipt>";\n'.replace('</scr" + "ipt>', '</script>'));
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const patched = html.replace('<script src="js/app.js"></script>',
      '<script src="js/__probe.js"></script>\n  <script src="js/app.js"></script>');
    fs.writeFileSync(path.join(__dirname, '..', 'index.html.bak'), html);
    fs.writeFileSync(path.join(__dirname, '..', 'index.html'), patched);
    let threw = false;
    try { build(); } catch (err) { threw = /script/.test(err.message); }
    assert(threw, 'build diam saja padahal isinya bisa menutup tag lebih awal');
  } finally {
    const bak = path.join(__dirname, '..', 'index.html.bak');
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, path.join(__dirname, '..', 'index.html'));
      fs.unlinkSync(bak);
    }
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
});

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' passed, ' + fail + ' failed\n');
if (fail) process.exit(1);
