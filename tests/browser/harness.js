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

// three.js dimuat sebagai modul, jadi yang disalin bukan lagi daftar
// berkas lepas: build/ saling mengimpor (three.module.js menarik
// three.core.js) dan addon di examples/jsm/ mengimpor 'three' lewat
// import map plus berkas tetangganya. Menyalin kedua pohon itu utuh jauh
// lebih tahan banting daripada menebak satu per satu.
const THREE_DIRS = [
  ['build', 'three/build'],
  ['examples/jsm', 'three/examples/jsm']
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

/**
 * Letak paket three.js di disk.
 *
 * require.resolve('three/package.json') tidak bisa dipakai lagi: medan
 * `exports` paket ini tidak mengekspos package.json, jadi sejak versi
 * modul resolusinya melempar. Direktorinya dicari langsung, dan
 * keberadaan build-nya yang dijadikan bukti paketnya benar terpasang.
 */
function resolveThree() {
  const dir = path.join(ROOT, 'node_modules', 'three');
  if (!fs.existsSync(path.join(dir, 'build', 'three.module.js'))) {
    throw new Error('three.js belum terpasang — jalankan `npm install` lebih dulu.');
  }
  return dir;
}

/**
 * Salin three.js ke dalam situs uji dan arahkan import map ke sana.
 *
 * Dipakai buildSite() dan buildStandaloneSite(): keduanya harus lepas
 * dari jaringan, dan keduanya memuat three lewat import map yang sama.
 */
function vendorThree(html, dir) {
  const threeRoot = resolveThree();
  for (const [from, to] of THREE_DIRS) {
    const src = path.join(threeRoot, from);
    if (!fs.existsSync(src)) throw new Error('Folder three.js tidak ditemukan: ' + src);
    copyDir(src, path.join(dir, 'vendor', to));
  }
  // Dua entri import map: specifier 'three' menunjuk satu berkas,
  // prefiks 'three/addons/' menunjuk sebuah folder.
  //
  // Awalan './' wajib. Import map hanya menerima alamat relatif yang
  // dimulai dengan '/', './' atau '../'; 'vendor/...' polos dianggap
  // specifier, entrinya jadi null, dan import 'three' gagal dengan
  // "blocked by a null value".
  return html
    .replace(/"https:\/\/[^"]*\/three@[^"]*\/build\/three\.module\.js"/g,
      '"./vendor/three/build/three.module.js"')
    .replace(/"https:\/\/[^"]*\/three@[^"]*\/examples\/jsm\/"/g,
      '"./vendor/three/examples/jsm/"');
}

/** Tidak boleh ada apa pun yang masih diambil dari jaringan. */
function assertOffline(html) {
  const left = (html.match(/src="https?:\/\/[^"]+"/g) || [])
    .concat(html.match(/"https?:\/\/[^"]*three@[^"]*"/g) || []);
  if (left.length) throw new Error('Masih ada berkas dari jaringan: ' + left.join(', '));
}

/*
 * Sejak three dimuat sebagai modul ES, halamannya TIDAK BISA lagi dibuka
 * lewat file://: modul tunduk pada CORS, dan berkas lokal beroperasi di
 * origin 'null' sehingga setiap import diblokir. Jadi situs ujinya
 * disajikan lewat HTTP lokal, persis seperti yang sudah dilakukan test
 * video sejak awal.
 */
async function buildSite() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'vendor'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  copyDir(path.join(ROOT, 'js'), path.join(TMP, 'js'));
  copyDir(path.join(ROOT, 'css'), path.join(TMP, 'css'));

  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = vendorThree(html, TMP);
  // Arahkan deteksi pose ke berkas lokal kalau tersedia.
  const mp = prepareMediaPipe(TMP);
  if (mp) {
    html = html.replace('<script src="js/i18n.js">',
      '<script>window.MFS_MEDIAPIPE = ' + JSON.stringify(mp) + ';</script>\n  <script src="js/i18n.js">');
  }

  fs.writeFileSync(path.join(TMP, 'index.html'), html);

  assertOffline(html);

  return (await serveDir(TMP)).url;
}

/**
 * Sama seperti buildSite(), tapi untuk standalone.html — berkas tunggal
 * hasil rakitan. Tidak ada css/ atau js/ yang perlu disalin; yang perlu
 * diarahkan ke lokal hanya tag CDN three.js.
 */
async function buildStandaloneSite() {
  const dir = path.join(__dirname, '.tmp-standalone');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const file = path.join(ROOT, 'standalone.html');
  if (!fs.existsSync(file)) throw new Error('standalone.html belum dibuat — jalankan `npm run build`.');
  let html = fs.readFileSync(file, 'utf8');

  html = vendorThree(html, dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);

  assertOffline(html);

  return (await serveDir(dir)).url;
}

/*
 * Test di luar i18n.test.js menegaskan teks berbahasa Indonesia, jadi
 * halamannya dibuat dengan locale id-ID. Tanpa itu, aplikasi mengikuti
 * locale bawaan Playwright (en-US) dan tampil dalam bahasa Inggris —
 * asersi teksnya jadi gagal karena alasan yang tidak ada hubungannya
 * dengan apa yang sedang diuji.
 */
const MP_CACHE = path.join(__dirname, '.cache');
const MP_MODEL = path.join(MP_CACHE, 'pose_landmarker_lite.task');
const MP_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
  'pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * Siapkan berkas MediaPipe lokal supaya deteksi pose bisa diuji tanpa CDN.
 *
 * Modul dan wasm datang dari node_modules, tapi berkas modelnya (5,7 MB)
 * tidak ada di npm mana pun. Berkas itu di-cache di tests/browser/.cache
 * dan tidak ikut repo. Kalau belum ada dan tidak bisa diunduh, fungsi ini
 * mengembalikan null supaya test yang membutuhkannya melewat dengan
 * keterangan, bukan gagal karena hal yang tidak ada hubungannya.
 */
function prepareMediaPipe(targetDir) {
  // require.resolve tidak bisa dipakai di sini: medan `exports` paket ini
  // tidak mengekspos package.json, jadi direktorinya dicari langsung.
  const pkgRoot = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
  if (!fs.existsSync(path.join(pkgRoot, 'vision_bundle.mjs'))) return null;
  if (!fs.existsSync(MP_MODEL)) return null;

  const dest = path.join(targetDir, 'vendor', 'mediapipe');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(pkgRoot, 'vision_bundle.mjs'), path.join(dest, 'vision_bundle.mjs'));
  copyDir(path.join(pkgRoot, 'wasm'), path.join(dest, 'wasm'));
  fs.copyFileSync(MP_MODEL, path.join(dest, 'model.task'));
  return {
    module: 'vendor/mediapipe/vision_bundle.mjs',
    wasm: 'vendor/mediapipe/wasm',
    model: 'vendor/mediapipe/model.task'
  };
}

/** Jalan kalau berkas model sudah ada atau berhasil diunduh. */
async function ensureMediaPipeModel() {
  if (fs.existsSync(MP_MODEL)) return true;
  fs.mkdirSync(MP_CACHE, { recursive: true });
  try {
    const res = await fetch(MP_MODEL_URL);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return false;
    fs.writeFileSync(MP_MODEL, buf);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Sajikan direktori lewat HTTP.
 *
 * Sebagian besar test cukup dengan file://, tapi deteksi pose tidak bisa:
 * blob URL video diblokir di file://, dan import() dari script klasik di
 * sana punya base URL about:blank sehingga modul tidak ter-resolve.
 */
function serveDir(dir) {
  const http = require('http');
  const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
    '.task': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png'
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dir, rel);
    // path.join menormalkan '..', dan pemisah di akhir mencegah direktori
    // sebelah yang namanya berawalan sama ikut terbaca.
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // MFS_SERVE_DEBUG=1 menyebut berkas yang hilang. Tanpa ini, 404 cuma
      // muncul sebagai "Failed to load resource" di konsol peramban, tanpa
      // nama berkas — tidak bisa ditindaklanjuti.
      if (process.env.MFS_SERVE_DEBUG) console.error('  [404] ' + rel);
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // unref: servernya tidak menahan proses tetap hidup, jadi test yang
      // tidak menutupnya sendiri tetap bisa keluar dengan bersih.
      server.unref();
      resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/',
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

const MP_PERSON = path.join(MP_CACHE, 'person.jpg');
const MP_PERSON_URL = 'https://storage.googleapis.com/mediapipe-assets/male_full_height_hands.jpg';

/** Gambar seorang manusia untuk membuat video uji. Di-cache, tidak ikut repo. */
async function ensurePersonImage() {
  if (fs.existsSync(MP_PERSON)) return MP_PERSON;
  fs.mkdirSync(MP_CACHE, { recursive: true });
  try {
    const res = await fetch(MP_PERSON_URL);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null;
    fs.writeFileSync(MP_PERSON, buf);
    return MP_PERSON;
  } catch (err) {
    return null;
  }
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

module.exports = {
  buildSite, buildStandaloneSite, launch, createReporter, parseGLB, waitIdle, OUT,
  ensureMediaPipeModel, ensurePersonImage, MP_CACHE, serveDir, TMP
};
