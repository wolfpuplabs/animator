/*
 * Test browser: pengalih bahasa.
 *
 * Yang gampang tertinggal bukan teks statis di HTML, tapi bagian yang
 * dibangun JavaScript: daftar klip, laporan statistik, catatan export,
 * judul tombol. Test ini memindai seluruh sidebar untuk sisa kata
 * Indonesia setelah beralih ke Inggris.
 */
'use strict';

const path = require('path');
const { buildSite, launch, createReporter, waitIdle, OUT } = require('./harness');

const r = createReporter('i18n');

// Kata yang tidak mungkin muncul di antarmuka Inggris yang benar.
const INDONESIAN_MARKERS = [
  'Muat', 'Taruh', 'Kembalikan', 'Perbaiki', 'Haluskan', 'Iterasi',
  'Klip', 'klip', 'Proses', 'Cari animasi', 'Bekerja pada mesh',
  'Kerapatan', 'Menukar', 'Jaga pose', 'Melandaikan', 'Bayangan',
  'Jalur', 'Waktu proses', 'Vertex diperiksa', 'Laporan', 'Tampilkan',
  'Pengaruh', 'diproses', 'Bobot', 'atau klik',
  // judul seksi: di-CSS jadi huruf besar, hanya tertangkap oleh
  // pemindaian yang tidak peduli huruf besar-kecil
  'Sumber Animasi', 'Mode Kualitas', 'Laporan Sintesis'
];

/*
 * Pemindaian sengaja tidak peduli huruf besar-kecil.
 *
 * innerText mengembalikan teks SETELAH text-transform, jadi judul seksi
 * yang di-CSS jadi huruf besar akan terbaca "PARAMETER", bukan
 * "Parameter". Pemindai yang case-sensitive akan diam saja kalau judul
 * seperti itu tertinggal belum diterjemahkan.
 */
const scanFor = (page, selector, markers) => page.evaluate(([sel, words]) => {
  const root = document.querySelector(sel);
  if (!root) return ['selector tidak ditemukan: ' + sel];
  const text = root.innerText.toLowerCase();
  const hits = [];
  words.forEach((w) => { if (text.indexOf(w.toLowerCase()) !== -1) hits.push(w); });
  root.querySelectorAll('[title]').forEach((el) => {
    words.forEach((w) => {
      const key = 'title:' + w;
      if (el.getAttribute('title').toLowerCase().indexOf(w.toLowerCase()) !== -1 &&
          hits.indexOf(key) === -1) {
        hits.push(key);
      }
    });
  });
  return hits;
}, [selector, markers]);

(async () => {
  const url = buildSite();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: 'id-ID' });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(url);
  await page.waitForTimeout(2200);

  r.section('Bawaan');
  r.check('memulai dalam bahasa Indonesia untuk locale id-ID',
    (await page.locator('#btn-lang').textContent()).trim() === 'English',
    await page.locator('#btn-lang').textContent());
  r.check('atribut lang dokumen ikut disetel',
    (await page.evaluate(() => document.documentElement.lang)) === 'id');
  r.check('teks Indonesia memang ada sebelum diganti',
    (await scanFor(page, '.sidebar', INDONESIAN_MARKERS)).length > 5);

  r.section('Beralih ke Inggris');
  await page.locator('#btn-lang').click();
  await page.waitForTimeout(500);
  r.check('tombol berubah jadi Indonesia',
    (await page.locator('#btn-lang').textContent()).trim() === 'Indonesia');
  r.check('atribut lang jadi en',
    (await page.evaluate(() => document.documentElement.lang)) === 'en');

  let leftovers = await scanFor(page, '.sidebar', INDONESIAN_MARKERS);
  r.check('tidak ada sisa teks Indonesia di sidebar', leftovers.length === 0,
    'tersisa: ' + leftovers.join(', '));
  leftovers = await scanFor(page, '.viewport', INDONESIAN_MARKERS);
  r.check('tidak ada sisa teks Indonesia di viewport', leftovers.length === 0,
    'tersisa: ' + leftovers.join(', '));
  leftovers = await scanFor(page, 'header', INDONESIAN_MARKERS);
  r.check('tidak ada sisa teks Indonesia di header', leftovers.length === 0,
    'tersisa: ' + leftovers.join(', '));

  r.section('Bagian yang dibangun JavaScript');
  r.info('daftar klip: ' + (await page.locator('.clip-row').first().innerText()).replace(/\n/g, ' | '));
  r.check('baris klip memakai kata Inggris',
    (await page.locator('.clip-row').first().innerText()).indexOf('keys') !== -1,
    await page.locator('.clip-row').first().innerText());
  // demo hanya punya satu klip, jadi yang benar justru bentuk tunggal
  r.check('hitungan klip dalam bahasa Inggris, bentuk tunggal',
    /^1 clip$/.test((await page.locator('#clip-count').textContent()).trim()),
    await page.locator('#clip-count').textContent());
  r.check('catatan export dalam bahasa Inggris',
    /ORIGINAL clips/.test(await page.locator('#export-note').textContent()),
    await page.locator('#export-note').textContent());

  r.section('Setelah enhance');
  await page.locator('.preset[data-preset="quality"]').click();
  await page.locator('#btn-run').click();
  await waitIdle(page, 60000);
  await page.waitForTimeout(400);
  leftovers = await scanFor(page, '.stats-card', INDONESIAN_MARKERS);
  r.check('laporan statistik tidak menyisakan teks Indonesia', leftovers.length === 0,
    'tersisa: ' + leftovers.join(', '));
  r.check('catatan export ikut berubah setelah enhance',
    /ENHANCED clips/.test(await page.locator('#export-note').textContent()),
    await page.locator('#export-note').textContent());

  r.section('Beralih balik saat sudah ada data');
  await page.locator('#btn-lang').click();
  await page.waitForTimeout(500);
  // innerText memakai teks setelah text-transform, jadi judulnya huruf besar
  r.check('statistik kembali ke Indonesia',
    /laporan sintesis/i.test(await page.locator('.stats-card').innerText()),
    await page.locator('.stats-card h4').textContent());
  r.check('daftar klip kembali ke Indonesia',
    !/keys/.test(await page.locator('.clip-row').first().innerText()),
    await page.locator('.clip-row').first().innerText());
  r.check('nilai statistik tidak hilang saat bahasa diganti',
    (await page.locator('#st-jitter').textContent()).indexOf('%') !== -1,
    await page.locator('#st-jitter').textContent());

  r.section('Bentuk jamak');
  // Bahasa Inggris menandai jamak, Indonesia tidak. Tanpa penanganan
  // khusus antarmuka Inggris akan menulis "1 clips".
  // Pada titik ini bahasanya sudah dikembalikan ke Indonesia, jadi kamus
  // Inggris dibaca secara eksplisit lalu keadaannya dipulihkan supaya
  // bagian test berikutnya tidak terganggu.
  const plural = await page.evaluate(() => {
    const prev = I18n.getLang();
    I18n.setLang('en');
    const out = {
      one: I18n.t('clip.count', { n: 1 }),
      many: I18n.t('clip.count', { n: 7 }),
      doneOne: I18n.t('toast.done', { n: 1, ms: 10 })
    };
    I18n.setLang(prev);
    return out;
  });
  r.info('en: "' + plural.one + '" / "' + plural.many + '"');
  r.check('tunggal tidak memakai akhiran jamak', plural.one === '1 clip', plural.one);
  r.check('jamak tetap benar', plural.many === '7 clips', plural.many);
  r.check('toast ikut memakai bentuk tunggal', /^1 clip /.test(plural.doneOne), plural.doneOne);

  r.section('Pilihan bahasa diingat');
  await page.locator('#btn-lang').click(); // kembali ke Inggris
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForTimeout(2200);
  r.check('masih Inggris setelah halaman dimuat ulang',
    (await page.locator('#btn-lang').textContent()).trim() === 'Indonesia',
    await page.locator('#btn-lang').textContent());

  r.section('Locale lain');
  const enPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await enPage.goto(url);
  await enPage.waitForTimeout(2000);
  r.check('locale en-US memulai dalam bahasa Inggris',
    (await enPage.locator('#btn-lang').textContent()).trim() === 'Indonesia',
    await enPage.locator('#btn-lang').textContent());
  await enPage.close();

  r.section('Final');
  r.check('tidak ada error JS', errors.length === 0, errors.join('\n      '));

  await page.screenshot({ path: path.join(OUT, 'i18n-en.png') });
  await browser.close();
  r.finish();
})().catch(e => { console.error(e); process.exit(1); });
