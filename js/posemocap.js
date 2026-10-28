/*
 * posemocap.js — ubah titik sendi hasil deteksi pose jadi animasi tulang.
 *
 * Masukannya daftar frame berisi 33 landmark bergaya MediaPipe Pose
 * (koordinat dunia, satuan meter, titik asal di antara kedua pinggul).
 * Keluarannya definisi skeleton dan kumpulan track rotasi — format yang
 * sama dengan yang dipakai engine MFS 5, jadi hasilnya bisa langsung
 * dibersihkan oleh pipeline yang sudah ada.
 *
 * Soal kualitas, supaya jelas sejak awal: deteksi pose memberi POSISI
 * sendi, bukan rotasi tulang. Rotasi di sini disimpulkan dengan
 * mengarahkan tiap tulang ke sendi anaknya, dan putaran sumbu panjangnya
 * (twist) ditebak dari sumbu bahu atau pinggul. Siku yang terpelintir dan
 * pergelangan yang berputar tidak akan terekam benar. Ini alat previz,
 * bukan pengganti mocap sungguhan.
 *
 * Tidak bergantung pada three.js maupun MediaPipe — array angka biasa.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.PoseMocap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-8;

  /* ------------------------------------------------------------------ *
   * Indeks landmark MediaPipe Pose
   * ------------------------------------------------------------------ */

  var LM = {
    nose: 0,
    leftEar: 7, rightEar: 8,
    leftShoulder: 11, rightShoulder: 12,
    leftElbow: 13, rightElbow: 14,
    leftWrist: 15, rightWrist: 16,
    leftIndex: 19, rightIndex: 20,
    leftHip: 23, rightHip: 24,
    leftKnee: 25, rightKnee: 26,
    leftAnkle: 27, rightAnkle: 28,
    leftFootIndex: 31, rightFootIndex: 32
  };

  /* ------------------------------------------------------------------ *
   * Vektor & quaternion (array [x,y,z] dan [x,y,z,w])
   * ------------------------------------------------------------------ */

  function v3(x, y, z) { return [x || 0, y || 0, z || 0]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function mid(a, b) { return scale(add(a, b), 0.5); }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function length(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) {
    var l = length(a);
    return l < EPS ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l];
  }

  function qMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  function qConj(a) { return [-a[0], -a[1], -a[2], a[3]]; }
  function qNormalize(q) {
    var l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    return l < EPS ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  /**
   * Quaternion dari basis ortonormal.
   *
   * Tulang diarahkan sepanjang sumbu Y lokalnya; `aim` jadi sumbu Y, dan
   * `hint` dipakai untuk menetapkan putaran sumbu panjangnya. Tanpa hint,
   * twist-nya sembarang dan anggota badan akan berputar acak antar-frame.
   */
  function basisQuaternion(aim, hint) {
    var y = normalize(aim);
    var ref = normalize(hint);

    // kalau hint hampir sejajar dengan aim, pilih sumbu lain
    if (Math.abs(dot(y, ref)) > 0.99) {
      ref = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    }

    var z = normalize(cross(ref, y));
    var x = normalize(cross(y, z));

    // matriks kolom [x y z] -> quaternion
    var m00 = x[0], m01 = y[0], m02 = z[0];
    var m10 = x[1], m11 = y[1], m12 = z[1];
    var m20 = x[2], m21 = y[2], m22 = z[2];
    var trace = m00 + m11 + m22;
    var q, s;

    if (trace > 0) {
      s = 0.5 / Math.sqrt(trace + 1);
      q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
    } else if (m00 > m11 && m00 > m22) {
      s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
    }
    return qNormalize(q);
  }

  /* ------------------------------------------------------------------ *
   * Definisi rig
   * ------------------------------------------------------------------ *
   * Tiap tulang mengarah dari sendi `from` ke sendi `to`. `hint` memilih
   * sumbu acuan untuk twist: sumbu bahu untuk badan atas, sumbu pinggul
   * untuk tungkai.
   */

  var HIP_AXIS = 'hip';
  var SHOULDER_AXIS = 'shoulder';

  var RIG = [
    { name: 'Hips',          parent: null,        from: 'hipCenter',   to: 'shoulderCenter', hint: HIP_AXIS,      rest: [0, 1, 0] },
    { name: 'Spine',         parent: 'Hips',      from: 'hipCenter',   to: 'shoulderCenter', hint: HIP_AXIS,      rest: [0, 1, 0] },
    // Chest membawa kepala sekaligus jadi tempat lengan menempel.
    // Dulu ada tulang Neck terpisah dengan from/to yang sama persis —
    // duplikat yang menggambar dua segmen bertumpuk di tempat sama.
    { name: 'Chest',         parent: 'Spine',     from: 'shoulderCenter', to: 'headTop',     hint: SHOULDER_AXIS, rest: [0, 1, 0] },

    { name: 'LeftUpperArm',  parent: 'Chest',     from: 'leftShoulder', to: 'leftElbow',     hint: SHOULDER_AXIS, rest: [1, 0, 0] },
    { name: 'LeftLowerArm',  parent: 'LeftUpperArm',  from: 'leftElbow', to: 'leftWrist',    hint: SHOULDER_AXIS, rest: [1, 0, 0] },
    { name: 'LeftHand',      parent: 'LeftLowerArm',  from: 'leftWrist', to: 'leftIndex',    hint: SHOULDER_AXIS, rest: [1, 0, 0] },

    { name: 'RightUpperArm', parent: 'Chest',     from: 'rightShoulder', to: 'rightElbow',   hint: SHOULDER_AXIS, rest: [-1, 0, 0] },
    { name: 'RightLowerArm', parent: 'RightUpperArm', from: 'rightElbow', to: 'rightWrist',  hint: SHOULDER_AXIS, rest: [-1, 0, 0] },
    { name: 'RightHand',     parent: 'RightLowerArm', from: 'rightWrist', to: 'rightIndex',  hint: SHOULDER_AXIS, rest: [-1, 0, 0] },

    { name: 'LeftUpLeg',     parent: 'Hips',      from: 'leftHip',  to: 'leftKnee',          hint: HIP_AXIS,      rest: [0, -1, 0] },
    { name: 'LeftLeg',       parent: 'LeftUpLeg', from: 'leftKnee', to: 'leftAnkle',         hint: HIP_AXIS,      rest: [0, -1, 0] },
    { name: 'LeftFoot',      parent: 'LeftLeg',   from: 'leftAnkle', to: 'leftFootIndex',    hint: HIP_AXIS,      rest: [0, 0, 1] },

    { name: 'RightUpLeg',    parent: 'Hips',      from: 'rightHip',  to: 'rightKnee',        hint: HIP_AXIS,      rest: [0, -1, 0] },
    { name: 'RightLeg',      parent: 'RightUpLeg', from: 'rightKnee', to: 'rightAnkle',      hint: HIP_AXIS,      rest: [0, -1, 0] },
    { name: 'RightFoot',     parent: 'RightLeg',  from: 'rightAnkle', to: 'rightFootIndex',  hint: HIP_AXIS,      rest: [0, 0, 1] }
  ];

  var DEFAULTS = {
    // MediaPipe memakai y ke bawah dan z menjauh dari kamera; three.js
    // memakai y ke atas. Tanpa pembalikan ini model akan berdiri terbalik.
    flipY: true,
    flipZ: true,
    minVisibility: 0.4,  // di bawah ini sendi dianggap tidak terbaca
    scale: 1,            // meter ke satuan skena
    smoothHold: true     // tahan rotasi terakhir saat sendi hilang
  };

  function resolveOptions(options) {
    var out = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
    if (options) {
      for (var j in options) if (options.hasOwnProperty(j) && options[j] !== undefined) out[j] = options[j];
    }
    return out;
  }

  /** Ambil titik sendi dalam koordinat three.js. */
  function point(landmarks, index, opt) {
    var p = landmarks[index];
    if (!p) return null;
    var vis = (p.visibility === undefined) ? 1 : p.visibility;
    if (vis < opt.minVisibility) return null;
    return [
      p.x * opt.scale,
      (opt.flipY ? -p.y : p.y) * opt.scale,
      (opt.flipZ ? -p.z : p.z) * opt.scale
    ];
  }

  /**
   * Titik-titik turunan yang dipakai rig: pusat pinggul, pusat bahu, dan
   * puncak kepala. MediaPipe tidak memberi sendi untuk ini.
   */
  function derivePoints(landmarks, opt) {
    var p = {};
    for (var key in LM) if (LM.hasOwnProperty(key)) p[key] = point(landmarks, LM[key], opt);

    p.hipCenter = (p.leftHip && p.rightHip) ? mid(p.leftHip, p.rightHip) : null;
    p.shoulderCenter = (p.leftShoulder && p.rightShoulder) ? mid(p.leftShoulder, p.rightShoulder) : null;

    if (p.leftEar && p.rightEar) p.headTop = mid(p.leftEar, p.rightEar);
    else if (p.nose) p.headTop = p.nose;
    else p.headTop = null;

    p.hipAxis = (p.leftHip && p.rightHip) ? normalize(sub(p.leftHip, p.rightHip)) : null;
    p.shoulderAxis = (p.leftShoulder && p.rightShoulder)
      ? normalize(sub(p.leftShoulder, p.rightShoulder)) : null;
    return p;
  }

  function hintVector(points, hint) {
    var v = hint === SHOULDER_AXIS ? points.shoulderAxis : points.hipAxis;
    return v || points.hipAxis || points.shoulderAxis || [1, 0, 0];
  }

  /* ------------------------------------------------------------------ *
   * Panjang tulang
   * ------------------------------------------------------------------ */

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) * 0.5;
  }

  /**
   * Panjang tulang diambil dari MEDIAN seluruh frame, bukan dari frame
   * pertama. Satu frame bisa saja tertutup atau salah deteksi, dan
   * proporsi rig yang ikut salah akan terbawa ke semua frame.
   */
  function measureBoneLengths(frames, opt) {
    var samples = {};
    RIG.forEach(function (bone) { samples[bone.name] = []; });

    frames.forEach(function (frame) {
      var p = derivePoints(frame.landmarks, opt);
      RIG.forEach(function (bone) {
        var a = p[bone.from], b = p[bone.to];
        if (a && b) {
          var len = length(sub(b, a));
          if (len > EPS) samples[bone.name].push(len);
        }
      });
    });

    var lengths = {};
    RIG.forEach(function (bone) { lengths[bone.name] = median(samples[bone.name]); });

    // Hips bukan tulang anggota badan; panjangnya hanya penopang rig.
    if (!(lengths.Hips > 0)) lengths.Hips = lengths.Spine || 0.1;

    // Tulang yang tidak pernah terbaca tetap perlu panjang masuk akal,
    // kalau tidak rig-nya runtuh ke satu titik.
    var fallback = median(RIG.map(function (b) { return lengths[b.name]; })
      .filter(function (v) { return v > 0; })) || 0.1;
    RIG.forEach(function (bone) {
      if (!(lengths[bone.name] > 0)) lengths[bone.name] = fallback * 0.5;
    });
    return lengths;
  }

  /**
   * Lebar pinggul dan bahu, diukur terpisah dari panjang tulang.
   *
   * Tanpa ini lengan akan tumbuh dari tengah dada dan tungkai dari satu
   * titik: offset tiap tulang harus mulai dari sendinya sendiri, bukan
   * dari ujung tulang induknya.
   */
  function measureSpans(frames, opt) {
    var hip = [], shoulder = [];
    frames.forEach(function (frame) {
      var p = derivePoints(frame.landmarks, opt);
      if (p.leftHip && p.rightHip) hip.push(length(sub(p.leftHip, p.rightHip)) / 2);
      if (p.leftShoulder && p.rightShoulder) shoulder.push(length(sub(p.leftShoulder, p.rightShoulder)) / 2);
    });
    return { hipHalf: median(hip), shoulderHalf: median(shoulder) };
  }

  /**
   * Posisi tiap sendi dalam pose T kanonik, relatif terhadap pusat
   * pinggul. Offset tulang diturunkan dari sini, jadi tiap tulang
   * menempel di sendi yang benar.
   */
  function restJointPositions(lengths, spans) {
    var spine = lengths.Spine;
    var neck = lengths.Chest;
    var j = {};

    j.hipCenter = v3(0, 0, 0);
    j.leftHip = v3(spans.hipHalf, 0, 0);
    j.rightHip = v3(-spans.hipHalf, 0, 0);

    j.shoulderCenter = v3(0, spine, 0);
    j.leftShoulder = v3(spans.shoulderHalf, spine, 0);
    j.rightShoulder = v3(-spans.shoulderHalf, spine, 0);
    j.headTop = v3(0, spine + neck, 0);

    j.leftElbow = add(j.leftShoulder, v3(lengths.LeftUpperArm, 0, 0));
    j.leftWrist = add(j.leftElbow, v3(lengths.LeftLowerArm, 0, 0));
    j.leftIndex = add(j.leftWrist, v3(lengths.LeftHand, 0, 0));

    j.rightElbow = add(j.rightShoulder, v3(-lengths.RightUpperArm, 0, 0));
    j.rightWrist = add(j.rightElbow, v3(-lengths.RightLowerArm, 0, 0));
    j.rightIndex = add(j.rightWrist, v3(-lengths.RightHand, 0, 0));

    j.leftKnee = add(j.leftHip, v3(0, -lengths.LeftUpLeg, 0));
    j.leftAnkle = add(j.leftKnee, v3(0, -lengths.LeftLeg, 0));
    j.leftFootIndex = add(j.leftAnkle, v3(0, 0, lengths.LeftFoot));

    j.rightKnee = add(j.rightHip, v3(0, -lengths.RightUpLeg, 0));
    j.rightAnkle = add(j.rightKnee, v3(0, -lengths.RightLeg, 0));
    j.rightFootIndex = add(j.rightAnkle, v3(0, 0, lengths.RightFoot));
    return j;
  }

  /** Skeleton rest dalam pose T, memakai panjang dan lebar terukur. */
  function buildRestSkeleton(lengths, spans) {
    var joints = restJointPositions(lengths, spans);
    var byName = {};
    RIG.forEach(function (b) { byName[b.name] = b; });

    var bones = [];
    RIG.forEach(function (bone) {
      var start = joints[bone.from];
      var parentStart = bone.parent ? joints[byName[bone.parent].from] : null;
      var dir = sub(joints[bone.to], start);
      bones.push({
        name: bone.name,
        parent: bone.parent,
        length: lengths[bone.name],
        // offset relatif terhadap sendi pangkal induknya
        offset: parentStart ? sub(start, parentStart) : v3(0, 0, 0),
        restDirection: normalize(length(dir) > EPS ? dir : bone.rest)
      });
    });
    return bones;
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * Simpangan rotasi terbesar di seluruh tulang, dalam derajat.
   *
   * Tangkapan yang sah tapi nyaris tak bergerak menghasilkan klip yang
   * secara teknis benar — panjangnya pas, keyframe-nya penuh — tapi
   * sosoknya diam. Tanpa angka ini tidak ada cara membedakannya dari
   * kegagalan, dan pengguna cuma melihat patung.
   */
  function motionRange(tracks) {
    var worst = 0;
    tracks.forEach(function (track) {
      if (track.type !== 'quaternion') return;
      var n = Math.floor(track.values.length / 4);
      if (n < 2) return;
      var ref = track.values.slice(0, 4);
      for (var i = 1; i < n; i++) {
        var d = 0;
        for (var k = 0; k < 4; k++) d += ref[k] * track.values[i * 4 + k];
        d = Math.min(1, Math.abs(d));
        var deg = 2 * Math.acos(d) * 180 / Math.PI;
        if (deg > worst) worst = deg;
      }
    });
    return worst;
  }

  /**
   * @param {Array} frames [{ time, landmarks:[{x,y,z,visibility}] }]
   * @param {Object} options lihat DEFAULTS
   */
  function build(frames, options) {
    var opt = resolveOptions(options);
    var stats = {
      frames: frames ? frames.length : 0,
      duration: 0,
      bones: RIG.length,
      framesWithoutPose: 0,
      jointsBelowVisibility: 0,
      bonesHeld: 0,
      motionRange: 0   // simpangan rotasi terbesar, derajat
    };

    if (!frames || frames.length === 0) {
      return { bones: [], tracks: [], duration: 0, stats: stats };
    }

    var lengths = measureBoneLengths(frames, opt);
    var spans = measureSpans(frames, opt);
    var bones = buildRestSkeleton(lengths, spans);

    // Orientasi rest diambil dari arah tulang yang sebenarnya dipakai rig,
    // bukan dari arah kanonik di tabel: keduanya bisa berbeda (telapak
    // kaki, misalnya) dan selisihnya akan muncul sebagai rotasi palsu.
    var restQuat = {};
    var hintRest = [1, 0, 0];
    bones.forEach(function (bone) {
      restQuat[bone.name] = basisQuaternion(bone.restDirection, hintRest);
    });

    var times = [];
    var hipValues = [];
    var rotValues = {};
    RIG.forEach(function (bone) { rotValues[bone.name] = []; });

    var lastLocal = {};
    var lastHip = [0, 0, 0];

    frames.forEach(function (frame) {
      var p = derivePoints(frame.landmarks, opt);
      times.push(frame.time);

      if (!p.hipCenter || !p.shoulderCenter) {
        stats.framesWithoutPose++;
        // frame tanpa pose: tahan keadaan terakhir supaya tidak menyentak
        hipValues.push(lastHip[0], lastHip[1], lastHip[2]);
        RIG.forEach(function (bone) {
          var q = lastLocal[bone.name] || [0, 0, 0, 1];
          rotValues[bone.name].push(q[0], q[1], q[2], q[3]);
        });
        return;
      }

      lastHip = p.hipCenter;
      hipValues.push(p.hipCenter[0], p.hipCenter[1], p.hipCenter[2]);

      var worldQuat = {};
      RIG.forEach(function (bone) {
        var a = p[bone.from], b = p[bone.to];
        var local;

        if (!a || !b) {
          stats.jointsBelowVisibility++;
          if (opt.smoothHold && lastLocal[bone.name]) {
            stats.bonesHeld++;
            local = lastLocal[bone.name];
            // tetap perlu rotasi dunia untuk anak-anaknya
            var parentWorldHeld = bone.parent ? worldQuat[bone.parent] : [0, 0, 0, 1];
            worldQuat[bone.name] = qMul(parentWorldHeld || [0, 0, 0, 1], local);
          } else {
            local = [0, 0, 0, 1];
            worldQuat[bone.name] = bone.parent ? (worldQuat[bone.parent] || [0, 0, 0, 1]) : [0, 0, 0, 1];
          }
        } else {
          var dir = sub(b, a);
          if (length(dir) < EPS) {
            local = lastLocal[bone.name] || [0, 0, 0, 1];
            worldQuat[bone.name] = qMul(bone.parent ? (worldQuat[bone.parent] || [0, 0, 0, 1]) : [0, 0, 0, 1], local);
          } else {
            var world = basisQuaternion(dir, hintVector(p, bone.hint));
            // buang orientasi rest supaya rotasi diukur dari pose T
            var relative = qMul(world, qConj(restQuat[bone.name]));
            worldQuat[bone.name] = relative;
            var parentWorld = bone.parent ? (worldQuat[bone.parent] || [0, 0, 0, 1]) : [0, 0, 0, 1];
            local = qNormalize(qMul(qConj(parentWorld), relative));
          }
        }

        lastLocal[bone.name] = local;
        rotValues[bone.name].push(local[0], local[1], local[2], local[3]);
      });
    });

    stats.duration = times.length ? times[times.length - 1] : 0;

    var tracks = [{
      name: 'Hips.position',
      type: 'vector',
      times: times.slice(),
      values: hipValues
    }];
    RIG.forEach(function (bone) {
      tracks.push({
        name: bone.name + '.quaternion',
        type: 'quaternion',
        times: times.slice(),
        values: rotValues[bone.name]
      });
    });

    stats.motionRange = motionRange(tracks);

    return { bones: bones, tracks: tracks, duration: stats.duration, stats: stats };
  }

  return {
    build: build,
    RIG: RIG,
    LM: LM,
    DEFAULTS: DEFAULTS,
    resolveOptions: resolveOptions,
    _internal: {
      basisQuaternion: basisQuaternion,
      derivePoints: derivePoints,
      measureBoneLengths: measureBoneLengths,
      measureSpans: measureSpans,
      restJointPositions: restJointPositions,
      buildRestSkeleton: buildRestSkeleton,
      normalize: normalize, cross: cross, dot: dot, sub: sub, mid: mid,
      qMul: qMul, qConj: qConj, qNormalize: qNormalize, median: median,
      motionRange: motionRange
    }
  };
});
