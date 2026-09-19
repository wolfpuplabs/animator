/*
 * Test untuk perbaikan bobot skin. Jalankan: node tests/skinfix.test.js
 */
'use strict';

var S = require('../js/skinfix.js');
var I = S._internal;

var passed = 0, failed = 0;
var failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; failures.push(name + ': ' + err.message); console.log('  ✗ ' + name + '\n      ' + err.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertClose(a, b, tol, m) {
  if (Math.abs(a - b) > tol) throw new Error((m || 'mismatch') + ' — expected ' + b + ', got ' + a);
}

/** Bidang sederhana: grid (n+1)x(n+1) vertex, terindeks. */
function makeGrid(n) {
  var position = [], index = [];
  for (var y = 0; y <= n; y++) {
    for (var x = 0; x <= n; x++) position.push(x / n, y / n, 0);
  }
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      var a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  return {
    position: new Float32Array(position),
    index: new Uint32Array(index),
    vertexCount: (n + 1) * (n + 1)
  };
}

/** Bobot dua tulang berdasarkan tinggi, dengan batas tajam di tengah. */
function hardSplitWeights(grid) {
  var n = grid.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    var y = grid.position[v * 3 + 1];
    si[v * 4] = y < 0.5 ? 0 : 1;
    sw[v * 4] = 1;
  }
  return { skinIndex: si, skinWeight: sw };
}

console.log('\nSanitasi');

test('bobot yang tidak ternormalisasi diperbaiki jadi berjumlah 1', function () {
  var g = makeGrid(2);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = 0; si[v * 4 + 1] = 1;
    sw[v * 4] = 0.3; sw[v * 4 + 1] = 0.2; // jumlah 0.5, mesh akan mengempis
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 }, { smoothing: 0 });

  assert(res.stats.maxWeightErrorBefore > 0.4, 'error awal tidak terdeteksi');
  assert(res.stats.maxWeightErrorAfter < 1e-5,
    'masih belum ternormalisasi: ' + res.stats.maxWeightErrorAfter);
  for (var k = 0; k < n; k++) {
    var sum = 0;
    for (var s = 0; s < 4; s++) sum += res.skinWeight[k * 4 + s];
    assertClose(sum, 1, 1e-5, 'vertex ' + k);
  }
});

test('bobot negatif dan NaN dibuang', function () {
  var g = makeGrid(1);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = 0; si[v * 4 + 1] = 1; si[v * 4 + 2] = 1;
    sw[v * 4] = 0.8; sw[v * 4 + 1] = -0.3; sw[v * 4 + 2] = NaN;
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 }, { smoothing: 0 });
  assert(res.stats.negativeOrInvalidFixed >= n * 2,
    'hanya ' + res.stats.negativeOrInvalidFixed + ' yang diperbaiki');
  for (var k = 0; k < res.skinWeight.length; k++) {
    assert(isFinite(res.skinWeight[k]) && res.skinWeight[k] >= 0, 'sisa nilai buruk di ' + k);
  }
});

test('indeks tulang di luar jangkauan dinetralkan', function () {
  var g = makeGrid(1);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = 0; sw[v * 4] = 0.5;
    si[v * 4 + 1] = 99; sw[v * 4 + 1] = 0.5; // tulang ke-99 tidak ada
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 3,
    bonePositions: [[0,0,0],[1,0,0],[0,1,0]] }, { smoothing: 0 });
  assert(res.stats.outOfRangeFixed >= n, 'indeks liar tidak terdeteksi');
  for (var k = 0; k < res.skinIndex.length; k++) {
    assert(res.skinIndex[k] < 3, 'indeks ' + res.skinIndex[k] + ' masih di luar jangkauan');
  }
});

console.log('\nVertex orphan');

test('vertex tanpa pengaruh ditambal ke tulang terdekat', function () {
  var g = makeGrid(2);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) { si[v * 4] = 0; sw[v * 4] = 1; }
  // kosongkan vertex 4 (tengah grid, posisi 0.5,0.5)
  sw[4 * 4] = 0;

  var bones = [[0, 0, 0], [1, 1, 0]];
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2, bonePositions: bones },
    { smoothing: 0 });

  assert(res.stats.orphansFixed === 1, 'orphan terdeteksi: ' + res.stats.orphansFixed);
  var sum = 0;
  for (var s = 0; s < 4; s++) sum += res.skinWeight[4 * 4 + s];
  assertClose(sum, 1, 1e-5, 'orphan masih kosong');
});

test('tanpa fixOrphans, vertex kosong dibiarkan', function () {
  var g = makeGrid(2);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) { si[v * 4] = 0; sw[v * 4] = 1; }
  sw[4 * 4] = 0;
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 }, { smoothing: 0, fixOrphans: false });
  assert(res.stats.orphansFixed === 0, 'seharusnya tidak menambal');
});

console.log('\nPrune');

test('pengaruh remeh dibuang', function () {
  var g = makeGrid(1);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = 0; sw[v * 4] = 0.97;
    si[v * 4 + 1] = 1; sw[v * 4 + 1] = 0.002; // jauh di bawah ambang
    si[v * 4 + 2] = 2; sw[v * 4 + 2] = 0.028;
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 3 }, { smoothing: 0, minWeight: 0.01 });
  assert(res.stats.influencesPruned >= n, 'tidak ada yang dipangkas');
  for (var v2 = 0; v2 < n; v2++) {
    for (var s = 0; s < 4; s++) {
      var w = res.skinWeight[v2 * 4 + s];
      assert(w === 0 || w > 0.005, 'masih ada bobot remeh: ' + w);
    }
  }
});

test('vertex yang semua bobotnya remeh tidak dikosongkan', function () {
  // Kalau prune membuang semuanya, kita sendiri yang bikin orphan baru.
  var list = [{ idx: 3, w: 0.004 }, { idx: 5, w: 0.001 }];
  var out = I.prune(list, 4, 0.01);
  assert(out.length === 1, 'seharusnya menyisakan satu, dapat ' + out.length);
  assert(out[0].idx === 3, 'yang disisakan harus yang terbesar');
});

test('jumlah pengaruh dibatasi ke maxInfluences', function () {
  var g = makeGrid(1);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    for (var s = 0; s < 4; s++) { si[v * 4 + s] = s; sw[v * 4 + s] = 0.25; }
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 4 }, { smoothing: 0, maxInfluences: 2 });
  assert(res.stats.maxInfluencesAfter <= 2, 'masih ' + res.stats.maxInfluencesAfter);
  assert(res.skinWeight.length === n * 2, 'stride keluaran salah');
  for (var k = 0; k < n; k++) {
    var sum = res.skinWeight[k * 2] + res.skinWeight[k * 2 + 1];
    assertClose(sum, 1, 1e-5, 'vertex ' + k + ' tidak ternormalisasi setelah dibatasi');
  }
});

console.log('\nWeld dan ketetanggaan');

test('vertex di posisi sama disatukan', function () {
  var position = new Float32Array([0,0,0, 0,0,0, 1,0,0, 1,0,0, 2,0,0]);
  var weld = I.buildWeld(position, 5, 1e-5);
  assert(weld.members.length === 3, 'grup: ' + weld.members.length);
  assert(weld.groupOf[0] === weld.groupOf[1], 'dua vertex pertama harus satu grup');
  assert(weld.groupOf[2] === weld.groupOf[3], 'vertex 2 dan 3 harus satu grup');
});

test('ketetanggaan terbentuk dari sisi segitiga', function () {
  var g = makeGrid(1); // 4 vertex, 2 segitiga
  var weld = I.buildWeld(g.position, g.vertexCount, 1e-5);
  var adj = I.buildAdjacency(g.index, g.vertexCount, weld.groupOf, weld.members.length);
  assert(adj.length === 4, 'grup: ' + adj.length);
  for (var i = 0; i < 4; i++) assert(adj[i].length >= 2, 'vertex ' + i + ' terisolasi');
});

test('mesh tanpa indeks tetap punya ketetanggaan', function () {
  var position = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
  var weld = I.buildWeld(position, 3, 1e-5);
  var adj = I.buildAdjacency(null, 3, weld.groupOf, weld.members.length);
  assert(adj[0].length === 2 && adj[1].length === 2, 'segitiga tunggal harus saling terhubung');
});

console.log('\nPenghalusan envelope');

test('batas tajam antar tulang jadi melandai', function () {
  var g = makeGrid(8);
  var w = hardSplitWeights(g);
  var res = S.repair({ position: g.position, index: g.index, vertexCount: g.vertexCount,
    skinIndex: w.skinIndex, skinWeight: w.skinWeight, boneCount: 2 },
    { smoothing: 0.6, iterations: 3, minWeight: 0.001 });

  // Sebelum: tiap vertex 100% satu tulang. Sesudah: di sekitar batas harus
  // ada vertex yang membagi pengaruh ke dua tulang.
  var blended = 0;
  for (var v = 0; v < g.vertexCount; v++) {
    var a = res.skinWeight[v * 4], b = res.skinWeight[v * 4 + 1];
    if (a > 0.05 && b > 0.05) blended++;
  }
  assert(blended > 0, 'tidak ada vertex yang membaur — envelope tetap tajam');
});

test('penghalusan tidak merusak normalisasi', function () {
  var g = makeGrid(6);
  var w = hardSplitWeights(g);
  var res = S.repair({ position: g.position, index: g.index, vertexCount: g.vertexCount,
    skinIndex: w.skinIndex, skinWeight: w.skinWeight, boneCount: 2 },
    { smoothing: 0.8, iterations: 4 });
  for (var v = 0; v < g.vertexCount; v++) {
    var sum = 0;
    for (var s = 0; s < 4; s++) sum += res.skinWeight[v * 4 + s];
    assertClose(sum, 1, 1e-5, 'vertex ' + v);
  }
});

test('penghalusan tidak membengkakkan jumlah pengaruh', function () {
  // Tiap iterasi menyebarkan pengaruh dari tetangga; tanpa pemangkasan
  // ulang, jumlah pengaruh per vertex akan tumbuh terus.
  var g = makeGrid(6);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) { si[v * 4] = v % 5; sw[v * 4] = 1; }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 5 },
    { smoothing: 0.7, iterations: 5, maxInfluences: 4 });
  assert(res.stats.maxInfluencesAfter <= 4, 'membengkak jadi ' + res.stats.maxInfluencesAfter);
});

test('jahitan UV tidak jadi batas penghalusan', function () {
  // Dua vertex di posisi yang sama tapi indeks berbeda (jahitan UV).
  // Keduanya harus berakhir dengan bobot yang sama persis.
  var position = new Float32Array([
    0,0,0,  1,0,0,  0,1,0,
    1,0,0,  1,1,0,  0,1,0   // vertex 3 menduplikat vertex 1, vertex 5 menduplikat vertex 2
  ]);
  var index = new Uint32Array([0,1,2, 3,4,5]);
  var n = 6;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) { si[v * 4] = v < 3 ? 0 : 1; sw[v * 4] = 1; }

  var res = S.repair({ position: position, index: index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 },
    { smoothing: 0.5, iterations: 2, minWeight: 0.001 });

  function weightsOf(v) {
    var m = {};
    for (var s = 0; s < 4; s++) if (res.skinWeight[v * 4 + s] > 0) m[res.skinIndex[v * 4 + s]] = res.skinWeight[v * 4 + s];
    return m;
  }
  var a = weightsOf(1), b = weightsOf(3);
  Object.keys(a).forEach(function (k) {
    assertClose(a[k] || 0, b[k] || 0, 1e-6, 'jahitan di tulang ' + k + ' tidak sinkron');
  });
});

test('smoothing 0 membiarkan bobot apa adanya', function () {
  var g = makeGrid(4);
  var w = hardSplitWeights(g);
  var res = S.repair({ position: g.position, index: g.index, vertexCount: g.vertexCount,
    skinIndex: w.skinIndex, skinWeight: w.skinWeight, boneCount: 2 },
    { smoothing: 0 });
  for (var v = 0; v < g.vertexCount; v++) {
    assertClose(res.skinWeight[v * 4], 1, 1e-6, 'vertex ' + v + ' berubah');
    assert(res.skinIndex[v * 4] === w.skinIndex[v * 4], 'tulang berubah di vertex ' + v);
  }
  assert(res.stats.weldGroups === 0, 'weld seharusnya tidak dijalankan');
});

console.log('\nKetahanan');

test('mesh yang sudah bersih tidak dirusak', function () {
  var g = makeGrid(5);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    var t = g.position[v * 3 + 1];
    si[v * 4] = 0; sw[v * 4] = 1 - t;
    si[v * 4 + 1] = 1; sw[v * 4 + 1] = t;
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 }, { smoothing: 0 });
  assert(res.stats.orphansFixed === 0, 'salah menambal');
  assert(res.stats.unnormalizedFixed === 0, 'salah menormalisasi: ' + res.stats.unnormalizedFixed);
  assert(res.stats.maxWeightErrorAfter < 1e-5, 'error akhir naik');

  // Dibandingkan per tulang, bukan per slot: prune menyortir besar ke
  // kecil, dan skinning tidak peduli urutan slot.
  for (var k = 0; k < n; k++) {
    var want = {}, got = {};
    for (var s = 0; s < 4; s++) {
      if (sw[k * 4 + s] > 0) want[si[k * 4 + s]] = sw[k * 4 + s];
      if (res.skinWeight[k * 4 + s] > 0) got[res.skinIndex[k * 4 + s]] = res.skinWeight[k * 4 + s];
    }
    Object.keys(want).forEach(function (bone) {
      assertClose(got[bone] || 0, want[bone], 1e-5, 'vertex ' + k + ' tulang ' + bone + ' berubah');
    });
    assert(Object.keys(got).length === Object.keys(want).length,
      'vertex ' + k + ': jumlah pengaruh berubah');
  }
});

test('slot diurutkan dari bobot terbesar', function () {
  var g = makeGrid(3);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = 0; sw[v * 4] = 0.2;
    si[v * 4 + 1] = 1; sw[v * 4 + 1] = 0.8;
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 2 }, { smoothing: 0 });
  for (var k = 0; k < n; k++) {
    assert(res.skinWeight[k * 4] >= res.skinWeight[k * 4 + 1],
      'slot tidak terurut di vertex ' + k);
  }
});

test('tidak ada NaN atau indeks liar di keluaran', function () {
  var g = makeGrid(7);
  var n = g.vertexCount;
  var si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (var v = 0; v < n; v++) {
    si[v * 4] = v % 3; sw[v * 4] = 0.6;
    si[v * 4 + 1] = (v + 1) % 3; sw[v * 4 + 1] = 0.1;
    si[v * 4 + 2] = 77; sw[v * 4 + 2] = 0.3;
  }
  var res = S.repair({ position: g.position, index: g.index, vertexCount: n,
    skinIndex: si, skinWeight: sw, boneCount: 3,
    bonePositions: [[0,0,0],[1,0,0],[0,1,0]] }, { smoothing: 0.5, iterations: 2 });
  for (var k = 0; k < res.skinWeight.length; k++) {
    assert(isFinite(res.skinWeight[k]), 'NaN di bobot ' + k);
    assert(res.skinIndex[k] < 3, 'indeks liar ' + res.skinIndex[k]);
  }
});

test('opsi dijepit ke rentang yang masuk akal', function () {
  var o = S.resolveOptions({ maxInfluences: 99, smoothing: 5, iterations: -3, minWeight: 9 });
  assert(o.maxInfluences === 8, 'maxInfluences: ' + o.maxInfluences);
  assert(o.smoothing === 1, 'smoothing: ' + o.smoothing);
  assert(o.iterations === 0, 'iterations: ' + o.iterations);
  assert(o.minWeight === 0.5, 'minWeight: ' + o.minWeight);
});

console.log('\n' + (failed === 0 ? '✅ ' : '❌ ') + passed + ' passed, ' + failed + ' failed\n');
if (failed) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
