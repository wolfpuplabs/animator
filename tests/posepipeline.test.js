/**
 * Penjaga rig hasil tangkapan video.
 *
 * Yang dijaga di sini terutama satu baris: material.skinning.
 *
 * three r128 hanya menerapkan skinning kalau material.skinning true
 * (WebGLRenderer: `object.isSkinnedMesh && material.skinning`), dan
 * defaultnya false. GLTFLoader menyalakannya sendiri, jadi model yang
 * diunggah beranimasi normal; material yang dibuat tangan tidak.
 *
 * Tanpa baris itu SEMUANYA tampak benar — tulang berputar, klipnya penuh,
 * GLB-nya mengandung skin dan animasi — tapi mesh-nya membeku di bind
 * pose. Satu-satunya gejalanya adalah sosok yang diam di layar.
 */

var path = require('path');
global.THREE = require(path.join(__dirname, '..', 'node_modules', 'three'));
var THREE = global.THREE;
global.self = global;

var P = require(path.join(__dirname, '..', 'js', 'posemocap.js'));
require(path.join(__dirname, '..', 'js', 'posepipeline.js'));
var Pipeline = global.PosePipeline;

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

/** Orang berdiri; lengan kiri turun dari mendatar ke bawah. */
function frames(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = (i / (n - 1)) * Math.PI / 2;
    var lm = [];
    for (var k = 0; k < 33; k++) lm[k] = { x: 0, y: 0, z: 0, visibility: 1 };
    var put = function (idx, x, y, z) { lm[idx] = { x: x, y: y, z: z, visibility: 1 }; };
    put(P.LM.leftHip, 0.1, 0, 0);       put(P.LM.rightHip, -0.1, 0, 0);
    put(P.LM.leftShoulder, 0.18, -0.5, 0); put(P.LM.rightShoulder, -0.18, -0.5, 0);
    put(P.LM.leftEar, 0.07, -0.75, 0);  put(P.LM.rightEar, -0.07, -0.75, 0);
    put(P.LM.nose, 0, -0.72, 0.08);
    put(P.LM.leftElbow, 0.18 + 0.27 * Math.cos(a), -0.5 + 0.27 * Math.sin(a), 0);
    put(P.LM.leftWrist, 0.18 + 0.52 * Math.cos(a), -0.5 + 0.52 * Math.sin(a), 0);
    put(P.LM.leftIndex, 0.18 + 0.60 * Math.cos(a), -0.5 + 0.60 * Math.sin(a), 0);
    put(P.LM.rightElbow, -0.45, -0.5, 0); put(P.LM.rightWrist, -0.70, -0.5, 0);
    put(P.LM.rightIndex, -0.78, -0.5, 0);
    put(P.LM.leftKnee, 0.1, 0.45, 0);   put(P.LM.leftAnkle, 0.1, 0.9, 0);
    put(P.LM.leftFootIndex, 0.1, 0.95, -0.15);
    put(P.LM.rightKnee, -0.1, 0.45, 0); put(P.LM.rightAnkle, -0.1, 0.9, 0);
    put(P.LM.rightFootIndex, -0.1, 0.95, -0.15);
    out.push({ time: i / 20, landmarks: lm });
  }
  return out;
}

function buildRig() {
  return Pipeline.buildRig(P.build(frames(20), {}), { name: 'Uji', clipName: 'Capture' });
}

console.log('\nRig hasil tangkapan');

test('rig terbentuk dengan mesh, skeleton, dan klip', function () {
  var rig = buildRig();
  assert(rig, 'buildRig mengembalikan null');
  assert(rig.mesh && rig.mesh.isSkinnedMesh, 'mesh bukan SkinnedMesh');
  assert(rig.mesh.skeleton && rig.mesh.skeleton.bones.length === 15,
    'jumlah tulang tidak sesuai');
  assert(rig.clip && rig.clip.tracks.length === 16, 'jumlah track tidak sesuai');
});

test('material menyalakan skinning', function () {
  var rig = buildRig();
  // Baris inilah yang dulu hilang dan membuat sosoknya membeku.
  assert(rig.mesh.material.skinning === true,
    'material.skinning harus true di three r128, dapat ' + rig.mesh.material.skinning);
});

console.log('\nPose benar-benar berubah');

test('posisi dunia tulang berubah seiring waktu klip', function () {
  var rig = buildRig();
  var mixer = new THREE.AnimationMixer(rig.root);
  mixer.clipAction(rig.clip).play();

  function handAt(t) {
    mixer.setTime(t);
    rig.root.updateMatrixWorld(true);
    var hand = null;
    rig.root.traverse(function (o) { if (o.name === 'LeftHand') hand = o; });
    assert(hand, 'tulang LeftHand tidak ditemukan');
    return hand.getWorldPosition(new THREE.Vector3());
  }

  var a = handAt(0);
  var b = handAt(rig.clip.duration * 0.5);
  var moved = a.distanceTo(b);
  assert(moved > 0.1, 'tangan nyaris tidak berpindah: ' + moved.toFixed(4));
});

test('geometri rig ikut punya atribut skin', function () {
  var rig = buildRig();
  var attrs = rig.mesh.geometry.attributes;
  assert(attrs.skinIndex && attrs.skinWeight, 'atribut skin tidak ada');
  assert(attrs.skinIndex.count === attrs.position.count,
    'jumlah skinIndex tidak cocok dengan jumlah vertex');
});

console.log('');
if (failed === 0) {
  console.log('✅ ' + passed + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + passed + ' passed, ' + failed + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
