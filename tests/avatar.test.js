/**
 * Penjaga avatar contoh bawaan.
 *
 * Yang dijaga di sini bukan "apakah bentuknya bagus" — itu urusan mata,
 * dan ada screenshot untuk itu. Yang dijaga adalah hal-hal yang kalau
 * rusak tidak kelihatan sampai seseorang mencoba memakainya:
 *
 *   - tulangnya bernama kanonik, jadi retarget bisa memetakannya
 *   - tulang hiasan TIDAK ikut terpetakan
 *   - bobot skin ternormalisasi dan membaur di sambungan
 *   - klipnya memang mengandung cacat yang harus dibereskan engine
 */

var path = require('path');
global.THREE = require(path.join(__dirname, '..', 'node_modules', 'three'));
var THREE = global.THREE;
global.self = global;

var Avatar = require(path.join(__dirname, '..', 'js', 'avatar.js'));
var R = require(path.join(__dirname, '..', 'js', 'retarget.js'));

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function section(n) { console.log('\n' + n); }

section('Rangka');

test('avatar terbentuk dengan skeleton dan klip', function () {
  var a = Avatar.build({});
  assert(a && a.root && a.mesh && a.clip, 'bagian utama tidak lengkap');
  assert(a.mesh.isSkinnedMesh, 'mesh bukan SkinnedMesh');
  assert(a.skeleton.bones.length === Avatar.SKELETON.length,
    'jumlah tulang tidak sesuai: ' + a.skeleton.bones.length);
});

test('seluruh 15 tulang kanonik bisa dipetakan retarget', function () {
  var a = Avatar.build({});
  var map = R.matchBones(a.boneNames);
  R.CANONICAL.forEach(function (c) {
    assert(map[c], c + ' tidak terpetakan');
  });
});

test('tulang hiasan tidak ikut terpetakan', function () {
  // Leher, kepala, bahu dan jari kaki tidak punya data yang bisa
  // dipercaya dari deteksi pose. Kalau ikut terpetakan, mereka akan
  // digerakkan oleh tebakan.
  ['Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftToe', 'RightToe']
    .forEach(function (name) {
      assert(R.canonicalOf(name) === null,
        name + ' seharusnya tidak dikenali, dapat ' + R.canonicalOf(name));
    });
});

test('tiap tulang punya induk yang benar-benar ada', function () {
  var names = {};
  Avatar.SKELETON.forEach(function (b) { names[b.name] = 1; });
  Avatar.SKELETON.forEach(function (b) {
    if (b.parent !== null) assert(names[b.parent], b.name + ' menunjuk induk tak dikenal: ' + b.parent);
  });
});

section('Daging');

test('bobot skin ternormalisasi', function () {
  var a = Avatar.build({});
  var w = a.mesh.geometry.attributes.skinWeight;
  for (var i = 0; i < w.count; i++) {
    var sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
    assert(Math.abs(sum - 1) < 1e-4, 'vertex ' + i + ' berjumlah ' + sum.toFixed(4));
  }
});

test('indeks skin menunjuk tulang yang ada', function () {
  var a = Avatar.build({});
  var idx = a.mesh.geometry.attributes.skinIndex;
  var n = a.skeleton.bones.length;
  for (var i = 0; i < idx.count; i++) {
    [idx.getX(i), idx.getY(i), idx.getZ(i), idx.getW(i)].forEach(function (v) {
      assert(v >= 0 && v < n, 'vertex ' + i + ' menunjuk tulang ' + v);
    });
  }
});

test('sambungan membaur ke dua tulang', function () {
  // Tanpa pembauran, sikut dan lutut terlipat seperti sedotan. Jadi
  // harus ada vertex yang bobotnya terbagi, bukan 1.0 semua.
  var a = Avatar.build({});
  var w = a.mesh.geometry.attributes.skinWeight;
  var blended = 0;
  for (var i = 0; i < w.count; i++) if (w.getY(i) > 0.05) blended++;
  assert(blended > w.count * 0.15,
    'cuma ' + blended + ' dari ' + w.count + ' vertex yang membaur');
});

test('proporsinya seperti orang berdiri', function () {
  var a = Avatar.build({});
  a.root.updateMatrixWorld(true);
  var box = new THREE.Box3().setFromObject(a.root);
  var h = box.max.y - box.min.y;
  var d = box.max.z - box.min.z;
  assert(h > 1.5 && h < 2.0, 'tinggi di luar akal: ' + h.toFixed(2));
  // Pose rest-nya T, jadi lebar memang melebihi tinggi. Yang diperiksa
  // ketebalannya: sosok yang pipih berarti dagingnya tidak terbentuk.
  assert(d > 0.2 && d < 0.6, 'ketebalan di luar akal: ' + d.toFixed(2));
});

section('Klip contoh');

test('klip memakai sample rate rendah dan berdurasi wajar', function () {
  var a = Avatar.build({});
  assert(a.clip.duration > 1 && a.clip.duration < 5, 'durasi: ' + a.clip.duration);
  var track = a.clip.tracks[0];
  var dt = track.times[1] - track.times[0];
  assert(Math.abs(dt - 0.125) < 1e-4, 'bukan 8 fps: dt = ' + dt);
});

test('klip memang mengandung quaternion yang dibalik tandanya', function () {
  // Itu justru gunanya contoh bawaan: memberi engine sesuatu untuk
  // dibereskan. Kalau cacatnya hilang, demonya kehilangan maksudnya.
  var a = Avatar.build({});
  var flips = 0;
  a.clip.tracks.forEach(function (t) {
    if (t.values.length % 4 !== 0 || !/quaternion$/.test(t.name)) return;
    for (var i = 4; i < t.values.length; i += 4) {
      var dot = 0;
      for (var k = 0; k < 4; k++) dot += t.values[i - 4 + k] * t.values[i + k];
      if (dot < 0) flips++;
    }
  });
  assert(flips > 0, 'tidak ada hemisphere yang dibalik — demonya kehilangan maksudnya');
});

test('track klip menunjuk tulang yang benar-benar ada', function () {
  var a = Avatar.build({});
  a.clip.tracks.forEach(function (t) {
    var parsed = THREE.PropertyBinding.parseTrackName(t.name);
    var node = THREE.PropertyBinding.findNode(a.root, parsed.nodeName);
    assert(node, 'track tidak menemukan node: ' + t.name);
  });
});

section('Bisa jadi sasaran retarget');

test('tangkapan bisa dipindahkan ke avatar ini', function () {
  var P = require(path.join(__dirname, '..', 'js', 'posemocap.js'));
  var frames = [];
  for (var i = 0; i < 20; i++) {
    var ang = (i / 19) * Math.PI / 2;
    var lm = [];
    for (var k = 0; k < 33; k++) lm[k] = { x: 0, y: 0, z: 0, visibility: 1 };
    var put = function (idx, x, y, z) { lm[idx] = { x: x, y: y, z: z, visibility: 1 }; };
    put(P.LM.leftHip, 0.1, 0, 0);          put(P.LM.rightHip, -0.1, 0, 0);
    put(P.LM.leftShoulder, 0.18, -0.5, 0); put(P.LM.rightShoulder, -0.18, -0.5, 0);
    put(P.LM.leftEar, 0.07, -0.75, 0);     put(P.LM.rightEar, -0.07, -0.75, 0);
    put(P.LM.nose, 0, -0.72, 0.08);
    put(P.LM.leftElbow, 0.18 + 0.27 * Math.cos(ang), -0.5 + 0.27 * Math.sin(ang), 0);
    put(P.LM.leftWrist, 0.18 + 0.52 * Math.cos(ang), -0.5 + 0.52 * Math.sin(ang), 0);
    put(P.LM.leftIndex, 0.18 + 0.60 * Math.cos(ang), -0.5 + 0.60 * Math.sin(ang), 0);
    put(P.LM.rightElbow, -0.45, -0.5, 0);  put(P.LM.rightWrist, -0.70, -0.5, 0);
    put(P.LM.rightIndex, -0.78, -0.5, 0);
    put(P.LM.leftKnee, 0.1, 0.45, 0);      put(P.LM.leftAnkle, 0.1, 0.9, 0);
    put(P.LM.leftFootIndex, 0.1, 0.95, -0.15);
    put(P.LM.rightKnee, -0.1, 0.45, 0);    put(P.LM.rightAnkle, -0.1, 0.9, 0);
    put(P.LM.rightFootIndex, -0.1, 0.95, -0.15);
    frames.push({ time: i / 20, landmarks: lm });
  }
  var capture = P.build(frames, {});
  var a = Avatar.build({});
  var out = R.retarget(capture, a.skeleton, { clipName: 'Capture' });
  assert(out && out.clip, 'retarget gagal');
  assert(out.matched.length === 15, 'tercocok ' + out.matched.length + ' dari 15');

  // Dan hasilnya benar-benar menggerakkan avatar.
  var mixer = new THREE.AnimationMixer(a.root);
  mixer.clipAction(out.clip).play();
  function handAt(time) {
    mixer.setTime(time);
    a.root.updateMatrixWorld(true);
    var b = null;
    a.root.traverse(function (o) { if (o.name === 'LeftHand') b = o; });
    return b.getWorldPosition(new THREE.Vector3());
  }
  var times = capture.tracks[0].times;
  var moved = handAt(times[0]).distanceTo(handAt(times[times.length - 2]));
  assert(moved > 0.15, 'tangan avatar nyaris tidak berpindah: ' + moved.toFixed(3));
});

console.log('');
if (failed === 0) {
  console.log('✅ ' + passed + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + passed + ' passed, ' + failed + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
