/**
 * Penjaga pemasangan rangka otomatis.
 *
 * Modul ini MENEBAK. Jadi yang dijaga ada dua hal yang sama pentingnya,
 * dan yang kedua justru lebih gampang terlewat:
 *
 *   1. Kalau bentuknya memang humanoid berdiri, tebakannya harus dekat.
 *      Diukur terhadap rangka yang posisinya SUDAH DIKETAHUI — mesh
 *      avatar bawaan, yang tulangnya dibuang dulu. Tidak ada cara lain
 *      mengetahui apakah tebakannya benar; melihat hasilnya cuma
 *      memberi tahu apakah dia kelihatan masuk akal.
 *
 *   2. Kalau bentuknya BUKAN humanoid berdiri, dia harus MENOLAK.
 *      Rangka yang sendinya meleset melipat mesh di tempat yang bukan
 *      sendi, dan pengguna lebih tertolong oleh penolakan yang
 *      menyebut alasannya daripada oleh sosok yang rusak tanpa
 *      penjelasan. Penolakan yang tidak diuji akan diam-diam berhenti
 *      bekerja.
 */

var path = require('path');
global.THREE = require(path.join(__dirname, '..', 'node_modules', 'three'));
var THREE = global.THREE;
global.self = global;

var Avatar = require(path.join(__dirname, '..', 'js', 'avatar.js'));
var AR = require(path.join(__dirname, '..', 'js', 'autorig.js'));
var R = require(path.join(__dirname, '..', 'js', 'retarget.js'));

var passed = 0, failed = 0, failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function section(n) { console.log('\n' + n); }
function info(s) { console.log('      ' + s); }

/* ------------------------------------------------------------------ *
 * Bahan uji
 * ------------------------------------------------------------------ */

/** Titik-titik mesh avatar pada bind pose — sebuah patung, tanpa tulang. */
function avatarPoints() {
  var a = Avatar.build({});
  var pos = a.mesh.geometry.attributes.position;
  var pts = new Float32Array(pos.count * 3);
  for (var i = 0; i < pos.count; i++) {
    pts[i * 3] = pos.getX(i);
    pts[i * 3 + 1] = pos.getY(i);
    pts[i * 3 + 2] = pos.getZ(i);
  }
  return pts;
}

/** Posisi dunia tiap tulang avatar — kebenaran acuannya. */
function avatarTruth() {
  var a = Avatar.build({});
  a.root.updateMatrixWorld(true);
  var truth = {};
  a.skeleton.bones.forEach(function (b) {
    truth[b.name] = b.getWorldPosition(new THREE.Vector3());
  });
  return truth;
}

/** Patung: mesh avatar dengan atribut skin dan skeleton dibuang. */
function statue() {
  var a = Avatar.build({});
  var geom = a.mesh.geometry.clone();
  geom.deleteAttribute('skinIndex');
  geom.deleteAttribute('skinWeight');
  var group = new THREE.Group();
  group.name = 'Patung';
  var mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.name = 'Body';
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

/** Awan titik dari sebuah geometri, untuk bentuk yang harus ditolak. */
function pointsOf(geometry) {
  var pos = geometry.attributes.position;
  var pts = new Float32Array(pos.count * 3);
  for (var i = 0; i < pos.count; i++) {
    pts[i * 3] = pos.getX(i);
    pts[i * 3 + 1] = pos.getY(i);
    pts[i * 3 + 2] = pos.getZ(i);
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * 1. Tebakannya dekat
 * ------------------------------------------------------------------ */

section('Tebakan diukur terhadap rangka yang sudah diketahui');

var pts = avatarPoints();
var res = AR.analyse(pts, {});
var truth = avatarTruth();

test('sosok humanoid diterima', function () {
  assert(res.ok, 'ditolak: ' + res.reason);
});

test('patokan yang TERUKUR jatuh di tempat yang benar', function () {
  // Tiga ini dibaca dari bentuk, bukan dari proporsi hafalan, jadi
  // ketelitiannya memang harus dituntut lebih tinggi daripada sisanya.
  var L = res.landmarks;
  var H = L.height;
  var t = truth;
  var shoulderTruth = t.LeftUpperArm.y;
  info('tinggi bahu: tebak ' + L.shoulderY.toFixed(3) +
    ', sebenarnya ' + shoulderTruth.toFixed(3));
  assert(Math.abs(L.shoulderY - shoulderTruth) < H * 0.02,
    'tinggi bahu meleset ' + (Math.abs(L.shoulderY - shoulderTruth) / H * 100).toFixed(1) + '%');

  info('rentang lengan: ' + L.armSpan.toFixed(3) +
    ' (' + (L.armSpan / H).toFixed(2) + '× tinggi)');
  assert(L.armSpan > H * 0.8, 'rentang lengan pose T terbaca terlalu sempit');
});

test('tiap sendi meleset kurang dari 5% tinggi badan', function () {
  var H = res.landmarks.height;
  var worst = 0, worstName = '', sum = 0, count = 0;
  res.joints.forEach(function (j) {
    var t = truth[j[0]];
    if (!t) return;
    var d = Math.sqrt(
      Math.pow(j[1][0] - t.x, 2) + Math.pow(j[1][1] - t.y, 2) + Math.pow(j[1][2] - t.z, 2));
    var pct = d / H * 100;
    sum += pct; count++;
    if (pct > worst) { worst = pct; worstName = j[0]; }
  });
  info('meleset rata-rata ' + (sum / count).toFixed(2) + '%, terburuk ' +
    worst.toFixed(1) + '% (' + worstName + ')');
  assert(worst < 5, 'terburuk ' + worst.toFixed(1) + '% di ' + worstName);
  assert(sum / count < 3, 'rata-rata ' + (sum / count).toFixed(2) + '%');
});

test('nama tulangnya kanonik, jadi retarget langsung mengenalinya', function () {
  var names = res.joints.map(function (j) { return j[0]; });
  var map = R.matchBones(names);
  var matched = R.CANONICAL.filter(function (c) { return map[c]; });
  info(matched.length + ' dari ' + R.CANONICAL.length + ' tulang kanonik dikenali');
  assert(matched.length === R.CANONICAL.length,
    'cuma ' + matched.length + ' yang dikenali');
});

test('tiap tulang punya induk yang benar-benar ada', function () {
  var names = {};
  res.joints.forEach(function (j) { names[j[0]] = 1; });
  res.joints.forEach(function (j) {
    var p = AR.PARENT[j[0]];
    if (p !== null && p !== undefined) {
      assert(names[p], j[0] + ' menunjuk induk tak dikenal: ' + p);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Yang bukan humanoid harus DITOLAK
 * ------------------------------------------------------------------ */

section('Bentuk yang bukan sosok berdiri ditolak, bukan dipaksakan');

function rejects(name, geometry) {
  test(name + ' ditolak', function () {
    var out = AR.analyse(pointsOf(geometry), {});
    info(out.ok ? 'DITERIMA (seharusnya tidak)' : 'alasan: ' + out.reason);
    assert(!out.ok, 'diterima sebagai sosok humanoid');
    assert(out.reason && out.reason.length > 10, 'alasannya tidak dijelaskan');
  });
}

rejects('bola', new THREE.SphereGeometry(1, 32, 24));
rejects('kotak', new THREE.BoxGeometry(1, 2, 1, 12, 24, 12));
rejects('tabung tegak tanpa lengan', new THREE.CylinderGeometry(0.3, 0.3, 2, 24, 40));
rejects('bidang datar', new THREE.PlaneGeometry(2, 2, 24, 24));

test('awan titik yang terlalu kecil ditolak', function () {
  var out = AR.analyse(new Float32Array([0, 0, 0, 1, 1, 1]), {});
  assert(!out.ok, 'diterima');
  assert(/vertex/.test(out.reason), 'alasannya tidak menyebut jumlah vertex: ' + out.reason);
});

test('sosok terbalik ditolak', function () {
  // Dibalik: lengan jadi di 20% tinggi, bukan 80%. Rangka yang
  // dipaksakan ke sini akan menaruh kepala di kaki.
  var flipped = new Float32Array(pts.length);
  for (var i = 0; i < pts.length; i += 3) {
    flipped[i] = pts[i];
    flipped[i + 1] = -pts[i + 1];
    flipped[i + 2] = pts[i + 2];
  }
  var out = AR.analyse(flipped, {});
  info(out.ok ? 'DITERIMA (seharusnya tidak)' : 'alasan: ' + out.reason);
  assert(!out.ok, 'sosok terbalik diterima');
});

/* ------------------------------------------------------------------ *
 * 3. Pengukuran tidak boleh menimpa perkiraan sejauh-jauhnya
 * ------------------------------------------------------------------ */

section('Selangkangan: diukur kalau masuk akal, diperkirakan kalau tidak');

test('hasil pengukuran di luar rentang humanoid tidak dipakai', function () {
  // Ini pagar yang dibayar mahal. Pada V-Bot sungguhan, deteksi celah
  // berakhir di 16–32% tinggi tergantung derau panel di paha,
  // sementara selangkangannya jelas di sekitar 50%. Ruang antar-
  // tungkai memang kosong di tengah — itu BUKAN selangkangan.
  var L = res.landmarks;
  var rel = (L.crotchY - L.floor) / L.height;
  info('selangkangan di ' + (rel * 100).toFixed(0) + '% tinggi, ' +
    (L.crotchMeasured ? 'terukur' : 'diperkirakan'));
  assert(rel > 0.33 && rel < 0.62,
    'selangkangan di ' + (rel * 100).toFixed(0) + '% — di luar rentang yang mungkin');
});

/**
 * Sosok bertungkai MENGUNCUP: telapak kaki berjauhan, paha rapat.
 *
 * Ini tiruan setia dari cara V-Bot sungguhan menjebak modul ini. Celah
 * antar-tungkainya bersih dan jelas — lalu habis di 18% tinggi, karena
 * di atas situ pahanya sudah bersentuhan. Selangkangannya sendiri ada
 * di 50%. Detektor celah yang dipercaya mentah-mentah akan menaruh
 * pinggulnya sepertiga badan terlalu rendah, dan seluruh rig ikut
 * melar.
 */
function taperedLegFigure() {
  var pts = [];
  function ring(cx, cz, y, r, n) {
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2;
      pts.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
    }
  }
  var H = 1.8;
  // tungkai: pusatnya menguncup dari ±0,28 di lantai ke ±0,10 di 0,35
  for (var y = 0; y < 0.90; y += 0.02) {
    var t = Math.min(1, y / 0.35);
    var cx = 0.28 + (0.10 - 0.28) * t;
    ring(cx, 0, y, 0.09, 16);
    ring(-cx, 0, y, 0.09, 16);
  }
  // badan dari selangkangan ke bahu
  for (y = 0.90; y < 1.44; y += 0.02) ring(0, 0, y, 0.20, 20);
  // lengan terentang pada 1,44
  for (var x = 0.20; x < 0.92; x += 0.02) {
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      pts.push(x, 1.44 + Math.cos(a) * 0.07, Math.sin(a) * 0.07);
      pts.push(-x, 1.44 + Math.cos(a) * 0.07, Math.sin(a) * 0.07);
    }
  }
  // leher dan kepala
  for (y = 1.44; y < 1.54; y += 0.02) ring(0, 0, y, 0.06, 12);
  for (y = 1.54; y <= H; y += 0.02) ring(0, 0, y, 0.11, 14);
  return { points: new Float32Array(pts), height: H, trueCrotch: 0.90 };
}

test('celah tungkai yang habis terlalu rendah tidak dipercaya', function () {
  var fig = taperedLegFigure();
  var out = AR.analyse(fig.points, {});
  assert(out.ok, 'ditolak: ' + out.reason);
  var L = out.landmarks;
  var rel = (L.crotchY - L.floor) / L.height;
  var trueRel = fig.trueCrotch / fig.height;
  info('selangkangan: tebak ' + (rel * 100).toFixed(0) + '%, sebenarnya ' +
    (trueRel * 100).toFixed(0) + '% — ' + (L.crotchMeasured ? 'terukur' : 'diperkirakan'));
  // Celahnya habis di sekitar 18%; kalau hasil itu dipercaya mentah,
  // angkanya akan jauh di bawah 33%.
  assert(rel > 0.33, 'selangkangan terbaca di ' + (rel * 100).toFixed(0) +
    '% — detektor celah dipercaya mentah-mentah');
  assert(Math.abs(rel - trueRel) < 0.1,
    'meleset ' + (Math.abs(rel - trueRel) * 100).toFixed(0) + '% dari yang sebenarnya');
});

test('apakah angkanya terukur atau diperkirakan ikut dilaporkan', function () {
  // Pengguna berhak tahu mana yang dibaca dari modelnya dan mana yang
  // ditebak dari proporsi. Tanpa ini keduanya terlihat sama pastinya.
  var L = res.landmarks;
  assert(typeof L.crotchMeasured === 'boolean', 'crotchMeasured tidak dilaporkan');
  assert(typeof L.neckMeasured === 'boolean', 'neckMeasured tidak dilaporkan');
});

/* ------------------------------------------------------------------ *
 * 4. Rig yang jadi
 * ------------------------------------------------------------------ */

section('Rig yang terpasang benar-benar bisa dipakai');

test('patung berubah jadi SkinnedMesh ber-skeleton', function () {
  var group = statue();
  var before = 0, bonesBefore = 0;
  group.traverse(function (o) {
    if (o.isSkinnedMesh) before++;
    if (o.isBone) bonesBefore++;
  });
  assert(before === 0 && bonesBefore === 0, 'patungnya sudah ber-rig sejak awal');

  var out = AR.fit(group, {});
  assert(out.ok, 'gagal: ' + out.reason);

  var after = 0, bonesAfter = 0;
  group.traverse(function (o) {
    if (o.isSkinnedMesh) after++;
    if (o.isBone) bonesAfter++;
  });
  info(after + ' SkinnedMesh, ' + bonesAfter + ' tulang');
  assert(after === 1, 'mesh tidak diganti jadi SkinnedMesh');
  assert(bonesAfter === out.bones.length, 'jumlah tulang di scene tidak cocok');
});

test('bobot skin ternormalisasi dan tidak ada vertex yatim', function () {
  var group = statue();
  var out = AR.fit(group, {});
  assert(out.ok, out.reason);
  var geom = out.meshes[0].geometry;
  var w = geom.attributes.skinWeight, idx = geom.attributes.skinIndex;
  var worst = 0, orphan = 0, bad = 0;
  for (var i = 0; i < w.count; i++) {
    var sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
    worst = Math.max(worst, Math.abs(sum - 1));
    if (sum < 1e-6) orphan++;
    [idx.getX(i), idx.getY(i), idx.getZ(i), idx.getW(i)].forEach(function (v) {
      if (v < 0 || v >= out.bones.length) bad++;
    });
  }
  info(w.count + ' vertex, error jumlah maks ' + worst.toExponential(1) +
    ', yatim ' + orphan + ', indeks di luar jangkauan ' + bad);
  assert(worst < 1e-3, 'bobot tidak ternormalisasi: ' + worst);
  assert(orphan === 0, orphan + ' vertex tanpa tulang');
  assert(bad === 0, bad + ' indeks tulang di luar jangkauan');
});

test('skinIndex menunjuk tulang yang benar lewat urutan skeleton', function () {
  // Jebakan yang gampang: skinIndex menunjuk POSISI di skeleton.bones,
  // bukan nama. Kalau urutan segmen yang dipakai menghitung bobot
  // berbeda dari urutan tulang di Skeleton, setiap vertex terikat ke
  // tulang yang salah — dan hasilnya tetap terlihat seperti rig yang
  // sah sampai seseorang memutarnya.
  var group = statue();
  var out = AR.fit(group, {});
  assert(out.ok, out.reason);
  var segs = AR.boneSegments(out.joints);
  assert(segs.length === out.bones.length, 'jumlah segmen dan tulang beda');
  for (var i = 0; i < segs.length; i++) {
    assert(segs[i].name === out.bones[i].name,
      'urutan ke-' + i + ': segmen ' + segs[i].name + ' vs tulang ' + out.bones[i].name);
  }
});

test('tangkapan video bisa dipindahkan ke rig hasil pasangan ini', function () {
  var group = statue();
  var out = AR.fit(group, {});
  assert(out.ok, out.reason);

  var skeleton = R.findSkeleton(group);
  assert(skeleton, 'retarget tidak menemukan skeleton');

  var P = require(path.join(__dirname, '..', 'js', 'posemocap.js'));
  var frames = [];
  for (var i = 0; i < 24; i++) {
    var ang = (i / 23) * Math.PI / 2;
    var lm = [];
    for (var k = 0; k < 33; k++) lm[k] = { x: 0, y: 0, z: 0, visibility: 1 };
    var put = function (ix, x, y, z) { lm[ix] = { x: x, y: y, z: z, visibility: 1 }; };
    put(P.LM.leftHip, 0.1, 0, 0); put(P.LM.rightHip, -0.1, 0, 0);
    put(P.LM.leftShoulder, 0.18, -0.5, 0); put(P.LM.rightShoulder, -0.18, -0.5, 0);
    put(P.LM.leftEar, 0.07, -0.75, 0); put(P.LM.rightEar, -0.07, -0.75, 0);
    put(P.LM.nose, 0, -0.72, 0.08);
    put(P.LM.leftElbow, 0.18 + 0.27 * Math.cos(ang), -0.5 + 0.27 * Math.sin(ang), 0);
    put(P.LM.leftWrist, 0.18 + 0.52 * Math.cos(ang), -0.5 + 0.52 * Math.sin(ang), 0);
    put(P.LM.leftIndex, 0.18 + 0.60 * Math.cos(ang), -0.5 + 0.60 * Math.sin(ang), 0);
    put(P.LM.rightElbow, -0.45, -0.5, 0); put(P.LM.rightWrist, -0.70, -0.5, 0);
    put(P.LM.rightIndex, -0.78, -0.5, 0);
    put(P.LM.leftKnee, 0.1, 0.45, 0); put(P.LM.leftAnkle, 0.1, 0.9, 0);
    put(P.LM.leftFootIndex, 0.1, 0.95, -0.15);
    put(P.LM.rightKnee, -0.1, 0.45, 0); put(P.LM.rightAnkle, -0.1, 0.9, 0);
    put(P.LM.rightFootIndex, -0.1, 0.95, -0.15);
    frames.push({ time: i / 24, landmarks: lm });
  }

  var capture = P.build(frames, {});
  var moved = R.retarget(capture, skeleton, { clipName: 'Capture' });
  assert(moved && moved.clip, 'retarget gagal');
  info(moved.matched.length + ' dari 15 tulang tercocok');
  assert(moved.matched.length === 15, 'cuma ' + moved.matched.length + ' tercocok');

  // Dan dagingnya benar-benar ikut bergerak, bukan cuma tulangnya.
  var skinned = out.meshes[0];
  var mixer = new THREE.AnimationMixer(group);
  mixer.clipAction(moved.clip).play();
  function vertexAt(t) {
    mixer.setTime(t);
    group.updateMatrixWorld(true);
    skinned.skeleton.update();
    var best = 0, bestD = -Infinity;
    var p = skinned.geometry.attributes.position;
    // vertex paling kiri: ujung tangan, bagian yang paling jauh berayun
    for (var i = 0; i < p.count; i++) if (p.getX(i) > bestD) { bestD = p.getX(i); best = i; }
    var v = new THREE.Vector3().fromBufferAttribute(p, best);
    skinned.applyBoneTransform(best, v);
    return v;
  }
  var d = vertexAt(0).distanceTo(vertexAt(capture.duration * 0.9));
  info('ujung tangan berpindah ' + d.toFixed(3) + ' m');
  assert(d > 0.1, 'dagingnya nyaris tidak bergerak: ' + d.toFixed(3) + ' m');
});

test('model yang sudah punya tulang tidak disentuh', function () {
  var a = Avatar.build({});
  var out = AR.fit(a.root, {});
  info(out.ok ? 'DIPROSES (seharusnya tidak)' : 'alasan: ' + out.reason);
  assert(!out.ok, 'model ber-rig ikut diproses ulang');
  assert(/mesh/.test(out.reason), 'alasannya tidak jelas: ' + out.reason);
});

console.log('');
if (failed === 0) {
  console.log('✅ ' + passed + ' passed, 0 failed\n');
} else {
  console.log('❌ ' + passed + ' passed, ' + failed + ' failed\n');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
