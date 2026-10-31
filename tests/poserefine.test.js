/**
 * Penjaga pembenahan titik sendi.
 *
 * Ini modul yang paling gampang menipu diri sendiri: hasilnya SELALU
 * terlihat lebih halus, karena menghaluskan memang pekerjaannya. Yang
 * tidak otomatis benar adalah apakah hasilnya lebih DEKAT ke gerakan
 * sebenarnya, atau cuma lebih tenang sambil salah.
 *
 * Jadi test ini tidak mengukur kehalusan. Caranya:
 *
 *   1. dibuat gerakan dengan panjang tulang yang persis tetap —
 *      ini kebenaran acuan, dan satu-satunya tempat kebenaran itu ada
 *   2. gerakan itu dirusak seperti deteksi pose satu kamera merusaknya:
 *      derau kecil di x/y, derau BESAR di z, dan beberapa sendi hilang
 *   3. hasil refine dibandingkan ke kebenaran acuan, bukan ke yang rusak
 *
 * Kalau refine membuat error naik, test ini gagal walau hasilnya mulus.
 *
 * Dan satu peringatan yang dibayar mahal: kebenaran acuan buatan TIDAK
 * cukup. Derau buatan di sini berdiri sendiri-sendiri per sendi;
 * kesalahan MediaPipe sungguhan terstruktur, dan sebuah tahap yang
 * menang bersih di test ini pernah terbukti merusak video sungguhan.
 * Penjaganya ada di bagian terakhir berkas ini, memakai 70 frame
 * keluaran detektor yang nyata. Jangan pernah menilai tahap baru dari
 * bagian atas saja.
 */

var path = require('path');
var R = require(path.join(__dirname, '..', 'js', 'poserefine.js'));
var P = require(path.join(__dirname, '..', 'js', 'posemocap.js'));

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function section(n) { console.log('\n' + n); }
function info(s) { console.log('      ' + s); }

/* ------------------------------------------------------------------ *
 * Kebenaran acuan
 * ------------------------------------------------------------------ */

var FRAMES = 40;

/** Panjang tulang TETAP. Ini yang membuat kebenaran acuan bisa diukur. */
var LEN = {
  hipHalf: 0.10, torso: 0.50, shoulderHalf: 0.18, head: 0.22,
  upperArm: 0.27, lowerArm: 0.25, hand: 0.08,
  upperLeg: 0.45, lowerLeg: 0.45, foot: 0.15
};

function rot(v, axisAngleX, axisAngleZ) {
  // putar di bidang x-y lalu y-z; cukup untuk membuat gerakan yang
  // melibatkan ketiga sumbu tanpa perlu library quaternion di test
  var x = v[0], y = v[1], z = v[2];
  var c = Math.cos(axisAngleZ), s = Math.sin(axisAngleZ);
  var x2 = x * c - y * s, y2 = x * s + y * c;
  var c2 = Math.cos(axisAngleX), s2 = Math.sin(axisAngleX);
  return [x2, y2 * c2 - z * s2, y2 * s2 + z * c2];
}

function addv(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scalev(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function unit(a) {
  var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dist(a, b) {
  var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Satu frame kebenaran acuan, dalam konvensi MediaPipe: y ke bawah,
 * z menjauh dari kamera, titik asal di antara kedua pinggul.
 *
 * Gerakannya: lengan kiri mengayun lewat ketiga sumbu, lengan kanan
 * menekuk di siku, kedua lutut menekuk, dan seluruh badan sedikit
 * berputar. Cukup untuk membuat setiap tulang yang diuji benar-benar
 * berubah arah.
 */
function truthFrame(i) {
  var t = i / (FRAMES - 1);
  var sway = Math.sin(t * Math.PI * 2) * 0.25;

  var j = {};
  j[R.LM.leftHip] = [LEN.hipHalf, 0, 0];
  j[R.LM.rightHip] = [-LEN.hipHalf, 0, 0];

  var up = unit(rot([0, -1, 0], sway * 0.3, sway * 0.15));
  var shoulderCenter = scalev(up, LEN.torso);
  var side = unit(rot([1, 0, 0], sway * 0.3, sway * 0.15));

  j[R.LM.leftShoulder] = addv(shoulderCenter, scalev(side, LEN.shoulderHalf));
  j[R.LM.rightShoulder] = addv(shoulderCenter, scalev(side, -LEN.shoulderHalf));
  // Kepala, telinga kiri dan telinga kanan masing-masing dipasang
  // LANGSUNG ke pusat bahu pada jarak tetap. Percobaan pertama
  // menggantung telinga pada hidung, dan jarak pusat-bahu-ke-telinga
  // jadi berubah 1% seiring badan berputar — kecil, tapi cukup untuk
  // membuat "kebenaran acuan" tidak benar-benar jadi acuan.
  var fwd = unit(cross3(side, up));
  j[R.LM.nose] = addv(shoulderCenter, scalev(unit(addv(up, scalev(fwd, 0.30))), LEN.head));
  j[R.LM.leftEar] = addv(shoulderCenter, scalev(unit(addv(up, scalev(side, 0.30))), LEN.head));
  j[R.LM.rightEar] = addv(shoulderCenter, scalev(unit(addv(up, scalev(side, -0.30))), LEN.head));

  // lengan kiri mengayun 110 derajat
  var swing = -0.3 + t * 1.9;
  var upperL = unit(rot([1, 0, 0], swing * 0.7, swing));
  j[R.LM.leftElbow] = addv(j[R.LM.leftShoulder], scalev(upperL, LEN.upperArm));
  var lowerL = unit(rot(upperL, 0.5 + Math.sin(t * 5) * 0.4, 0.3));
  j[R.LM.leftWrist] = addv(j[R.LM.leftElbow], scalev(lowerL, LEN.lowerArm));
  j[R.LM.leftIndex] = addv(j[R.LM.leftWrist], scalev(lowerL, LEN.hand));

  // lengan kanan menekuk di siku saja
  var upperR = unit([-1, 0.15, 0]);
  j[R.LM.rightElbow] = addv(j[R.LM.rightShoulder], scalev(upperR, LEN.upperArm));
  var bend = 0.4 + Math.sin(t * Math.PI * 3) * 0.6;
  var lowerR = unit(rot(upperR, bend * 0.5, -bend));
  j[R.LM.rightWrist] = addv(j[R.LM.rightElbow], scalev(lowerR, LEN.lowerArm));
  j[R.LM.rightIndex] = addv(j[R.LM.rightWrist], scalev(lowerR, LEN.hand));

  // tungkai: lutut menekuk berlawanan fase
  [['left', 1], ['right', -1]].forEach(function (pair) {
    var sideName = pair[0], sign = pair[1];
    var phase = Math.sin(t * Math.PI * 2 + (sign > 0 ? 0 : Math.PI));
    var hip = j[R.LM[sideName + 'Hip']];
    var thigh = unit(rot([0, 1, 0], phase * 0.45, 0));
    var knee = addv(hip, scalev(thigh, LEN.upperLeg));
    var shin = unit(rot(thigh, -Math.abs(phase) * 0.5, 0));
    var ankle = addv(knee, scalev(shin, LEN.lowerLeg));
    var toe = addv(ankle, scalev(unit([0, 0.3, -1]), LEN.foot));
    j[R.LM[sideName + 'Knee']] = knee;
    j[R.LM[sideName + 'Ankle']] = ankle;
    j[R.LM[sideName + 'FootIndex']] = toe;
  });

  return j;
}

/** Ubah peta sendi jadi array 33 landmark bergaya MediaPipe. */
function toLandmarks(j) {
  var lms = [];
  for (var k = 0; k < 33; k++) lms[k] = { x: 0, y: 0, z: 0, visibility: 0.05 };
  Object.keys(j).forEach(function (idx) {
    lms[idx] = { x: j[idx][0], y: j[idx][1], z: j[idx][2], visibility: 1 };
  });
  return lms;
}

function truthFrames() {
  var out = [];
  for (var i = 0; i < FRAMES; i++) {
    out.push({ time: i / 12, landmarks: toLandmarks(truthFrame(i)) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Perusakan
 * ------------------------------------------------------------------ */

/** LCG: deraunya harus sama tiap kali test dijalankan. */
function rng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Sendi yang hilang. Dua celah pendek yang HARUS terisi, satu celah
// panjang yang harus DIBIARKAN.
var GAPS = [
  { idx: R.LM.leftWrist, from: 10, to: 13 },
  { idx: R.LM.rightKnee, from: 22, to: 24 },
  { idx: R.LM.leftIndex, from: 28, to: 39 }   // 12 frame: lebih dari maxGap
];

/**
 * Rusak seperti deteksi pose satu kamera merusaknya.
 *
 * Derau z sepuluh kali lebih besar daripada x/y. Itu bukan angka
 * karangan: kedalaman dari satu kamera memang ditebak, sementara x
 * dan y datang dari posisi di gambar.
 */
function corrupt(frames, opt) {
  var o = opt || {};
  var planar = o.planar === undefined ? 0.004 : o.planar;
  var depth = o.depth === undefined ? 0.040 : o.depth;
  var rand = rng(20261031);

  return frames.map(function (frame, i) {
    var lms = frame.landmarks.map(function (p) {
      return { x: p.x, y: p.y, z: p.z, visibility: p.visibility };
    });
    R.TRACKED.forEach(function (idx) {
      lms[idx].x += (rand() - 0.5) * 2 * planar;
      lms[idx].y += (rand() - 0.5) * 2 * planar;
      lms[idx].z += (rand() - 0.5) * 2 * depth;
    });
    GAPS.forEach(function (g) {
      if (i >= g.from && i <= g.to) lms[g.idx].visibility = 0.05;
    });
    return { time: frame.time, landmarks: lms };
  });
}

/* ------------------------------------------------------------------ *
 * Pengukuran
 * ------------------------------------------------------------------ */

/** Error posisi sendi rata-rata terhadap kebenaran acuan, dalam meter. */
function positionError(frames, truth) {
  var sum = 0, count = 0;
  frames.forEach(function (frame, i) {
    var t = truth[i].landmarks;
    R.TRACKED.forEach(function (idx) {
      var p = frame.landmarks[idx];
      // Sendi yang memang hilang di kebenaran acuan tidak dihitung;
      // yang diukur cuma sendi yang seharusnya bisa dibetulkan.
      if (!p || t[idx].visibility < 0.5) return;
      sum += dist([p.x, p.y, p.z], [t[idx].x, t[idx].y, t[idx].z]);
      count++;
    });
  });
  return count ? sum / count : 0;
}

/**
 * Error rotasi tulang rata-rata terhadap kebenaran acuan, dalam derajat.
 *
 * Ini angka yang sebenarnya penting: yang dilihat orang di layar
 * rotasi tulang, bukan posisi landmark. Error posisi di pangkal rantai
 * ikut memutar seluruh anggota badan di bawahnya, jadi kedua angka ini
 * tidak selalu bergerak seiring.
 */
function rotationError(frames, truth) {
  var a = P.build(frames, {});
  var b = P.build(truth, {});
  var byName = {};
  b.tracks.forEach(function (t) { byName[t.name] = t; });

  var sum = 0, count = 0;
  a.tracks.forEach(function (ta) {
    if (ta.type !== 'quaternion') return;
    var tb = byName[ta.name];
    if (!tb) return;
    var n = Math.floor(Math.min(ta.values.length, tb.values.length) / 4);
    for (var i = 0; i < n; i++) {
      var d = 0;
      for (var k = 0; k < 4; k++) d += ta.values[i * 4 + k] * tb.values[i * 4 + k];
      d = Math.min(1, Math.abs(d));
      sum += 2 * Math.acos(d) * 180 / Math.PI;
      count++;
    }
  });
  return count ? sum / count : 0;
}

/* ------------------------------------------------------------------ *
 * Test
 * ------------------------------------------------------------------ */

var truth = truthFrames();
var noisy = corrupt(truth);

section('Kebenaran acuan memang bisa dipakai sebagai acuan');

test('panjang tulang di kebenaran acuan praktis tetap', function () {
  // Kalau ini gagal, seluruh test di bawahnya tidak berarti apa-apa:
  // tidak ada yang bisa dibandingkan.
  var s = R.boneLengthSpread(truth, R.resolveOptions({}));
  info('sebaran panjang tulang acuan: rata-rata ' + s.mean.toFixed(3) +
       '%, maks ' + s.max.toFixed(3) + '%');
  assert(s.max < 1, 'acuan sendiri sudah tidak konsisten: maks ' + s.max.toFixed(2) + '%');
});

test('perusakannya benar-benar merusak', function () {
  var s = R.boneLengthSpread(noisy, R.resolveOptions({}));
  info('sebaran setelah dirusak: rata-rata ' + s.mean.toFixed(2) +
       '%, maks ' + s.max.toFixed(2) + '%');
  assert(s.mean > 2, 'perusakannya terlalu lembut: rata-rata ' + s.mean.toFixed(2) + '%');
});

section('Hasilnya lebih dekat ke gerakan sebenarnya');

var refined = R.refine(noisy, {});

test('sebaran panjang tulang dilaporkan, bukan dikoreksi', function () {
  // Angkanya diagnosis: seberapa payah detektornya di video itu.
  // Mengoreksinya sudah dicoba dan terbukti merusak — lihat
  // tests/fixtures/README.md.
  info('sebaran panjang tulang setelah dibereskan: ' +
       refined.stats.spread.mean.toFixed(2) + '% (rata-rata), ' +
       refined.stats.spread.max.toFixed(2) + '% (maks)');
  assert(refined.stats.spread.mean > 0, 'sebaran tidak terukur');
  assert(R.DEFAULTS.lockBones === undefined,
    'tahap kunci panjang tulang kembali — baca tests/fixtures/README.md dulu');
});

test('error posisi sendi turun setidaknya sepertiga', function () {
  var before = positionError(noisy, truth);
  var after = positionError(refined.frames, truth);
  info('error posisi: ' + (before * 1000).toFixed(1) + ' mm → ' +
       (after * 1000).toFixed(1) + ' mm');
  // Bukan "turun" saja: "turun" lolos dengan perbaikan 7 persen.
  assert(after < before * 0.67, 'cuma turun ' +
    (100 - after / before * 100).toFixed(0) + '%: ' +
    (before * 1000).toFixed(1) + ' mm → ' + (after * 1000).toFixed(1) + ' mm');
});

test('error rotasi tulang turun', function () {
  // Ini asersi yang paling penting di berkas ini. Menghaluskan posisi
  // gampang; menghaluskan posisi TANPA memperburuk rotasi tidak.
  var before = rotationError(noisy, truth);
  var after = rotationError(refined.frames, truth);
  info('error rotasi: ' + before.toFixed(2) + '° → ' + after.toFixed(2) + '°');
  assert(after < before, 'error rotasi naik: ' + before.toFixed(2) +
    '° → ' + after.toFixed(2) + '°');
});

test('tiap tahap menyumbang, tidak ada yang cuma menumpang', function () {
  // Tahap yang tidak menyumbang apa-apa lebih buruk daripada tidak ada:
  // dia tetap memakan waktu dan tetap harus dirawat.
  var base = rotationError(noisy, truth);
  var combos = [
    ['isi celah saja', { smooth: false }],
    ['haluskan saja', { gapFill: false }]
  ];
  combos.forEach(function (c) {
    var e = rotationError(R.refine(noisy, c[1]).frames, truth);
    info(c[0] + ': ' + base.toFixed(2) + '° → ' + e.toFixed(2) + '°');
    assert(e < base, c[0] + ' tidak memperbaiki apa pun: ' +
      base.toFixed(2) + '° → ' + e.toFixed(2) + '°');
  });
});

section('Celah sendi');

test('celah pendek diisi, celah panjang dibiarkan', function () {
  info('sendi terisi: ' + refined.stats.gapsFilled);
  assert(refined.stats.gapsFilled > 0, 'tidak ada celah yang terisi');

  var opt = R.resolveOptions({});
  function visible(idx, i) {
    var p = refined.frames[i].landmarks[idx];
    return p && (p.visibility === undefined ? 1 : p.visibility) >= opt.minVisibility;
  }
  GAPS.forEach(function (g) {
    var span = g.to - g.from + 1;
    var mid = Math.floor((g.from + g.to) / 2);
    if (span <= opt.maxGap) {
      assert(visible(g.idx, mid), 'celah pendek di landmark ' + g.idx + ' tidak terisi');
    } else {
      assert(!visible(g.idx, mid),
        'celah ' + span + ' frame di landmark ' + g.idx +
        ' diisi, padahal maxGap cuma ' + opt.maxGap);
    }
  });
});

test('mengisi celah mengurangi tulang yang ditahan', function () {
  // "Ditahan" artinya anggota badan membeku di layar lalu menyentak.
  // Itu cacat yang paling kelihatan dari seluruh pipeline ini.
  var before = P.build(noisy, {}).stats.bonesHeld;
  var after = P.build(refined.frames, {}).stats.bonesHeld;
  info('tulang ditahan: ' + before + ' → ' + after);
  assert(after < before, 'tulang yang ditahan tidak berkurang: ' + before + ' → ' + after);
});

section('Sifat yang harus dijaga');

test('masukannya tidak diubah', function () {
  // Pemanggil memakai frame mentah untuk statistik "sebelum". Kalau
  // refine mengubah masukannya, perbandingan sebelum/sesudah di mana
  // pun — termasuk di test ini — jadi bohong.
  var fresh = corrupt(truth);
  var snapshot = JSON.stringify(fresh);
  R.refine(fresh, {});
  assert(JSON.stringify(fresh) === snapshot, 'frame masukan ikut berubah');
});

test('sinyal kuadratik lolos tanpa diubah', function () {
  // Sifat Savitzky-Golay: pencocokan kuadratik mengembalikan parabola
  // apa adanya. Kalau solvernya rusak, test ini yang menangkapnya —
  // bukan asersi error di atas, yang masih lolos dengan filter apa pun
  // yang kebetulan menghaluskan.
  var n = 21;
  var vals = [], w = [];
  for (var i = 0; i < n; i++) { vals.push(3 + 0.5 * i - 0.02 * i * i); w.push(1); }
  var S = R._internal.smoothSeries;
  S.window = 7;
  var out = S(vals, w);
  var worst = 0;
  for (var k = 0; k < n; k++) worst = Math.max(worst, Math.abs(out[k] - vals[k]));
  info('simpangan terbesar dari parabola: ' + worst.toExponential(2));
  assert(worst < 1e-9, 'parabola ikut terpangkas: simpangan ' + worst);
});

test('hasil penghalusan tidak pernah keluar dari rentang sampelnya', function () {
  // Di tepi array dan tepi celah, jendelanya cuma punya sampel di satu
  // sisi. Kuadratik yang dipasang ke data begitu meneruskan parabola ke
  // luar rentangnya, dan parabola yang diteruskan bisa melesat jauh.
  // Pengurungan ke [min, max] sampel membuat itu tidak mungkin.
  var S = R._internal.smoothSeries;
  S.window = 7;

  // Tiga bentuk yang memang membuat kuadratik melesat. Yang pertama
  // paling penting dan paling nyata: TANGGA. Sendi yang berhenti
  // mendadak — tangan menyentuh lantai, kaki menapak — adalah tangga,
  // dan tanpa pengurungan hasilnya melesat sekitar sepersepuluh tinggi
  // tangganya tepat di sisinya.
  var shapes = {
    'tangga': function (i) { return i < 12 ? 0 : 1; },
    'kubik': function (i) { return Math.pow(i, 3) * 0.01; },
    'cusp': function (i) { return Math.abs(i - 12); }
  };
  var masks = {
    'penuh': function () { return 1; },
    'separuh hilang': function (i) { return i < 12 ? 1 : 0; },
    'celah di tengah': function (i) { return (i >= 12 && i <= 18) ? 0 : 1; }
  };
  var n = 30, half = (S.window - 1) >> 1, checked = 0;

  Object.keys(shapes).forEach(function (sn) {
    Object.keys(masks).forEach(function (mn) {
      var vals = [], w = [];
      for (var i = 0; i < n; i++) { vals.push(shapes[sn](i)); w.push(masks[mn](i)); }
      var out = S(vals, w);
      for (var k = 0; k < n; k++) {
        if (!(w[k] > 0)) continue;
        var lo = Infinity, hi = -Infinity;
        for (var j = Math.max(0, k - half); j <= Math.min(n - 1, k + half); j++) {
          if (!(w[j] > 0)) continue;
          lo = Math.min(lo, vals[j]); hi = Math.max(hi, vals[j]);
        }
        assert(out[k] >= lo - 1e-9 && out[k] <= hi + 1e-9,
          sn + ' / ' + mn + ' frame ' + k + ': ' + out[k].toFixed(4) +
          ' di luar [' + lo.toFixed(4) + ', ' + hi.toFixed(4) + ']');
        checked++;
      }
    });
  });
  info(checked + ' titik diperiksa di 3 bentuk × 3 pola celah');
});

test('frame tanpa pose tidak membuatnya jatuh', function () {
  var broken = [
    { time: 0, landmarks: null },
    { time: 0.1, landmarks: [] },
    { time: 0.2, landmarks: toLandmarks(truthFrame(0)) },
    { time: 0.3, landmarks: null }
  ];
  var out = R.refine(broken, {});
  assert(out && out.frames.length === 4, 'jumlah frame berubah');
  assert(out.frames[0].landmarks === null, 'frame kosong ikut dikarang');
});

test('daftar frame kosong menghasilkan hasil kosong', function () {
  assert(R.refine([], {}).frames.length === 0, 'frame kosong tidak kosong');
  assert(R.refine(null, {}).frames.length === 0, 'null tidak kosong');
});

test('tiap tahap bisa dimatikan sendiri-sendiri', function () {
  var off = R.refine(noisy, { gapFill: false, smooth: false });
  assert(off.stats.gapsFilled === 0, 'gapFill tetap jalan saat dimatikan');
  assert(off.stats.smoothed === 0, 'smooth tetap jalan saat dimatikan');
  var same = positionError(off.frames, truth) === positionError(noisy, truth);
  assert(same, 'semua tahap mati tapi hasilnya tetap berubah');
});

test('opsi asing tidak menyelinap masuk', function () {
  var o = R.resolveOptions({ window: 4, kutuBusuk: 1 });
  assert(o.window === 5, 'jendela genap tidak dinaikkan jadi ganjil: ' + o.window);
  assert(o.kutuBusuk === undefined, 'opsi asing ikut diterima');
});

test('lebar jendela dihitung dari laju sampling kalau diketahui', function () {
  // Tangkapan 12 fps dan 30 fps harus dihaluskan sekuat yang sama dalam
  // satuan WAKTU, bukan dalam jumlah frame.
  assert(R.resolveOptions({ sampleFps: 24 }).window === 7, 'pada 24 fps bukan 7');
  assert(R.resolveOptions({ sampleFps: 12 }).window === 3, 'pada 12 fps bukan 3');
  assert(R.resolveOptions({ sampleFps: 60 }).window === 9, 'pada 60 fps tidak dibatasi 9');
});

section('Penghalusan tidak boleh memakan gerakan sebenarnya');

test('gerakan secepat lambaian tangan lolos hampir utuh', function () {
  // Risiko modul ini bukan cuma "kurang halus", tapi "terlalu halus":
  // jendela yang terlalu lebar membuat gerakan jadi lemas, dan tidak
  // ada satu pun asersi error di atas yang menangkapnya — menghaluskan
  // sinyal bersih sampai rata tetap menurunkan error terhadap acuan
  // yang juga ikut halus.
  //
  // Jadi yang diukur di sini amplitudo, pada sinyal TANPA derau.
  var S = R._internal.smoothSeries;
  var opt = R.resolveOptions({});
  S.window = opt.window;

  function retention(periodFrames) {
    var n = 200, vals = [], w = [];
    for (var i = 0; i < n; i++) { vals.push(Math.sin(2 * Math.PI * i / periodFrames)); w.push(1); }
    var out = S(vals, w);
    var amp = 0;
    for (var k = 30; k < n - 30; k++) amp = Math.max(amp, Math.abs(out[k]));
    return amp;
  }

  // Pada 24 fps: 12 frame per siklus = 2 Hz, 8 frame = 3 Hz.
  var slow = retention(12), fast = retention(8);
  info('retensi amplitudo: 2 Hz ' + (slow * 100).toFixed(0) +
       '%, 3 Hz ' + (fast * 100).toFixed(0) + '% (jendela ' + opt.window + ')');
  assert(slow > 0.9, 'gerakan 2 Hz terpangkas jadi ' + (slow * 100).toFixed(0) + '%');
  assert(fast > 0.8, 'gerakan 3 Hz terpangkas jadi ' + (fast * 100).toFixed(0) + '%');
});

/* ------------------------------------------------------------------ *
 * Keluaran detektor yang sungguhan
 * ------------------------------------------------------------------ *
 * Bagian ini yang paling penting di berkas ini, dan satu-satunya yang
 * pernah menangkap kesalahan nyata.
 *
 * Tidak ada kebenaran acuan di sini — tidak ada yang tahu di mana sendi
 * orang itu sebenarnya. Jadi yang diukur bukan error, melainkan
 * SENTAKAN: lonjakan sudut tulang antar frame. Gerakan manusia pada
 * 24 fps jarang melewati 20 derajat per frame, jadi lonjakan di atas
 * itu hampir selalu cacat deteksi, bukan gerakan. Dan yang penting,
 * sentakan yang MUNCUL setelah dibereskan pasti dikarang oleh modul
 * ini — tidak ada sumber lain yang bisa membuatnya.
 */

section('Keluaran detektor yang sungguhan');

var fixture = (function () {
  var fs = require('fs');
  var file = path.join(__dirname, 'fixtures', 'pose-prostration.json');
  var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    fps: raw.fps,
    frames: raw.frames.map(function (f) {
      return {
        time: f.t,
        landmarks: f.l.map(function (p) {
          if (p === 0) return { x: 0, y: 0, z: 0, visibility: 0 };
          return { x: p[0], y: p[1], z: p[2], visibility: p[3] };
        })
      };
    })
  };
})();

/** Sentakan: lonjakan sudut tulang antar frame, dalam derajat. */
function jerk(frames) {
  var built = P.build(frames, {});
  var worst = 0, sum = 0, count = 0, big = 0;
  built.tracks.forEach(function (t) {
    if (t.type !== 'quaternion') return;
    var n = t.values.length / 4;
    for (var i = 1; i < n; i++) {
      var d = 0;
      for (var k = 0; k < 4; k++) d += t.values[(i - 1) * 4 + k] * t.values[i * 4 + k];
      d = Math.min(1, Math.abs(d));
      var deg = 2 * Math.acos(d) * 180 / Math.PI;
      if (deg > worst) worst = deg;
      if (deg > 20) big++;
      sum += deg; count++;
    }
  });
  return { max: worst, mean: count ? sum / count : 0, big: big };
}

test('fixture-nya memang potongan yang sulit', function () {
  var s = R.boneLengthSpread(fixture.frames, R.resolveOptions({}));
  info(fixture.frames.length + ' frame pada ' + fixture.fps +
       ' fps, sebaran panjang tulang ' + s.mean.toFixed(1) +
       '% (rata-rata), ' + s.max.toFixed(0) + '% (maks)');
  // Kalau fixture-nya gampang, dia tidak menjaga apa pun. Sebaran 10
  // persen artinya detektornya benar-benar meringkus anggota badan di
  // sini — itu yang harus ada.
  assert(s.mean > 5, 'fixture terlalu mudah: sebaran cuma ' + s.mean.toFixed(1) + '%');
});

test('sentakan pada data sungguhan turun, bukan naik', function () {
  var before = jerk(fixture.frames);
  var after = jerk(R.refine(fixture.frames, { sampleFps: fixture.fps }).frames);
  info('sentakan rata-rata: ' + before.mean.toFixed(2) + '°/frame → ' +
       after.mean.toFixed(2) + '°/frame');
  info('frame di atas 20°  : ' + before.big + ' → ' + after.big);
  info('lonjakan terburuk  : ' + before.max.toFixed(0) + '° → ' + after.max.toFixed(0) + '°');
  assert(after.mean < before.mean, 'sentakan rata-rata naik: ' +
    before.mean.toFixed(2) + '° → ' + after.mean.toFixed(2) + '°');
  assert(after.big < before.big, 'frame menyentak bertambah: ' +
    before.big + ' → ' + after.big);
  assert(after.max <= before.max + 1, 'lonjakan terburuk bertambah: ' +
    before.max.toFixed(0) + '° → ' + after.max.toFixed(0) + '°');
});

test('tidak ada tulang yang jadi lebih menyentak dari sebelumnya', function () {
  // Rata-rata bisa menipu: satu tulang boleh saja meledak sementara
  // empat belas lainnya membaik, dan jumlahnya masih terlihat turun.
  // Tahap yang dibuang dulu ketahuan tepat di sini — tulang ujung dan
  // lengan bawah yang meledak, bukan rata-ratanya.
  function perBone(frames) {
    var built = P.build(frames, {});
    var out = {};
    built.tracks.forEach(function (t) {
      if (t.type !== 'quaternion') return;
      var n = t.values.length / 4, worst = 0;
      for (var i = 1; i < n; i++) {
        var d = 0;
        for (var k = 0; k < 4; k++) d += t.values[(i - 1) * 4 + k] * t.values[i * 4 + k];
        d = Math.min(1, Math.abs(d));
        var deg = 2 * Math.acos(d) * 180 / Math.PI;
        if (deg > worst) worst = deg;
      }
      out[t.name.replace('.quaternion', '')] = worst;
    });
    return out;
  }
  var a = perBone(fixture.frames);
  var b = perBone(R.refine(fixture.frames, { sampleFps: fixture.fps }).frames);
  var worse = [];
  Object.keys(a).forEach(function (k) {
    if (b[k] > a[k] + 10) worse.push(k + ' ' + a[k].toFixed(0) + '°→' + b[k].toFixed(0) + '°');
  });
  info('tulang yang membaik: ' + Object.keys(a).filter(function (k) {
    return b[k] < a[k] - 1;
  }).length + ' dari ' + Object.keys(a).length);
  assert(worse.length === 0, 'tulang jadi lebih menyentak: ' + worse.join(', '));
});

test('celah yang terlalu panjang untuk dijembatani tidak mengarang gerakan', function () {
  // Jalur yang TIDAK diuji oleh fixture apa adanya, dan karena itu
  // hampir luput: celah yang lebih panjang dari batas penjembatanan.
  // Celah seperti itu pasti muncul di video lain — orang keluar frame,
  // tangan masuk ke balik badan beberapa detik — dan di situlah
  // jendela penghalusan jadi berat sebelah.
  //
  // Jendela yang berat sebelah menggeser fase, dan pergeseran itu
  // sendiri jadi sentakan di frame saat sendinya muncul kembali.
  // Versi sebelumnya memotong jendela di tepi celah lalu memasang
  // kuadratik ke apa pun yang tersisa; hasilnya ekstrapolasi, dan
  // parabola yang diteruskan ke luar rentangnya melewati batas
  // jauh-jauh.
  var opt = R.resolveOptions({ sampleFps: fixture.fps });
  var blind = fixture.frames.map(function (f) {
    return { time: f.time, landmarks: f.landmarks.map(function (p) {
      return { x: p.x, y: p.y, z: p.z, visibility: p.visibility };
    }) };
  });
  var span = opt.maxGap * 2;        // dua kali lebih panjang dari yang bisa dijembatani
  var start = 20;
  for (var i = start; i < start + span && i < blind.length; i++) {
    blind[i].landmarks[R.LM.leftElbow].visibility = 0.05;
    blind[i].landmarks[R.LM.leftWrist].visibility = 0.05;
  }

  function perBone(frames) {
    var built = P.build(frames, {});
    var out = {};
    built.tracks.forEach(function (t) {
      if (t.type !== 'quaternion') return;
      var n = t.values.length / 4, worst = 0;
      for (var k2 = 1; k2 < n; k2++) {
        var d = 0;
        for (var k = 0; k < 4; k++) d += t.values[(k2 - 1) * 4 + k] * t.values[k2 * 4 + k];
        d = Math.min(1, Math.abs(d));
        var deg = 2 * Math.acos(d) * 180 / Math.PI;
        if (deg > worst) worst = deg;
      }
      out[t.name.replace('.quaternion', '')] = worst;
    });
    return out;
  }

  var a = perBone(blind);
  var b = perBone(R.refine(blind, { sampleFps: fixture.fps }).frames);
  var worse = [];
  Object.keys(a).forEach(function (k) {
    if (b[k] > a[k] + 10) worse.push(k + ' ' + a[k].toFixed(0) + '°→' + b[k].toFixed(0) + '°');
  });
  info('celah buatan ' + span + ' frame pada siku dan pergelangan kiri');
  assert(worse.length === 0, 'tulang jadi lebih menyentak: ' + worse.join(', '));
});

console.log('');
if (failed === 0) {
  console.log('✅ ' + passed + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + passed + ' passed, ' + failed + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
