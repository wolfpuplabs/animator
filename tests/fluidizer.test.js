/*
 * Test untuk engine MFS. Tanpa dependency — jalankan: node tests/fluidizer.test.js
 */
'use strict';

var F = require('../js/fluidizer.js');
var I = F._internal;

var passed = 0, failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push(name + ': ' + err.message);
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error((msg || 'value mismatch') + ' — expected ' + expected + ', got ' + actual);
  }
}

function grid(duration, fps) {
  var n = Math.round(duration * fps) + 1;
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) out[i] = Math.min(i * duration / (n - 1), duration);
  return out;
}

function quatFromAxisAngle(x, y, z, angle) {
  var h = angle / 2, s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

console.log('\nReconstruct (Hermite / Squad)');

test('interpolasi tepat melewati setiap keyframe asli', function () {
  var times = [0, 0.4, 0.9, 1.5];
  var values = [0, 0, 0,  1, 2, 0,  -1, 0.5, 3,  2, 2, 2];
  var out = I.resampleNumeric(times, values, 3, 4, new Float64Array(times), true);
  for (var i = 0; i < times.length; i++) {
    for (var c = 0; c < 3; c++) {
      assertClose(out[i * 3 + c], values[i * 3 + c], 1e-9, 'key ' + i + ' comp ' + c);
    }
  }
});

test('hold tetap diam — tidak ada wobble di segmen konstan', function () {
  // Naik, lalu ditahan 3 key, lalu naik lagi. Catmull-Rom polos akan
  // melengkung keluar di area hold; limiter monotonik harus mencegahnya.
  var times = [0, 0.5, 1.0, 1.5, 2.0];
  var values = [0, 5, 5, 5, 10];
  var g = grid(2.0, 120);
  var out = I.resampleNumeric(times, values, 1, 5, g, true);
  for (var i = 0; i < g.length; i++) {
    if (g[i] >= 0.5 && g[i] <= 1.5) {
      assertClose(out[i], 5, 1e-6, 'hold di t=' + g[i].toFixed(3));
    }
  }
});

test('tidak overshoot pada ramp monotonik', function () {
  var times = [0, 1, 2, 3];
  var values = [0, 1, 2, 10];
  var g = grid(3, 240);
  var out = I.resampleNumeric(times, values, 1, 4, g, true);
  for (var i = 0; i < out.length; i++) {
    assert(out[i] >= -1e-9 && out[i] <= 10 + 1e-9, 'keluar rentang: ' + out[i]);
  }
});

test('resample menghasilkan jumlah sample sesuai target fps', function () {
  var clip = {
    duration: 2,
    tracks: [{ name: '.position', type: 'vector', times: [0, 1, 2], values: [0,0,0, 1,1,1, 0,0,0] }]
  };
  var res = F.enhance(clip, { fps: 60, smoothing: 0, followThrough: 0, reduction: 0 });
  assert(res.stats.sampleCount === 121, 'expected 121 samples, got ' + res.stats.sampleCount);
  assert(res.tracks[0].times.length === 121, 'track keys: ' + res.tracks[0].times.length);
});

console.log('\nQuaternion');

test('hemisphere alignment menyelaraskan seluruh rantai key', function () {
  // Setelah key 1 dibalik, key 2 sudah sejajar dengannya — jadi cuma 1 flip.
  var q = [0, 0, 0, 1,  0, 0, 0, -1,  0, 0, 0, 1];
  var flips = I.alignHemisphere(q, 3);
  assert(flips === 1, 'expected 1 flip, got ' + flips);
  assert(q[7] > 0, 'key 1 harus dibalik');
  for (var i = 1; i < 3; i++) {
    var dot = q[i*4]*q[(i-1)*4] + q[i*4+1]*q[(i-1)*4+1] +
              q[i*4+2]*q[(i-1)*4+2] + q[i*4+3]*q[(i-1)*4+3];
    assert(dot >= 0, 'key ' + i + ' masih menyeberang hemisphere');
  }
});

test('hemisphere alignment membalik setiap key yang berlawanan', function () {
  var q = [0, 0, 0, 1,  0, 0, 0, -1,  0, 0, 0, -1];
  var flips = I.alignHemisphere(q, 3);
  assert(flips === 2, 'expected 2 flips, got ' + flips);
});

test('hasil squad selalu unit quaternion', function () {
  var a = quatFromAxisAngle(0, 1, 0, 0);
  var b = quatFromAxisAngle(0, 1, 0, Math.PI * 0.6);
  var c = quatFromAxisAngle(1, 0, 0, Math.PI * 0.4);
  var times = [0, 0.5, 1];
  var values = a.concat(b, c);
  var g = grid(1, 120);
  var out = I.resampleQuaternion(times, values, 3, g);
  for (var i = 0; i < g.length; i++) {
    var l = Math.hypot(out[i*4], out[i*4+1], out[i*4+2], out[i*4+3]);
    assertClose(l, 1, 1e-6, 'norm sample ' + i);
  }
});

test('squad melewati keyframe rotasi asli', function () {
  var times = [0, 0.5, 1];
  var values = quatFromAxisAngle(0,1,0,0)
    .concat(quatFromAxisAngle(0,1,0,1.0), quatFromAxisAngle(0,1,0,2.0));
  var out = I.resampleQuaternion(times, values, 3, new Float64Array(times));
  for (var i = 0; i < 3; i++) {
    assertClose(I.qAngle(out, i*4, values, i*4), 0, 1e-6, 'key ' + i);
  }
});

test('rotasi yang flip tidak mengambil jalan memutar', function () {
  // dua key identik secara rotasi tapi tanda berlawanan: lerp naif akan
  // melewati seluruh bola (sudut besar di tengah), hasil kita harus ~0.
  var q0 = quatFromAxisAngle(0, 1, 0, 2.8);
  var q1 = q0.map(function (v) { return -v; });
  var values = q0.concat(q1);
  I.alignHemisphere(values, 2);
  var g = grid(1, 30);
  var out = I.resampleQuaternion([0, 1], values, 2, g);
  for (var i = 0; i < g.length; i++) {
    assertClose(I.qAngle(out, i*4, values, 0), 0, 1e-5, 'sample ' + i + ' menyimpang');
  }
});

test('exp(log(q)) mengembalikan q', function () {
  var q = quatFromAxisAngle(0.267, 0.535, 0.802, 1.7);
  var v = I.qLog(q, 0, [0,0,0]);
  var back = [0,0,0,0];
  I.qExp(v, back, 0);
  assertClose(I.qAngle(back, 0, q, 0), 0, 1e-9, 'roundtrip');
});

console.log('\nDenoise & dynamics');

test('bilateral menurunkan jitter pada sinyal ber-noise', function () {
  var n = 300, stride = 1;
  var sig = new Float64Array(n);
  var seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }
  for (var i = 0; i < n; i++) sig[i] = Math.sin(i * 0.05) + rnd() * 0.08;
  var before = I.jerkMetric(sig, n, stride, false);
  var after = I.jerkMetric(I.bilateralNumeric(sig, n, stride, 3, 0.4, null), n, stride, false);
  assert(after < before * 0.6, 'jitter tidak turun cukup: ' + before + ' -> ' + after);
});

test('bilateral mempertahankan step besar (snap tidak lumer)', function () {
  var n = 200;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i < 100 ? 0 : 10;
  var out = I.bilateralNumeric(sig, n, 1, 3, 0.5, null);
  assert(Math.abs(out[99] - 0) < 0.6, 'sisi bawah step ikut tertarik: ' + out[99]);
  assert(Math.abs(out[100] - 10) < 0.6, 'sisi atas step ikut tertarik: ' + out[100]);
});

test('motion mask mendekati nol saat kurva diam', function () {
  var times = [0, 0.5, 1.0, 1.5];
  var values = [0, 0, 0, 5]; // diam sampai 1.0 lalu bergerak
  var g = grid(1.5, 60);
  var mask = I.buildMotionMask(times, values, 1, 4, false, g, 0.5);
  var idxHold = Math.round(0.25 * 60);
  var idxMove = Math.round(1.25 * 60);
  assert(mask[idxHold] < 0.1, 'mask saat hold seharusnya rendah: ' + mask[idxHold]);
  assert(mask[idxMove] > 0.8, 'mask saat gerak seharusnya tinggi: ' + mask[idxMove]);
});

test('second-order dynamics stabil dan konvergen ke target', function () {
  var n = 400, dt = 1 / 60;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i < 50 ? 0 : 1;
  var out = I.dynamicsNumeric(sig, n, 1, dt, 3, 0.5, 1, 1, null, false);
  for (var k = 0; k < n; k++) assert(isFinite(out[k]), 'NaN/Inf pada sample ' + k);
  assertClose(out[n - 1], 1, 0.02, 'tidak konvergen ke target');
  var peak = 0;
  for (var p = 0; p < n; p++) peak = Math.max(peak, out[p]);
  assert(peak > 1.02, 'tidak ada overshoot sama sekali (peak ' + peak + ')');
  assert(peak < 1.8, 'overshoot liar: ' + peak);
});

test('dynamics quaternion tetap unit dan tidak meledak', function () {
  var n = 300, dt = 1 / 60;
  var sig = new Float64Array(n * 4);
  for (var i = 0; i < n; i++) {
    var ang = i < 60 ? 0 : 1.2;
    var q = quatFromAxisAngle(0, 1, 0, ang);
    for (var c = 0; c < 4; c++) sig[i * 4 + c] = q[c];
  }
  var out = I.dynamicsQuaternion(sig, n, dt, 3, 0.5, 1, 1, null, false);
  for (var k = 0; k < n; k++) {
    var l = Math.hypot(out[k*4], out[k*4+1], out[k*4+2], out[k*4+3]);
    assert(isFinite(l), 'NaN pada sample ' + k);
    assertClose(l, 1, 1e-6, 'norm sample ' + k);
  }
  assertClose(I.qAngle(out, (n-1)*4, sig, (n-1)*4), 0, 0.05, 'tidak konvergen ke orientasi target');
});

test('isCyclic membedakan kurva menyambung dan kurva satu arah', function () {
  var n = 120;
  var cyc = new Float64Array(n), ramp = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    cyc[i] = Math.sin(i / (n - 1) * Math.PI * 2);
    ramp[i] = i;
  }
  assert(I.isCyclic(cyc, n, 1, false), 'sinus penuh seharusnya cyclic');
  assert(!I.isCyclic(ramp, n, 1, false), 'ramp seharusnya bukan cyclic');

  // rotasi yang terus berputar satu arah: bukan cyclic
  var q = new Float64Array(n * 4);
  for (var k = 0; k < n; k++) {
    var a = k / (n - 1) * 3.8, s = Math.sin(a / 2);
    q[k*4] = 0; q[k*4+1] = s; q[k*4+2] = 0; q[k*4+3] = Math.cos(a / 2);
  }
  assert(!I.isCyclic(q, n, 4, true), 'rotasi berputar terus seharusnya bukan cyclic');
});

test('pre-roll tidak merusak kurva yang tidak menyambung (regresi)', function () {
  // Bug nyata: dengan loop=true pada kurva satu arah, pass kedua pegas
  // mulai dari ujung sementara targetnya di pangkal -> osilasi liar.
  var n = 240, dt = 1 / 60;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i * 0.05; // ramp, jelas tidak loop

  var withLoop = I.dynamicsNumeric(sig, n, 1, dt, 3, 0.5, 1, 1, null, true);
  var noLoop = I.dynamicsNumeric(sig, n, 1, dt, 3, 0.5, 1, 1, null, false);

  for (var k = 0; k < n; k++) {
    assertClose(withLoop[k], noLoop[k], 1e-9, 'pre-roll aktif padahal kurva tidak cyclic');
  }
  assert(I.jerkMetric(withLoop, n, 1, false) < 0.05,
    'kurva jadi bergetar: ' + I.jerkMetric(withLoop, n, 1, false));
});

test('kurva yang sudah mulus tidak dirusak oleh rekonstruksi + denoise', function () {
  // Rotasi konstan satu arah: sudah sempurna, tidak ada yang bisa
  // diperbaiki. Alat ini minimal tidak boleh memperburuknya.
  var times = [], values = [];
  for (var i = 0; i <= 16; i++) {
    var t = i / 8;
    var a = t * 1.6, s = Math.sin(a / 2);
    times.push(t);
    values.push(0, s, 0, Math.cos(a / 2));
  }
  var clip = { duration: 2, tracks: [{ name: '.quaternion', type: 'quaternion',
    times: times, values: values }] };

  var res = F.enhance(clip, { preset: 'quality', loop: true });
  assert(res.stats.reconstructionGain > -0.03,
    'rekonstruksi memperburuk kurva bersih: ' + res.stats.reconstructionGain.toFixed(3));

  // Tanpa follow-through, hasil akhirnya juga tidak boleh memburuk.
  var plain = F.enhance(clip, { preset: 'quality', loop: true, followThrough: 0 });
  assert(plain.stats.smoothnessGain > -0.03,
    'tanpa overshoot pun memburuk: ' + plain.stats.smoothnessGain.toFixed(3));

  // Rotasi berkecepatan tetap tidak punya belokan, jadi follow-through
  // tidak punya apa pun untuk di-overshoot: hasilnya harus netral juga.
  assertClose(res.stats.smoothnessGain, 0, 0.03,
    'follow-through mengubah kurva berkecepatan tetap');
});

test('stats memisahkan overshoot yang disengaja dari kualitas rekonstruksi', function () {
  // Kurva dengan banyak belokan: di sinilah follow-through benar-benar
  // menambah percepatan, dan angkanya harus terbaca terpisah.
  var times = [], values = [];
  for (var i = 0; i <= 16; i++) {
    var t = i / 8;
    times.push(t);
    values.push(Math.sin(t * 5) * 2, Math.cos(t * 4), 0);
  }
  var clip = { duration: 2, tracks: [{ name: '.position', type: 'vector',
    times: times, values: values }] };

  var withFt = F.enhance(clip, { preset: 'quality', followThrough: 0.8 });
  var noFt = F.enhance(clip, { preset: 'quality', followThrough: 0 });

  assert(withFt.stats.overshootDelta < -0.02,
    'kontribusi overshoot tidak terukur: ' + withFt.stats.overshootDelta.toFixed(3));
  assertClose(noFt.stats.overshootDelta, 0, 1e-9,
    'tanpa follow-through seharusnya nol persis');

  // reconstructionGain diukur pada tahap yang sama untuk kedua jalur,
  // jadi keduanya harus cocok — follow-through tidak boleh mengubah
  // kualitas rekonstruksi, hanya menambah overshoot sesudahnya.
  assertClose(withFt.stats.reconstructionGain, noFt.stats.reconstructionGain, 1e-9,
    'follow-through bocor ke tahap rekonstruksi');
  assert(withFt.stats.followThrough === 0.8, 'setelan follow-through tidak dilaporkan');
});

test('filter tidak menggeser frame pertama dan terakhir', function () {
  // Bug nyata: window yang dijepit di tepi menarik frame awal/akhir ke
  // nilai ujungnya, bikin pop di frame 0 dan di titik loop.
  var n = 181;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(i / (n - 1) * 4);
  var out = I.bilateralNumeric(sig, n, 1, 2.7, 0.5, null, false);
  assertClose(out[0], sig[0], 1e-12, 'frame pertama bergeser');
  assertClose(out[n - 1], sig[n - 1], 1e-12, 'frame terakhir bergeser');
  assert(Math.abs(out[1] - sig[1]) < 1e-3, 'frame kedua bergeser jauh');
});

test('kurva menyambung difilter melingkar (tanpa jahitan di titik loop)', function () {
  var n = 200;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(i / n * Math.PI * 2);
  var wrapped = I.bilateralNumeric(sig, n, 1, 2.5, 0, null, true);
  // sinus murni: filter melingkar hanya menyusutkan amplitudo secara
  // seragam, jadi nilai di titik jahitan tetap menyambung mulus
  var seam = Math.abs((wrapped[0] - wrapped[n - 1]) - (sig[0] - sig[n - 1]));
  assert(seam < 1e-3, 'ada jahitan di titik loop: ' + seam);
});

test('dinamika tidak menunda animasi (lag nol pada kecepatan tetap)', function () {
  // Dua hal sekaligus: kecepatan awal diambil dari input (bukan nol), dan
  // r = 2 membuat lag steady-state hilang. Kalau salah satu meleset,
  // seluruh animasi bergeser mundur beberapa frame.
  var n = 240, dt = 1 / 60, speed = 2;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i * dt * speed;
  var out = I.dynamicsNumeric(sig, n, 1, dt, 3, 0.7, 2, 1, null, false);

  for (var k = 0; k < n; k++) {
    var lagFrames = Math.abs(out[k] - sig[k]) / (speed * dt);
    assert(lagFrames < 0.1, 'lag ' + lagFrames.toFixed(2) + ' frame di sample ' + k);
  }
});

test('overshoot tetap wajar pada input step mendadak', function () {
  var n = 240, dt = 1 / 60;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i < 50 ? 0 : 1;
  var out = I.dynamicsNumeric(sig, n, 1, dt, 3, 0.5, 2, 1, null, false);
  var peak = 0, low = 0;
  for (var k = 0; k < n; k++) { peak = Math.max(peak, out[k]); low = Math.min(low, out[k]); }
  assert(peak > 1.02, 'tidak ada follow-through: ' + peak.toFixed(3));
  assert(peak < 1.6, 'overshoot berlebihan: ' + peak.toFixed(3));
  assert(low > -0.05, 'ada antisipasi mundur yang tidak diinginkan: ' + low.toFixed(3));
  assertClose(out[n - 1], 1, 0.02, 'tidak kembali ke target');
});

console.log('\nCompact');

test('decimation membuang key redundan pada garis lurus', function () {
  var n = 200;
  var times = new Float64Array(n), values = new Float64Array(n);
  for (var i = 0; i < n; i++) { times[i] = i / 100; values[i] = i * 0.5; }
  var res = I.decimate(times, values, 1, n, 0.001, false);
  assert(res.times.length <= 3, 'garis lurus harusnya jadi 2-3 key, dapat ' + res.times.length);
});

test('decimation menjaga error di bawah toleransi', function () {
  var n = 400, tol = 0.01;
  var times = new Float64Array(n), values = new Float64Array(n);
  for (var i = 0; i < n; i++) { times[i] = i / 120; values[i] = Math.sin(i * 0.04) * 3; }
  var res = I.decimate(times, values, 1, n, tol, false);
  assert(res.times.length < n, 'tidak ada key yang dibuang');

  // rekonstruksi linear dari hasil decimation harus dekat dengan aslinya
  var seg = 0;
  for (var k = 0; k < n; k++) {
    while (seg < res.times.length - 2 && times[k] >= res.times[seg + 1]) seg++;
    var t0 = res.times[seg], t1 = res.times[seg + 1];
    var u = (times[k] - t0) / Math.max(t1 - t0, 1e-9);
    u = Math.max(0, Math.min(1, u));
    var pred = res.values[seg] + (res.values[seg + 1] - res.values[seg]) * u;
    assert(Math.abs(pred - values[k]) <= tol * 1.5, 'error ' + Math.abs(pred - values[k]) + ' di k=' + k);
  }
});

test('reduction=0 mempertahankan semua sample', function () {
  var clip = {
    duration: 1,
    tracks: [{ name: '.position', type: 'vector', times: [0, 0.5, 1], values: [0,0,0, 1,3,0, 0,0,0] }]
  };
  var res = F.enhance(clip, { fps: 60, reduction: 0 });
  assert(res.tracks[0].times.length === res.stats.sampleCount, 'key dipangkas padahal reduction=0');
});

console.log('\nPipeline end-to-end');

test('animasi stepped 8fps jadi lebih halus (jitter turun)', function () {
  // Simulasikan animasi "patah": step 8fps dengan sedikit noise.
  var times = [], values = [];
  var seed = 99;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }
  for (var i = 0; i <= 16; i++) {
    var t = i / 8;
    times.push(t);
    values.push(Math.sin(t * 3) + rnd() * 0.05, Math.abs(Math.sin(t * 6)) * 2 + rnd() * 0.05, 0);
  }
  var res = F.enhance({ duration: 2, tracks: [{ name: '.position', type: 'vector', times: times, values: values }] },
                      { preset: 'quality' });
  assert(res.stats.smoothnessGain > 0.3,
    'smoothnessGain hanya ' + res.stats.smoothnessGain.toFixed(3));
});

test('reduction menukar jumlah keyframe dengan kehalusan (terdokumentasi)', function () {
  // Ini trade-off yang disengaja, bukan bug: tiap key yang dibuang
  // mengembalikan sedikit sudut karena playback menginterpolasi linear.
  var times = [], values = [];
  for (var i = 0; i <= 16; i++) {
    var t = i / 8;
    times.push(t);
    values.push(Math.sin(t * 3), Math.abs(Math.sin(t * 6)) * 2, 0);
  }
  var clip = { duration: 2, tracks: [{ name: '.position', type: 'vector', times: times, values: values }] };
  var low = F.enhance(clip, { preset: 'quality', reduction: 0.0 });
  var high = F.enhance(clip, { preset: 'quality', reduction: 0.5 });

  assert(high.tracks[0].times.length < low.tracks[0].times.length,
    'reduction tinggi tidak memangkas key');
  assert(high.stats.smoothnessGain < low.stats.smoothnessGain,
    'stats tidak melaporkan biaya kehalusan dari reduction');
  assert(high.stats.weight < low.stats.weight, 'ukuran tidak ikut turun');
});

test('track bool/string disalin apa adanya', function () {
  var clip = {
    duration: 1,
    tracks: [
      { name: '.visible', type: 'bool', times: [0, 0.5], values: [true, false] },
      { name: '.material.name', type: 'string', times: [0], values: ['a'] }
    ]
  };
  var res = F.enhance(clip, { preset: 'ultra' });
  assert(res.tracks[0].values[0] === true && res.tracks[0].values[1] === false, 'bool berubah');
  assert(res.tracks[1].values[0] === 'a', 'string berubah');
  assert(res.stats.tracksCopied === 2, 'tracksCopied=' + res.stats.tracksCopied);
});

test('morph target (number, stride > 1) tetap utuh stride-nya', function () {
  var clip = {
    duration: 1,
    tracks: [{ name: '.morphTargetInfluences', type: 'number',
               times: [0, 0.5, 1], values: [0,0, 1,0.5, 0,1] }]
  };
  var res = F.enhance(clip, { fps: 30, reduction: 0 });
  var t = res.tracks[0];
  assert(t.values.length === t.times.length * 2, 'stride rusak: ' +
    t.values.length + ' vs ' + t.times.length * 2);
});

test('durasi dan nama track dipertahankan', function () {
  var clip = {
    name: 'walk', duration: 1.6,
    tracks: [{ name: 'Hips.quaternion', type: 'quaternion', times: [0, 0.8, 1.6],
               values: quatFromAxisAngle(0,1,0,0).concat(quatFromAxisAngle(0,1,0,0.7), quatFromAxisAngle(0,1,0,0)) }]
  };
  var res = F.enhance(clip, { preset: 'balanced' });
  assertClose(res.duration, 1.6, 1e-9, 'durasi berubah');
  assert(res.tracks[0].name === 'Hips.quaternion', 'nama track berubah');
  var last = res.tracks[0].times[res.tracks[0].times.length - 1];
  assertClose(last, 1.6, 1e-6, 'key terakhir tidak di ujung klip');
});

test('durasi tersimpulkan kalau clip tidak menyebutkannya', function () {
  var res = F.enhance({ tracks: [{ name: '.position', type: 'vector',
    times: [0, 1, 2.5], values: [0,0,0, 1,1,1, 2,2,2] }] }, { fps: 30 });
  assertClose(res.duration, 2.5, 1e-9, 'durasi salah');
});

test('preset menaikkan fps dan kehalusan secara berurutan', function () {
  var order = ['performance', 'balanced', 'quality', 'ultra'];
  for (var i = 1; i < order.length; i++) {
    assert(F.PRESETS[order[i]].fps > F.PRESETS[order[i - 1]].fps,
      'fps preset tidak naik di ' + order[i]);
  }
});

test('opsi eksplisit menimpa preset', function () {
  var o = F.resolveOptions({ preset: 'ultra', fps: 24 });
  assert(o.fps === 24, 'override fps gagal: ' + o.fps);
  assert(o.smoothing === F.PRESETS.ultra.smoothing, 'preset lain ikut hilang');
});

test('clip panjang x fps tinggi tetap dibatasi (tidak menggantung)', function () {
  var res = F.enhance({ duration: 600, tracks: [{ name: '.position', type: 'vector',
    times: [0, 300, 600], values: [0,0,0, 5,5,5, 0,0,0] }] }, { fps: 240, reduction: 0 });
  assert(res.stats.sampleCount <= 24000, 'sample tidak dibatasi: ' + res.stats.sampleCount);
  assert(res.stats.fps < 240, 'fps efektif tidak diturunkan');
});

test('tidak ada NaN di output untuk clip campuran', function () {
  var clip = {
    duration: 2,
    tracks: [
      { name: 'Root.position', type: 'vector', times: [0,0.5,1,1.5,2], values: [0,0,0, 0,1,0, 0,0,0, 0,1,0, 0,0,0] },
      { name: 'Root.quaternion', type: 'quaternion', times: [0,1,2],
        values: quatFromAxisAngle(0,1,0,0).concat(quatFromAxisAngle(0,1,0,3.0), quatFromAxisAngle(0,1,0,0)) },
      { name: 'Root.scale', type: 'vector', times: [0,2], values: [1,1,1, 1,1,1] }
    ]
  };
  var res = F.enhance(clip, { preset: 'ultra' });
  res.tracks.forEach(function (t) {
    t.values.forEach(function (v, i) {
      assert(isFinite(v), 'NaN/Inf di track ' + t.name + ' index ' + i);
    });
    t.times.forEach(function (v, i) {
      assert(isFinite(v), 'waktu tidak valid di ' + t.name + ' index ' + i);
    });
  });
});

console.log('\n' + (failed === 0 ? '✅ ' : '❌ ') + passed + ' passed, ' + failed + ' failed\n');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
