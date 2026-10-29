/*
 * retarget.js — pindahkan hasil tangkapan video ke rig model lain.
 *
 * Yang membuat ini mungkin: posemocap.js tidak menyimpan orientasi tulang
 * apa adanya, melainkan SIMPANGANNYA DARI POSE REST. Orientasi mentah
 * terikat pada proporsi dan sumbu rig asalnya, sedangkan simpangan dari
 * rest ("putar lengan 40 derajat dari posisi diamnya") berlaku di rig mana
 * pun yang pose rest-nya sebanding.
 *
 * Jadi alurnya:
 *
 *   D_sumber = orientasi dunia relatif rest, diakumulasi dari track lokal
 *   W_target = D_sumber · R_rest_target        (orientasi dunia yang diinginkan)
 *   lokal    = W_induk⁻¹ · W_target            (yang benar-benar ditulis ke track)
 *
 * Pose rest target diambil dari `skeleton.boneInverses`, bukan dari pose
 * tulang saat ini — kalau tidak, hasilnya ikut terpengaruh klip yang
 * kebetulan sedang diputar waktu retarget dijalankan.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Retarget = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Tulang yang dihasilkan posemocap, urut induk lebih dulu. */
  var CANONICAL = [
    'Hips', 'Spine', 'Chest',
    'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
    'RightUpperArm', 'RightLowerArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot',
    'RightUpLeg', 'RightLeg', 'RightFoot'
  ];

  /* ------------------------------------------------------------------ *
   * Pencocokan nama tulang
   * ------------------------------------------------------------------ */

  // Token yang cuma penanda perkakas, bukan bagian nama anatomisnya.
  var NOISE = {
    mixamorig: 1, mixamo: 1, bip: 1, bip01: 1, bip001: 1, biped: 1,
    armature: 1, rig: 1, root: 0, def: 1, org: 1, mch: 1, ctrl: 1,
    j: 1, jbip: 1, bone: 1, skel: 1, skeleton: 1, character: 1,
    // penanda "tengah" di rig VRM: J_Bip_C_Chest
    c: 1, center: 1, centre: 1, mid: 1
  };

  var SIDE_LEFT = { l: 1, left: 1, lft: 1, lf: 1 };
  var SIDE_RIGHT = { r: 1, right: 1, rgt: 1, rt: 1 };

  // Inti nama -> tulang kanonik. Nama tanpa sisi dipakai apa adanya;
  // yang bersisi digabung dengan Left/Right saat dicocokkan.
  var CORE = {
    // badan
    hips: 'Hips', hip: 'Hips', pelvis: 'Hips', waist: 'Hips',
    spine: 'Spine', spine0: 'Spine', spine1: 'Spine', abdomen: 'Spine',
    chest: 'Chest', spine2: 'Chest', spine3: 'Chest', upperchest: 'Chest',
    torso: 'Chest', ribcage: 'Chest',

    // lengan — "arm" telanjang berarti lengan ATAS (konvensi Mixamo:
    // LeftArm = lengan atas, LeftForeArm = lengan bawah)
    arm: 'UpperArm', upperarm: 'UpperArm', armupper: 'UpperArm',
    uparm: 'UpperArm',
    forearm: 'LowerArm', lowerarm: 'LowerArm', armlower: 'LowerArm',
    elbow: 'LowerArm',
    hand: 'Hand', wrist: 'Hand',

    // tungkai — "leg" telanjang berarti tungkai BAWAH, sekali lagi
    // mengikuti Mixamo: LeftUpLeg lalu LeftLeg
    upleg: 'UpLeg', thigh: 'UpLeg', upperleg: 'UpLeg', legupper: 'UpLeg',
    leg: 'Leg', shin: 'Leg', calf: 'Leg', lowerleg: 'Leg', knee: 'Leg',
    foot: 'Foot', ankle: 'Foot'
  };

  var SIDED = {
    UpperArm: 1, LowerArm: 1, Hand: 1, UpLeg: 1, Leg: 1, Foot: 1
  };

  /** Pecah nama jadi token: pemisah apa pun, plus batas camelCase. */
  function tokenize(name) {
    return String(name)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(function (t) { return t.length > 0; });
  }

  /**
   * Nama tulang -> { core, side }.
   *
   * side: 'left' | 'right' | null. core berupa string gabungan token
   * tersisa, sudah dibuang token penanda perkakas dan penanda sisinya.
   */
  function normalizeName(name) {
    var tokens = tokenize(name);
    var side = null;
    var kept = [];

    tokens.forEach(function (t) {
      if (NOISE[t]) return;
      if (side === null && SIDE_LEFT[t]) { side = 'left'; return; }
      if (side === null && SIDE_RIGHT[t]) { side = 'right'; return; }
      kept.push(t);
    });

    // Sisi juga sering menempel di ujung kata: "arm_L" sudah tertangkap di
    // atas, tapi "LeftArm" yang ditulis "leftarm" tanpa pemisah tidak.
    if (side === null && kept.length) {
      var head = kept[0];
      if (/^left./.test(head)) { side = 'left'; kept[0] = head.slice(4); }
      else if (/^right./.test(head)) { side = 'right'; kept[0] = head.slice(5); }
    }

    return { core: kept.join(''), side: side };
  }

  /** Nama tulang -> nama kanonik, atau null kalau tidak dikenali. */
  function canonicalOf(name) {
    var parsed = normalizeName(name);
    var base = CORE[parsed.core];
    if (!base) return null;
    if (!SIDED[base]) return parsed.side ? null : base;
    if (!parsed.side) return null;
    return (parsed.side === 'left' ? 'Left' : 'Right') + base;
  }

  /**
   * Cocokkan daftar nama tulang target ke nama kanonik.
   *
   * Kalau beberapa tulang mengaku kanonik yang sama, yang namanya paling
   * pendek dipakai: rig sering punya tulang bantu seperti
   * "LeftHandAdjust" yang lebih panjang dari tulang aslinya.
   */
  function matchBones(names) {
    var map = {};
    (names || []).forEach(function (name) {
      var canon = canonicalOf(name);
      if (!canon) return;
      if (map[canon] === undefined || String(name).length < String(map[canon]).length) {
        map[canon] = name;
      }
    });
    return map;
  }

  /* ------------------------------------------------------------------ *
   * Matematika quaternion (tanpa THREE, supaya bisa diuji sendiri)
   * ------------------------------------------------------------------ */

  function qMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  function qConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
  function qNorm(q) {
    var n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  /**
   * Akumulasi simpangan dunia tiap tulang sumber, per frame.
   *
   * posemocap menulis track lokal sebagai D_induk⁻¹ · D_diri, jadi
   * membaliknya cuma perlu mengalikan turun dari akar.
   */
  function sourceWorldDeltas(capture) {
    var local = {};
    capture.tracks.forEach(function (t) {
      if (t.type === 'quaternion') local[t.name.replace('.quaternion', '')] = t.values;
    });
    var order = capture.bones.map(function (b) { return b.name; });
    var parentOf = {};
    capture.bones.forEach(function (b) { parentOf[b.name] = b.parent; });

    var frames = 0;
    order.forEach(function (n) {
      if (local[n]) frames = Math.max(frames, Math.floor(local[n].length / 4));
    });

    var out = [];
    for (var f = 0; f < frames; f++) {
      var world = {};
      order.forEach(function (name) {
        var v = local[name];
        var q = v ? [v[f * 4], v[f * 4 + 1], v[f * 4 + 2], v[f * 4 + 3]] : [0, 0, 0, 1];
        var p = parentOf[name];
        world[name] = p && world[p] ? qMul(world[p], q) : q;
      });
      out.push(world);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Pembacaan pose rest target
   * ------------------------------------------------------------------ */

  /**
   * Pose rest tiap tulang, dibaca dari skeleton.boneInverses.
   *
   * Sengaja TIDAK memakai bone.matrixWorld saat ini: kalau ada klip yang
   * sedang diputar, pose rest-nya akan terbaca sebagai pose animasi dan
   * seluruh hasil retarget ikut miring.
   */
  function readRestPose(skeleton) {
    var bones = skeleton.bones;
    var index = {};
    bones.forEach(function (b, i) { index[b.uuid] = i; });

    var rest = bones.map(function (bone, i) {
      var world = new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert();
      var pos = new THREE.Vector3();
      var quat = new THREE.Quaternion();
      var scl = new THREE.Vector3();
      world.decompose(pos, quat, scl);
      return {
        bone: bone,
        name: bone.name,
        parent: (bone.parent && index[bone.parent.uuid] !== undefined) ? index[bone.parent.uuid] : -1,
        worldQuat: [quat.x, quat.y, quat.z, quat.w],
        worldPos: [pos.x, pos.y, pos.z],
        localQuat: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
        localPos: [bone.position.x, bone.position.y, bone.position.z]
      };
    });

    // Orientasi dunia induk pada pose rest. Untuk tulang yang induknya di
    // luar skeleton (akar), diturunkan dari rest-nya sendiri.
    rest.forEach(function (r) {
      r.parentWorldQuat = r.parent >= 0
        ? rest[r.parent].worldQuat
        : qNorm(qMul(r.worldQuat, qConj(r.localQuat)));
    });
    return rest;
  }

  function distance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /** Panjang tungkai dipakai menskalakan perpindahan pinggul. */
  function legSpan(rest, byName, map) {
    var up = byName[map.LeftUpLeg], foot = byName[map.LeftFoot];
    if (up === undefined || foot === undefined) {
      up = byName[map.RightUpLeg]; foot = byName[map.RightFoot];
    }
    if (up === undefined || foot === undefined) return 0;
    return distance(rest[up].worldPos, rest[foot].worldPos);
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} capture keluaran PoseMocap.build
   * @param {THREE.Skeleton} skeleton skeleton model tujuan
   * @param {Object} options { map, clipName, rootMotion }
   * @returns {{clip, map, matched, missing, scale}} atau null kalau gagal
   */
  function retarget(capture, skeleton, options) {
    var opt = options || {};
    if (!capture || !capture.bones || !capture.bones.length) return null;
    if (!skeleton || !skeleton.bones || !skeleton.bones.length) return null;

    var rest = readRestPose(skeleton);
    var byName = {};
    rest.forEach(function (r, i) { if (byName[r.name] === undefined) byName[r.name] = i; });

    var map = opt.map || matchBones(rest.map(function (r) { return r.name; }));
    var matched = CANONICAL.filter(function (c) { return map[c] && byName[map[c]] !== undefined; });
    var missing = CANONICAL.filter(function (c) { return matched.indexOf(c) === -1; });
    // Tanpa pinggul tidak ada jangkar; tanpa minimal beberapa anggota
    // badan hasilnya cuma patung yang bergoyang sedikit.
    if (matched.indexOf('Hips') === -1 || matched.length < 6) {
      return { clip: null, map: map, matched: matched, missing: missing, scale: 1 };
    }

    var targetOf = {};   // indeks tulang target -> nama kanonik sumber
    matched.forEach(function (c) { targetOf[byName[map[c]]] = c; });

    var deltas = sourceWorldDeltas(capture);
    var times = (capture.tracks[0] && capture.tracks[0].times) || [];
    var frames = Math.min(deltas.length, times.length);
    if (!frames) return { clip: null, map: map, matched: matched, missing: missing, scale: 1 };

    // Skala perpindahan pinggul: rasio panjang tungkai target terhadap
    // sumber. Tanpa ini karakter kecil melayang dan yang besar terseret.
    var srcSpan = 0;
    capture.bones.forEach(function (b) {
      if (b.name === 'LeftUpLeg' || b.name === 'LeftLeg') srcSpan += b.length;
    });
    var dstSpan = legSpan(rest, byName, map);
    var scale = (srcSpan > 1e-6 && dstSpan > 1e-6) ? dstSpan / srcSpan : 1;

    // Urutan induk-dulu supaya orientasi induk sudah siap saat anaknya dihitung.
    var order = rest.map(function (_, i) { return i; }).sort(function (a, b) {
      var da = 0, db = 0, p;
      for (p = rest[a].parent; p >= 0; p = rest[p].parent) da++;
      for (p = rest[b].parent; p >= 0; p = rest[p].parent) db++;
      return da - db;
    });

    var values = {};
    matched.forEach(function (c) { values[c] = []; });

    var hipTrack = null;
    var hipRest = null;
    var hipValuesOut = [];
    capture.tracks.forEach(function (t) { if (t.name === 'Hips.position') hipTrack = t; });
    if (hipTrack && hipTrack.values.length >= 3) {
      hipRest = [hipTrack.values[0], hipTrack.values[1], hipTrack.values[2]];
    }
    var hipIndex = byName[map.Hips];

    for (var f = 0; f < frames; f++) {
      var world = {};
      order.forEach(function (i) {
        var r = rest[i];
        var parentWorld = r.parent >= 0 ? world[r.parent] : r.parentWorldQuat;
        var canon = targetOf[i];
        var w;
        if (canon && deltas[f][canon]) {
          w = qNorm(qMul(deltas[f][canon], r.worldQuat));
        } else {
          w = qNorm(qMul(parentWorld, r.localQuat));
        }
        world[i] = w;
        if (canon) {
          var local = qNorm(qMul(qConj(parentWorld), w));
          values[canon].push(local[0], local[1], local[2], local[3]);
        }
      });

      if (hipTrack && hipRest && opt.rootMotion !== false) {
        var hr = rest[hipIndex];
        var dx = (hipTrack.values[f * 3] - hipRest[0]) * scale;
        var dy = (hipTrack.values[f * 3 + 1] - hipRest[1]) * scale;
        var dz = (hipTrack.values[f * 3 + 2] - hipRest[2]) * scale;
        // Perpindahan terukur di ruang dunia; posisi lokal tulang hidup di
        // ruang induknya, jadi diputar balik dulu.
        var inv = qConj(hr.parentWorldQuat);
        var d = rotate(inv, [dx, dy, dz]);
        hipValuesOut.push(hr.localPos[0] + d[0], hr.localPos[1] + d[1], hr.localPos[2] + d[2]);
      }
    }

    var t = new Float32Array(times.slice(0, frames));
    var tracks = [];
    matched.forEach(function (c) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        trackTarget(rest[byName[map[c]]].bone) + '.quaternion',
        t, new Float32Array(values[c])));
    });
    if (hipValuesOut.length) {
      tracks.push(new THREE.VectorKeyframeTrack(
        trackTarget(rest[hipIndex].bone) + '.position',
        t, new Float32Array(hipValuesOut)));
    }

    var duration = times[frames - 1] || capture.duration || 0;
    return {
      clip: new THREE.AnimationClip(opt.clipName || 'Capture', duration, tracks),
      map: map, matched: matched, missing: missing, scale: scale
    };
  }

  /**
   * Nama node untuk track animasi.
   *
   * Nama yang mengandung karakter khusus — titik dua dari rig Mixamo
   * adalah kasus paling umum — TIDAK bisa di-resolve PropertyBinding:
   * track-nya diam-diam tidak terpasang, dan GLTFExporter menolak
   * mengekspornya. uuid selalu bisa di-resolve, jadi dipakai sebagai
   * cadangan. Nama asli tetap didahulukan supaya klip hasil ekspor
   * masih terbaca manusia.
   */
  function trackTarget(bone) {
    var name = bone.name;
    if (name && THREE.PropertyBinding &&
        THREE.PropertyBinding.sanitizeNodeName(name) === name) {
      return name;
    }
    return bone.uuid;
  }

  function rotate(q, v) {
    var t = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
    return [t[0], t[1], t[2]];
  }

  /** Skeleton pertama yang ditemukan di sebuah objek. */
  function findSkeleton(object) {
    var found = null;
    if (!object) return null;
    object.traverse(function (child) {
      if (!found && child.isSkinnedMesh && child.skeleton && child.skeleton.bones.length) {
        found = child.skeleton;
      }
    });
    return found;
  }

  return {
    retarget: retarget,
    matchBones: matchBones,
    canonicalOf: canonicalOf,
    normalizeName: normalizeName,
    findSkeleton: findSkeleton,
    CANONICAL: CANONICAL,
    _internal: { qMul: qMul, qConj: qConj, qNorm: qNorm, sourceWorldDeltas: sourceWorldDeltas }
  };
});
