/**
 * Penjaga pemindahan tangkapan video ke rig model lain.
 *
 * Dua hal yang diuji terpisah, karena rusaknya beda:
 *
 *   1. Pencocokan nama tulang. Tiap perkakas menamai tulang dengan
 *      caranya sendiri, dan yang salah cocok jauh lebih berbahaya
 *      daripada yang tidak cocok sama sekali — tulang jari yang terbaca
 *      sebagai telapak tangan akan memuntir seluruh lengan.
 *
 *   2. Matematikanya. Diuji lewat AnimationMixer sungguhan, bukan dengan
 *      membandingkan angka yang baru saja dihitung sendiri: yang mau
 *      dipastikan justru nama track, urutan induk-anak, dan rotasi lokal
 *      yang benar-benar dievaluasi three.
 */

var path = require('path');
global.THREE = require(path.join(__dirname, '..', 'node_modules', 'three'));
var THREE = global.THREE;
global.self = global;

var P = require(path.join(__dirname, '..', 'js', 'posemocap.js'));
require(path.join(__dirname, '..', 'js', 'posepipeline.js'));
var Pipeline = global.PosePipeline;
var R = require(path.join(__dirname, '..', 'js', 'retarget.js'));

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function section(n) { console.log('\n' + n); }

/* ------------------------------------------------------------------ *
 * Bahan uji
 * ------------------------------------------------------------------ */

/** Orang berdiri; lengan kiri turun dari mendatar ke bawah. */
function captureFrames(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = (i / (n - 1)) * Math.PI / 2;
    var lm = [];
    for (var k = 0; k < 33; k++) lm[k] = { x: 0, y: 0, z: 0, visibility: 1 };
    var put = function (idx, x, y, z) { lm[idx] = { x: x, y: y, z: z, visibility: 1 }; };
    put(P.LM.leftHip, 0.1, 0, 0);          put(P.LM.rightHip, -0.1, 0, 0);
    put(P.LM.leftShoulder, 0.18, -0.5, 0); put(P.LM.rightShoulder, -0.18, -0.5, 0);
    put(P.LM.leftEar, 0.07, -0.75, 0);     put(P.LM.rightEar, -0.07, -0.75, 0);
    put(P.LM.nose, 0, -0.72, 0.08);
    put(P.LM.leftElbow, 0.18 + 0.27 * Math.cos(a), -0.5 + 0.27 * Math.sin(a), 0);
    put(P.LM.leftWrist, 0.18 + 0.52 * Math.cos(a), -0.5 + 0.52 * Math.sin(a), 0);
    put(P.LM.leftIndex, 0.18 + 0.60 * Math.cos(a), -0.5 + 0.60 * Math.sin(a), 0);
    put(P.LM.rightElbow, -0.45, -0.5, 0);  put(P.LM.rightWrist, -0.70, -0.5, 0);
    put(P.LM.rightIndex, -0.78, -0.5, 0);
    put(P.LM.leftKnee, 0.1, 0.45, 0);      put(P.LM.leftAnkle, 0.1, 0.9, 0);
    put(P.LM.leftFootIndex, 0.1, 0.95, -0.15);
    put(P.LM.rightKnee, -0.1, 0.45, 0);    put(P.LM.rightAnkle, -0.1, 0.9, 0);
    put(P.LM.rightFootIndex, -0.1, 0.95, -0.15);
    out.push({ time: i / 20, landmarks: lm });
  }
  return out;
}

var MIXAMO = {
  Hips: 'mixamorig:Hips', Spine: 'mixamorig:Spine', Chest: 'mixamorig:Spine2',
  LeftUpperArm: 'mixamorig:LeftArm', LeftLowerArm: 'mixamorig:LeftForeArm',
  LeftHand: 'mixamorig:LeftHand',
  RightUpperArm: 'mixamorig:RightArm', RightLowerArm: 'mixamorig:RightForeArm',
  RightHand: 'mixamorig:RightHand',
  LeftUpLeg: 'mixamorig:LeftUpLeg', LeftLeg: 'mixamorig:LeftLeg',
  LeftFoot: 'mixamorig:LeftFoot',
  RightUpLeg: 'mixamorig:RightUpLeg', RightLeg: 'mixamorig:RightLeg',
  RightFoot: 'mixamorig:RightFoot'
};

/**
 * Rig tujuan: dibangun dari tangkapan lalu DINAMAI ULANG ala Mixamo dan
 * boleh diperbesar. Jadi targetnya memang rig lain — nama lain, proporsi
 * lain — bukan rig yang sama yang dipakai ulang.
 */
function targetRig(capture, scale) {
  var rig = Pipeline.buildRig(capture, { name: 'Target', clipName: 'rest' });
  rig.root.traverse(function (o) {
    if (o.isBone && MIXAMO[o.name]) o.name = MIXAMO[o.name];
  });
  if (scale && scale !== 1) {
    rig.root.traverse(function (o) { if (o.isBone) o.position.multiplyScalar(scale); });
    rig.root.updateMatrixWorld(true);
    // bind ulang supaya boneInverses mencerminkan proporsi barunya
    rig.mesh.skeleton = new THREE.Skeleton(rig.mesh.skeleton.bones);
    rig.mesh.bind(rig.mesh.skeleton);
  }
  rig.root.updateMatrixWorld(true);
  return rig;
}

function worldQuatOf(root, name) {
  var found = null;
  root.traverse(function (o) { if (o.name === name) found = o; });
  assert(found, 'tulang tidak ditemukan: ' + name);
  var q = new THREE.Quaternion();
  found.getWorldQuaternion(q);
  return q;
}

function boneByName(root, name) {
  var found = null;
  root.traverse(function (o) { if (o.name === name) found = o; });
  return found;
}

/**
 * Track milik satu tulang. Namanya bisa berupa uuid, bukan nama tulang:
 * nama ber-titik dua tidak bisa di-resolve PropertyBinding, jadi
 * retarget memakai uuid sebagai cadangan.
 */
function trackFor(res, root, canon, suffix) {
  var bone = boneByName(root, MIXAMO[canon]);
  if (!bone) return null;
  var wanted = [bone.name + suffix, bone.uuid + suffix];
  return res.clip.tracks.filter(function (t) {
    return wanted.indexOf(t.name) !== -1;
  })[0] || null;
}

function angleBetween(a, b) {
  var d = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(d) * 180 / Math.PI;
}

/* ------------------------------------------------------------------ *
 * Pencocokan nama
 * ------------------------------------------------------------------ */

section('Pencocokan nama tulang');

test('mengenali konvensi penamaan yang umum', function () {
  var cases = {
    'mixamorig:LeftArm': 'LeftUpperArm',
    'mixamorig:RightForeArm': 'RightLowerArm',
    'J_Bip_L_UpperLeg': 'LeftUpLeg',
    'J_Bip_C_Chest': 'Chest',
    'thigh.L': 'LeftUpLeg',
    'upper_arm.R': 'RightUpperArm',
    'Bip01_R_Hand': 'RightHand',
    'shin_L': 'LeftLeg',
    'foot.r': 'RightFoot',
    'Hips': 'Hips',
    'pelvis': 'Hips',
    'Spine2': 'Chest',
    'LeftUpLeg': 'LeftUpLeg',
    'RightLeg': 'RightLeg'
  };
  Object.keys(cases).forEach(function (name) {
    var got = R.canonicalOf(name);
    assert(got === cases[name], name + ' -> ' + got + ', seharusnya ' + cases[name]);
  });
});

test('menolak tulang yang bukan bagian rig dasar', function () {
  // Salah cocok lebih berbahaya daripada tidak cocok: tulang jari yang
  // terbaca sebagai telapak tangan akan memuntir seluruh lengan.
  ['LeftHandIndex1', 'mixamorig:LeftHandThumb2', 'Head', 'Neck', 'eye.L',
   'LeftShoulder', 'Camera', 'IK_Target', 'breast.L'].forEach(function (name) {
    var got = R.canonicalOf(name);
    assert(got === null || (name === 'LeftShoulder' && got === null),
      name + ' seharusnya tidak dikenali, dapat ' + got);
  });
});

test('tulang bersisi tanpa penanda sisi ditolak', function () {
  assert(R.canonicalOf('UpperArm') === null, 'UpperArm tanpa sisi seharusnya null');
  assert(R.canonicalOf('Foot') === null, 'Foot tanpa sisi seharusnya null');
});

test('memilih nama terpendek saat beberapa tulang bersaing', function () {
  var map = R.matchBones(['mixamorig:LeftHand', 'mixamorig:LeftHandAdjust', 'Hips']);
  assert(map.LeftHand === 'mixamorig:LeftHand', 'dapat ' + map.LeftHand);
});

test('seluruh 15 tulang terpetakan dari rig Mixamo', function () {
  var map = R.matchBones(Object.keys(MIXAMO).map(function (k) { return MIXAMO[k]; }));
  R.CANONICAL.forEach(function (c) {
    assert(map[c] === MIXAMO[c], c + ' -> ' + map[c] + ', seharusnya ' + MIXAMO[c]);
  });
});

/* ------------------------------------------------------------------ *
 * Matematika
 * ------------------------------------------------------------------ */

section('Pemindahan pose');

test('pose hasil retarget cocok dengan tangkapan sumbernya', function () {
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  var res = R.retarget(capture, rig.mesh.skeleton, { clipName: 'Capture' });
  assert(res && res.clip, 'retarget gagal menghasilkan klip');
  assert(res.matched.length === 15, 'tulang tercocok: ' + res.matched.length);

  // Pose yang DIINGINKAN: simpangan dunia sumber dikalikan rest target.
  var deltas = R._internal.sourceWorldDeltas(capture);
  var restQuat = {};
  rig.mesh.skeleton.bones.forEach(function (b, i) {
    var m = new THREE.Matrix4().copy(rig.mesh.skeleton.boneInverses[i]).invert();
    var q = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    restQuat[b.name] = q;
  });

  var mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(res.clip).play();

  // Frame terakhir TIDAK disampel: pada LoopRepeat, waktu tepat di ujung
  // klip membungkus kembali ke nol dan yang terbaca adalah pose frame 0.
  [0, Math.floor(deltas.length / 2), deltas.length - 2].forEach(function (f) {
    mixer.setTime(capture.tracks[0].times[f]);
    rig.root.updateMatrixWorld(true);
    R.CANONICAL.forEach(function (canon) {
      var d = deltas[f][canon];
      var want = new THREE.Quaternion(d[0], d[1], d[2], d[3])
        .multiply(restQuat[MIXAMO[canon]]);
      var got = worldQuatOf(rig.root, MIXAMO[canon]);
      var off = angleBetween(want, got);
      assert(off < 1.0, 'frame ' + f + ' ' + canon + ' meleset ' + off.toFixed(2) + '°');
    });
  });
});

test('lengan benar-benar berayun di rig tujuan', function () {
  // Kalau hasilnya membeku di rest, test di atas masih bisa lolos saat
  // simpangannya kebetulan kecil. Ini memastikan gerakannya memang ada.
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  var res = R.retarget(capture, rig.mesh.skeleton, {});
  var mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(res.clip).play();

  function handAt(t) {
    mixer.setTime(t);
    rig.root.updateMatrixWorld(true);
    var b = null;
    rig.root.traverse(function (o) { if (o.name === MIXAMO.LeftHand) b = o; });
    return b.getWorldPosition(new THREE.Vector3());
  }
  var times = capture.tracks[0].times;
  var moved = handAt(times[0]).distanceTo(handAt(times[times.length - 2]));
  assert(moved > 0.2, 'tangan nyaris tidak berpindah: ' + moved.toFixed(3));
});

test('proporsi berbeda tidak mengubah rotasi, hanya menskalakan pinggul', function () {
  var capture = P.build(captureFrames(20), {});
  var smallRig = targetRig(capture, 1), bigRig = targetRig(capture, 2);
  var small = R.retarget(capture, smallRig.mesh.skeleton, {});
  var big = R.retarget(capture, bigRig.mesh.skeleton, {});

  assert(Math.abs(big.scale / small.scale - 2) < 0.1,
    'skala seharusnya ~2x, dapat ' + (big.scale / small.scale).toFixed(3));

  var a = trackFor(small, smallRig.root, 'LeftLowerArm', '.quaternion');
  var b = trackFor(big, bigRig.root, 'LeftLowerArm', '.quaternion');
  assert(a && b, 'track lengan tidak ada');
  for (var i = 0; i < a.values.length; i++) {
    assert(Math.abs(a.values[i] - b.values[i]) < 1e-5,
      'rotasi ikut berubah saat proporsi berubah, indeks ' + i);
  }
});

test('pose rest dibaca dari bind, bukan dari pose yang sedang diputar', function () {
  // Ini jebakan yang gampang: membaca bone.matrixWorld saat ada klip
  // berjalan membuat pose animasi terbaca sebagai pose rest, dan seluruh
  // hasilnya miring mengikuti frame yang kebetulan aktif.
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  var before = R.retarget(capture, rig.mesh.skeleton, {});

  var mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(before.clip).play();
  mixer.setTime(capture.duration * 0.5);
  rig.root.updateMatrixWorld(true);

  var after = R.retarget(capture, rig.mesh.skeleton, {});
  assert(before.clip.tracks.length === after.clip.tracks.length, 'jumlah track berubah');
  // SEMUA track dibandingkan, bukan yang pertama saja: di tangkapan uji
  // ini hanya lengan kiri yang bergerak, jadi track pinggul akan sama
  // persis walaupun pose rest-nya salah baca.
  before.clip.tracks.forEach(function (t1, k) {
    var t2 = after.clip.tracks[k];
    assert(t1.name === t2.name, 'urutan track berubah di indeks ' + k);
    for (var i = 0; i < t1.values.length; i++) {
      assert(Math.abs(t1.values[i] - t2.values[i]) < 1e-6,
        'hasil retarget berubah karena pose saat itu: ' + t1.name + '[' + i + ']');
    }
  });
});

test('nama tulang ber-titik dua tetap menghasilkan track yang terpasang', function () {
  // Nama ala Mixamo ("mixamorig:Hips") TIDAK bisa di-resolve
  // PropertyBinding: track-nya diam-diam tidak terpasang, dan
  // GLTFExporter menolak mengekspornya. Jadi setiap nama track harus
  // berupa sesuatu yang benar-benar bisa di-resolve.
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  var res = R.retarget(capture, rig.mesh.skeleton, {});

  res.clip.tracks.forEach(function (t) {
    var node = t.name.slice(0, t.name.lastIndexOf('.'));
    assert(THREE.PropertyBinding.sanitizeNodeName(node) === node,
      'nama track tidak bisa di-resolve: ' + t.name);
    var parsed = THREE.PropertyBinding.parseTrackName(t.name);
    var target = THREE.PropertyBinding.findNode(rig.root, parsed.nodeName);
    assert(target, 'track tidak menemukan node: ' + t.name);
  });
});

section('Rig yang tidak memadai');

test('rig tanpa tulang yang dikenali tidak menghasilkan klip', function () {
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  rig.root.traverse(function (o) { if (o.isBone) o.name = 'bone_' + Math.random(); });
  var res = R.retarget(capture, rig.mesh.skeleton, {});
  assert(res && res.clip === null, 'seharusnya menolak, bukan menghasilkan klip');
  assert(res.missing.length === 15, 'seharusnya semua dilaporkan hilang');
});

test('rig tanpa pinggul ditolak walau anggota badannya lengkap', function () {
  var capture = P.build(captureFrames(20), {});
  var rig = targetRig(capture, 1);
  rig.root.traverse(function (o) { if (o.name === MIXAMO.Hips) o.name = 'akar_tanpa_nama'; });
  var res = R.retarget(capture, rig.mesh.skeleton, {});
  assert(res.clip === null, 'tanpa pinggul tidak ada jangkar, seharusnya ditolak');
  assert(res.missing.indexOf('Hips') !== -1, 'pinggul seharusnya dilaporkan hilang');
});

test('tangkapan kosong tidak melempar', function () {
  var capture = P.build([], {});
  var rig = targetRig(P.build(captureFrames(20), {}), 1);
  assert(R.retarget(capture, rig.mesh.skeleton, {}) === null, 'seharusnya null');
});

console.log('');
if (failed === 0) {
  console.log('✅ ' + passed + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + passed + ' passed, ' + failed + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
