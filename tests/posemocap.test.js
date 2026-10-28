/*
 * Test untuk pengubahan titik sendi jadi animasi tulang.
 * Jalankan: node tests/posemocap.test.js
 */
'use strict';

var P = require('../js/posemocap.js');
var I = P._internal;

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function close(a, b, tol, m) {
  if (Math.abs(a - b) > tol) throw new Error((m || 'mismatch') + ' — expected ' + b + ', got ' + a);
}

/**
 * Orang sintetis dalam koordinat MediaPipe (y ke bawah, z menjauh).
 * `pose` boleh menimpa posisi sendi mana pun.
 */
function person(pose) {
  var lm = new Array(33);
  for (var i = 0; i < 33; i++) lm[i] = { x: 0, y: 0, z: 0, visibility: 1 };
  var put = function (idx, x, y, z) { lm[idx] = { x: x, y: y, z: z, visibility: 1 }; };

  put(P.LM.leftHip, 0.1, 0, 0);
  put(P.LM.rightHip, -0.1, 0, 0);
  put(P.LM.leftShoulder, 0.18, -0.5, 0);
  put(P.LM.rightShoulder, -0.18, -0.5, 0);
  put(P.LM.leftEar, 0.07, -0.75, 0);
  put(P.LM.rightEar, -0.07, -0.75, 0);
  put(P.LM.nose, 0, -0.72, 0.08);
  // lengan terentang mendatar (pose T)
  put(P.LM.leftElbow, 0.45, -0.5, 0);
  put(P.LM.leftWrist, 0.70, -0.5, 0);
  put(P.LM.leftIndex, 0.78, -0.5, 0);
  put(P.LM.rightElbow, -0.45, -0.5, 0);
  put(P.LM.rightWrist, -0.70, -0.5, 0);
  put(P.LM.rightIndex, -0.78, -0.5, 0);
  // tungkai lurus ke bawah
  put(P.LM.leftKnee, 0.1, 0.45, 0);
  put(P.LM.leftAnkle, 0.1, 0.9, 0);
  put(P.LM.leftFootIndex, 0.1, 0.95, -0.15);
  put(P.LM.rightKnee, -0.1, 0.45, 0);
  put(P.LM.rightAnkle, -0.1, 0.9, 0);
  put(P.LM.rightFootIndex, -0.1, 0.95, -0.15);

  if (pose) {
    Object.keys(pose).forEach(function (k) {
      var v = pose[k];
      lm[P.LM[k]] = { x: v[0], y: v[1], z: v[2], visibility: v[3] === undefined ? 1 : v[3] };
    });
  }
  return lm;
}

function frames(n, poseAt) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ time: i / 30, landmarks: person(poseAt ? poseAt(i) : null) });
  return out;
}

/** Terapkan rotasi hasil build ke skeleton rest; kembalikan arah tiap tulang. */
function forwardKinematics(result, frameIndex) {
  var byName = {};
  result.bones.forEach(function (b) { byName[b.name] = b; });

  var rot = {};
  result.tracks.forEach(function (t) {
    if (t.type !== 'quaternion') return;
    var name = t.name.replace('.quaternion', '');
    var o = frameIndex * 4;
    rot[name] = [t.values[o], t.values[o + 1], t.values[o + 2], t.values[o + 3]];
  });

  function rotateVec(q, v) {
    var qv = [v[0], v[1], v[2], 0];
    var r = I.qMul(I.qMul(q, qv), I.qConj(q));
    return [r[0], r[1], r[2]];
  }

  var worldQ = {}, dirs = {};
  result.bones.forEach(function (bone) {
    var parentQ = bone.parent ? worldQ[bone.parent] : [0, 0, 0, 1];
    var q = I.qMul(parentQ, rot[bone.name] || [0, 0, 0, 1]);
    worldQ[bone.name] = q;
    dirs[bone.name] = I.normalize(rotateVec(q, bone.restDirection));
  });
  return dirs;
}

console.log('\nBasis quaternion');

test('basis memutar sumbu Y ke arah yang diminta', function () {
  function rotateVec(q, v) {
    var qv = [v[0], v[1], v[2], 0];
    var r = I.qMul(I.qMul(q, qv), I.qConj(q));
    return [r[0], r[1], r[2]];
  }
  [[1, 0, 0], [0, 0, 1], [0.3, 0.8, -0.5], [-0.6, -0.2, 0.7]].forEach(function (aim) {
    var q = I._internal ? null : null;
    var qq = I.basisQuaternion(aim, [1, 0, 0]);
    var got = I.normalize(rotateVec(qq, [0, 1, 0]));
    var want = I.normalize(aim);
    for (var c = 0; c < 3; c++) close(got[c], want[c], 1e-6, 'sumbu ' + c + ' untuk aim ' + aim.join(','));
  });
});

test('hint sejajar dengan aim tidak menghasilkan NaN', function () {
  var q = I.basisQuaternion([0, 1, 0], [0, 1, 0]);
  q.forEach(function (v) { assert(isFinite(v), 'NaN pada quaternion'); });
  var n = Math.hypot(q[0], q[1], q[2], q[3]);
  close(n, 1, 1e-6, 'tidak ternormalisasi');
});

console.log('\nKoordinat');

test('sumbu Y dibalik supaya model berdiri tegak', function () {
  var p = I.derivePoints(person(), P.resolveOptions({}));
  // bahu di y=-0.5 pada MediaPipe harus jadi DI ATAS pinggul
  assert(p.shoulderCenter[1] > p.hipCenter[1],
    'bahu (' + p.shoulderCenter[1] + ') tidak di atas pinggul (' + p.hipCenter[1] + ')');
  assert(p.headTop[1] > p.shoulderCenter[1], 'kepala tidak di atas bahu');
});

test('tanpa pembalikan, model jadi terbalik', function () {
  var p = I.derivePoints(person(), P.resolveOptions({ flipY: false }));
  assert(p.shoulderCenter[1] < p.hipCenter[1], 'pembalikan seharusnya berpengaruh');
});

test('skala diterapkan ke semua sendi', function () {
  var a = I.derivePoints(person(), P.resolveOptions({ scale: 1 }));
  var b = I.derivePoints(person(), P.resolveOptions({ scale: 100 }));
  close(b.shoulderCenter[1] / a.shoulderCenter[1], 100, 1e-6, 'skala tidak diterapkan');
});

console.log('\nPanjang tulang');

test('panjang diukur dari jarak sendi', function () {
  var lengths = I.measureBoneLengths(frames(5), P.resolveOptions({}));
  close(lengths.LeftUpperArm, 0.27, 1e-6, 'lengan atas');  // 0.45 - 0.18
  close(lengths.LeftLowerArm, 0.25, 1e-6, 'lengan bawah'); // 0.70 - 0.45
  close(lengths.LeftUpLeg, 0.45, 1e-6, 'paha');
});

test('satu frame rusak tidak merusak proporsi rig', function () {
  // Median, bukan frame pertama: satu deteksi meleset tidak boleh
  // terbawa ke seluruh animasi.
  var f = frames(9);
  f[0].landmarks[P.LM.leftElbow] = { x: 9, y: -0.5, z: 0, visibility: 1 };
  var lengths = I.measureBoneLengths(f, P.resolveOptions({}));
  close(lengths.LeftUpperArm, 0.27, 1e-6, 'median tidak menahan outlier');
});

test('tulang yang tidak pernah terbaca tetap diberi panjang masuk akal', function () {
  var f = frames(4, function () {
    return { leftElbow: [0, 0, 0, 0], leftWrist: [0, 0, 0, 0], leftIndex: [0, 0, 0, 0] };
  });
  var lengths = I.measureBoneLengths(f, P.resolveOptions({}));
  assert(lengths.LeftUpperArm > 0, 'panjang nol membuat rig runtuh');
  assert(isFinite(lengths.LeftUpperArm), 'panjang tidak valid');
});

console.log('\nRetargeting');

test('rotasi hasil mereproduksi arah sendi masukan (round-trip)', function () {
  // Uji terkuat: terapkan kembali rotasi keluaran ke skeleton rest lewat
  // forward kinematics, lalu bandingkan arah tiap tulang dengan arah
  // sendi aslinya.
  var pose = {
    leftElbow: [0.30, -0.20, 0],      // lengan kiri menekuk ke atas
    leftWrist: [0.34, 0.05, 0],
    leftIndex: [0.35, 0.12, 0],
    rightKnee: [-0.15, 0.40, 0.18],   // lutut kanan maju
    rightAnkle: [-0.15, 0.85, 0.05]
  };
  var f = [{ time: 0, landmarks: person(pose) }];
  var res = P.build(f, {});
  var dirs = forwardKinematics(res, 0);
  var p = I.derivePoints(person(pose), P.resolveOptions({}));

  P.RIG.forEach(function (bone) {
    var a = p[bone.from], b = p[bone.to];
    if (!a || !b) return;
    var want = I.normalize(I.sub(b, a));
    var got = dirs[bone.name];
    var d = I.dot(want, got);
    assert(d > 0.999, bone.name + ' meleset: dot=' + d.toFixed(4) +
      ' mau [' + want.map(function (v) { return v.toFixed(2); }) + ']' +
      ' dapat [' + got.map(function (v) { return v.toFixed(2); }) + ']');
  });
});

test('pose T menghasilkan rotasi mendekati identitas', function () {
  var res = P.build([{ time: 0, landmarks: person() }], {});
  var rot = {};
  res.tracks.forEach(function (t) {
    if (t.type === 'quaternion') rot[t.name.replace('.quaternion', '')] = t.values.slice(0, 4);
  });
  ['LeftUpperArm', 'RightUpperArm', 'LeftUpLeg', 'Spine'].forEach(function (name) {
    var q = rot[name];
    var angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
    assert(angle < 0.2, name + ' berputar ' + angle.toFixed(3) + ' rad padahal pose T');
  });
});

test('posisi pinggul mengikuti gerakan subjek', function () {
  var f = frames(10, function (i) {
    var dx = i * 0.05;
    return { leftHip: [0.1 + dx, 0, 0], rightHip: [-0.1 + dx, 0, 0] };
  });
  var res = P.build(f, {});
  var hip = res.tracks.filter(function (t) { return t.name === 'Hips.position'; })[0];
  assert(hip, 'track posisi pinggul tidak ada');
  close(hip.values[0], 0, 1e-6, 'frame 0');
  close(hip.values[9 * 3], 0.45, 1e-6, 'frame 9');
});

console.log('\nSendi yang hilang');

test('sendi di bawah ambang keterlihatan ditahan, bukan dinolkan', function () {
  var f = [
    { time: 0, landmarks: person({ leftElbow: [0.30, -0.20, 0] }) },
    { time: 1 / 30, landmarks: person({ leftElbow: [0.30, -0.20, 0, 0.05] }) }
  ];
  var res = P.build(f, {});
  var t = res.tracks.filter(function (x) { return x.name === 'LeftUpperArm.quaternion'; })[0];
  for (var c = 0; c < 4; c++) {
    close(t.values[4 + c], t.values[c], 1e-9, 'komponen ' + c + ' tidak ditahan');
  }
  assert(res.stats.bonesHeld > 0, 'statistik penahanan tidak dilaporkan');
});

test('frame tanpa pinggul sama sekali tidak merusak track', function () {
  var blank = new Array(33);
  for (var i = 0; i < 33; i++) blank[i] = { x: 0, y: 0, z: 0, visibility: 0 };
  var f = [
    { time: 0, landmarks: person() },
    { time: 1 / 30, landmarks: blank },
    { time: 2 / 30, landmarks: person() }
  ];
  var res = P.build(f, {});
  assert(res.stats.framesWithoutPose === 1, 'frame kosong tidak terdeteksi');
  res.tracks.forEach(function (t) {
    assert(t.times.length === 3, t.name + ' kehilangan frame');
    var stride = t.type === 'quaternion' ? 4 : 3;
    assert(t.values.length === 3 * stride, t.name + ' panjang nilai salah');
    t.values.forEach(function (v) { assert(isFinite(v), 'NaN di ' + t.name); });
  });
});

test('posisi sendi hasil FK cocok dengan landmark masukan', function () {
  /*
   * Round-trip arah saja tidak cukup: arah tulang bisa benar sementara
   * pangkalnya menempel di tempat yang salah. Versi pertama modul ini
   * memasang offset tiap tulang sepanjang tulang INDUKNYA, sehingga
   * lengan tumbuh dari tengah dada dan tungkai dari satu titik — dan
   * test arah tetap lolos.
   */
  var pose = {
    leftElbow: [0.30, -0.20, 0],
    leftWrist: [0.34, 0.05, 0],
    leftIndex: [0.35, 0.12, 0],
    rightKnee: [-0.15, 0.40, 0.18],
    rightAnkle: [-0.15, 0.85, 0.05]
  };
  var lm = person(pose);
  var res = P.build([{ time: 0, landmarks: lm }], {});
  var p = I.derivePoints(lm, P.resolveOptions({}));

  var byName = {};
  res.bones.forEach(function (b) { byName[b.name] = b; });
  var rot = {};
  res.tracks.forEach(function (t) {
    if (t.type === 'quaternion') rot[t.name.replace('.quaternion', '')] = t.values.slice(0, 4);
  });

  function rotateVec(q, v) {
    var qv = [v[0], v[1], v[2], 0];
    var r = I.qMul(I.qMul(q, qv), I.qConj(q));
    return [r[0], r[1], r[2]];
  }

  // forward kinematics penuh: posisi pangkal tiap tulang
  var worldQ = {}, worldPos = {};
  res.bones.forEach(function (bone) {
    var parentQ = bone.parent ? worldQ[bone.parent] : [0, 0, 0, 1];
    var parentPos = bone.parent ? worldPos[bone.parent] : [0, 0, 0];
    worldPos[bone.name] = [
      parentPos[0] + rotateVec(parentQ, bone.offset)[0],
      parentPos[1] + rotateVec(parentQ, bone.offset)[1],
      parentPos[2] + rotateVec(parentQ, bone.offset)[2]
    ];
    worldQ[bone.name] = I.qMul(parentQ, rot[bone.name] || [0, 0, 0, 1]);
  });

  // bandingkan relatif terhadap pusat pinggul
  var hip = p.hipCenter;
  var cek = [
    ['LeftUpperArm', 'leftShoulder'],
    ['RightUpperArm', 'rightShoulder'],
    ['LeftUpLeg', 'leftHip'],
    ['RightUpLeg', 'rightHip'],
    ['LeftLowerArm', 'leftElbow'],
    ['RightLeg', 'rightKnee']
  ];
  cek.forEach(function (pair) {
    var got = worldPos[pair[0]];
    var want = I.sub(p[pair[1]], hip);
    var err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
    assert(err < 0.03, pair[0] + ' menempel di tempat yang salah: meleset ' + err.toFixed(3) +
      ' m  (dapat [' + got.map(function (v) { return v.toFixed(2); }) +
      '] mau [' + want.map(function (v) { return v.toFixed(2); }) + '])');
  });
});

test('lebar bahu dan pinggul terukur terpisah dari panjang tulang', function () {
  var spans = I.measureSpans(frames(5), P.resolveOptions({}));
  close(spans.hipHalf, 0.1, 1e-6, 'setengah lebar pinggul');
  close(spans.shoulderHalf, 0.18, 1e-6, 'setengah lebar bahu');
});

console.log('\nBentuk keluaran');

test('track cocok dengan format yang dipakai engine', function () {
  var res = P.build(frames(12), {});
  assert(res.bones.length === P.RIG.length, 'jumlah tulang salah');
  res.tracks.forEach(function (t) {
    assert(typeof t.name === 'string' && t.name.length, 'nama track kosong');
    assert(t.type === 'vector' || t.type === 'quaternion', 'tipe tak terduga: ' + t.type);
    var stride = t.type === 'quaternion' ? 4 : 3;
    assert(t.values.length === t.times.length * stride,
      t.name + ': ' + t.values.length + ' vs ' + t.times.length * stride);
  });
  close(res.duration, 11 / 30, 1e-9, 'durasi');
});

test('quaternion keluaran selalu ternormalisasi', function () {
  var res = P.build(frames(20, function (i) {
    var a = i * 0.3;
    return { leftElbow: [0.2 + Math.cos(a) * 0.2, -0.5 + Math.sin(a) * 0.2, Math.sin(a * 2) * 0.1] };
  }), {});
  res.tracks.forEach(function (t) {
    if (t.type !== 'quaternion') return;
    for (var i = 0; i < t.times.length; i++) {
      var o = i * 4;
      var n = Math.hypot(t.values[o], t.values[o + 1], t.values[o + 2], t.values[o + 3]);
      close(n, 1, 1e-5, t.name + ' frame ' + i);
    }
  });
});

test('daftar frame kosong tidak melempar', function () {
  var res = P.build([], {});
  assert(res.tracks.length === 0 && res.bones.length === 0, 'seharusnya kosong');
  assert(res.duration === 0, 'durasi harus nol');
});

test('setiap tulang punya induk yang benar-benar ada', function () {
  var names = {};
  P.RIG.forEach(function (b) { names[b.name] = 1; });
  P.RIG.forEach(function (b) {
    if (b.parent !== null) assert(names[b.parent], b.name + ' menunjuk induk tak dikenal: ' + b.parent);
  });
});

test('orang diam memberi simpangan gerak kecil', function () {
  var res = P.build(frames(20), {});
  assert(res.stats.motionRange < 1,
    'seharusnya nyaris nol, dapat ' + res.stats.motionRange.toFixed(2));
});

test('lengan berayun memberi simpangan gerak besar', function () {
  // lengan kiri turun dari mendatar ke bawah sepanjang klip
  var res = P.build(frames(20, function (i) {
    var a = (i / 19) * Math.PI / 2;
    return {
      leftElbow: [0.18 + 0.27 * Math.cos(a), -0.5 + 0.27 * Math.sin(a), 0],
      leftWrist: [0.18 + 0.52 * Math.cos(a), -0.5 + 0.52 * Math.sin(a), 0],
      leftIndex: [0.18 + 0.60 * Math.cos(a), -0.5 + 0.60 * Math.sin(a), 0]
    };
  }), {});
  assert(res.stats.motionRange > 45,
    'ayunan 90 derajat seharusnya terbaca besar, dapat ' + res.stats.motionRange.toFixed(2));
});

test('simpangan gerak selalu berupa angka terhingga', function () {
  [P.build([], {}), P.build(frames(1), {}), P.build(frames(20), {})].forEach(function (res) {
    assert(typeof res.stats.motionRange === 'number' && isFinite(res.stats.motionRange),
      'motionRange bukan angka terhingga: ' + res.stats.motionRange);
  });
});

console.log('\n' + (failed === 0 ? '✅ ' : '❌ ') + passed + ' passed, ' + failed + ' failed\n');
if (failed) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
