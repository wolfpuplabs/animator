/**
 * Penjaga paritas kamus.
 *
 * Kesalahan yang paling mudah terjadi saat menambah fitur adalah menaruh
 * kunci baru di satu bahasa saja. `t()` jatuh ke kunci mentah kalau tidak
 * ketemu, jadi yang muncul di UI adalah string seperti `video.quality` —
 * tidak crash, cuma jelek, dan karena itu gampang lolos.
 */

var path = require('path');
var fs = require('fs');
var I18n = require(path.join(__dirname, '..', 'js', 'i18n.js'));

var pass = 0, fail = 0, failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

console.log('\nParitas kamus');

var langs = Object.keys(I18n.DICT);
check('ada lebih dari satu bahasa', langs.length >= 2, langs.join(', '));

var base = langs[0];
var baseKeys = I18n.keys(base).slice().sort();
check('kamus dasar tidak kosong', baseKeys.length > 0, String(baseKeys.length));

langs.slice(1).forEach(function (lang) {
  var keys = I18n.keys(lang).slice().sort();
  var missing = baseKeys.filter(function (k) { return keys.indexOf(k) === -1; });
  var extra = keys.filter(function (k) { return baseKeys.indexOf(k) === -1; });
  check('"' + lang + '" tidak kehilangan kunci', missing.length === 0, missing.join(', '));
  check('"' + lang + '" tidak punya kunci asing', extra.length === 0, extra.join(', '));
});

console.log('\nNilai kamus');

langs.forEach(function (lang) {
  var table = I18n.DICT[lang];
  var empty = Object.keys(table).filter(function (k) {
    return typeof table[k] !== 'string' || table[k].trim() === '';
  });
  check('"' + lang + '" tidak ada nilai kosong', empty.length === 0, empty.join(', '));
});

// Placeholder {x} harus sama di semua bahasa: terjemahan yang kehilangan
// placeholder akan menampilkan pesan tanpa angkanya.
var placeholders = function (s) {
  var found = s.match(/\{[a-zA-Z0-9_]+\}/g) || [];
  return found.slice().sort().join(',');
};

var mismatched = baseKeys.filter(function (key) {
  var want = placeholders(I18n.DICT[base][key]);
  return langs.slice(1).some(function (lang) {
    var val = I18n.DICT[lang][key];
    return typeof val === 'string' && placeholders(val) !== want;
  });
});
check('placeholder konsisten antar bahasa', mismatched.length === 0, mismatched.join(', '));

console.log('\nKunci yang dipakai markup');

// Setiap data-i18n* di index.html harus punya kunci; kalau tidak, teksnya
// akan muncul sebagai nama kunci di layar.
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
var used = [];
var re = /data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g;
var m;
while ((m = re.exec(html)) !== null) { if (used.indexOf(m[1]) === -1) used.push(m[1]); }
check('markup memakai kunci i18n', used.length > 0, String(used.length));

var unknown = used.filter(function (k) { return baseKeys.indexOf(k) === -1; });
check('semua kunci di markup ada di kamus', unknown.length === 0, unknown.join(', '));

console.log('');
if (fail === 0) {
  console.log('✅ ' + pass + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + pass + ' passed, ' + fail + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
