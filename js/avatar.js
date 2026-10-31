/*
 * avatar.js — avatar manusia ber-rig, dibangun dari kode.
 *
 * Dipakai sebagai contoh bawaan. Dibangun di kode, bukan dimuat dari
 * berkas, karena dua alasan: tidak ada aset yang lisensinya harus ikut
 * dipikirkan, dan standalone.html tetap satu berkas.
 *
 * Yang penting dari avatar ini bukan tampilannya, tapi bahwa dia rig
 * SUNGGUHAN: tulangnya bernama kanonik, bobot skin-nya membaur di
 * sambungan, jadi tangkapan video bisa langsung dipindahkan ke sini
 * lewat retarget.js. Contoh bawaan yang lama cuma dua bola tanpa tulang,
 * dan itu membuat fitur paling menarik di aplikasi ini tidak bisa dicoba
 * tanpa menyiapkan model sendiri lebih dulu.
 *
 * Pose rest-nya T-pose menghadap +Z, tinggi sekitar 1,75 satuan.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Avatar = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * Rangka. offset relatif terhadap induk.
   *
   * Nama tulang inti sengaja memakai nama kanonik yang dikenali
   * retarget.js. Tulang hiasan (Neck, Head, Shoulder, Toe) tidak
   * dicocokkan — dan memang sebaiknya begitu: deteksi pose tidak
   * memberikan data yang bisa dipercaya untuk itu.
   */
  // rx/rz: setengah-lebar penampang melintang dan ke depan. Dibedakan
  // karena badan manusia tidak bulat — torso lebar dan pipih, telapak
  // tangan lebih pipih lagi. Satu angka radius untuk semuanya membuat
  // sosoknya jadi rangkaian pipa, bukan orang.
  var SKELETON = [
    { name: 'Hips',          parent: null,          offset: [0, 0.95, 0],      rx: 0.165, rz: 0.115 },
    { name: 'Spine',         parent: 'Hips',        offset: [0, 0.13, 0],      rx: 0.155, rz: 0.110 },
    { name: 'Chest',         parent: 'Spine',       offset: [0, 0.17, 0],      rx: 0.195, rz: 0.125 },
    { name: 'Neck',          parent: 'Chest',       offset: [0, 0.21, 0],      rx: 0.052, rz: 0.052 },
    { name: 'Head',          parent: 'Neck',        offset: [0, 0.07, 0],      rx: 0.098, rz: 0.108 },

    { name: 'LeftShoulder',  parent: 'Chest',       offset: [0.055, 0.15, 0],  rx: 0.080, rz: 0.080 },
    { name: 'LeftUpperArm',  parent: 'LeftShoulder', offset: [0.125, 0, 0],    rx: 0.062, rz: 0.062 },
    { name: 'LeftLowerArm',  parent: 'LeftUpperArm', offset: [0.265, 0, 0],    rx: 0.052, rz: 0.052 },
    { name: 'LeftHand',      parent: 'LeftLowerArm', offset: [0.235, 0, 0],    rx: 0.048, rz: 0.026 },

    { name: 'RightShoulder', parent: 'Chest',       offset: [-0.055, 0.15, 0], rx: 0.080, rz: 0.080 },
    { name: 'RightUpperArm', parent: 'RightShoulder', offset: [-0.125, 0, 0],  rx: 0.062, rz: 0.062 },
    { name: 'RightLowerArm', parent: 'RightUpperArm', offset: [-0.265, 0, 0],  rx: 0.052, rz: 0.052 },
    { name: 'RightHand',     parent: 'RightLowerArm', offset: [-0.235, 0, 0],  rx: 0.048, rz: 0.026 },

    { name: 'LeftUpLeg',     parent: 'Hips',        offset: [0.095, -0.07, 0], rx: 0.090, rz: 0.090 },
    { name: 'LeftLeg',       parent: 'LeftUpLeg',   offset: [0, -0.42, 0],     rx: 0.070, rz: 0.070 },
    { name: 'LeftFoot',      parent: 'LeftLeg',     offset: [0, -0.41, 0],     rx: 0.055, rz: 0.055 },
    { name: 'LeftToe',       parent: 'LeftFoot',    offset: [0, -0.07, 0.13],  rx: 0.052, rz: 0.040 },

    { name: 'RightUpLeg',    parent: 'Hips',        offset: [-0.095, -0.07, 0], rx: 0.090, rz: 0.090 },
    { name: 'RightLeg',      parent: 'RightUpLeg',  offset: [0, -0.42, 0],     rx: 0.070, rz: 0.070 },
    { name: 'RightFoot',     parent: 'RightLeg',    offset: [0, -0.41, 0],     rx: 0.055, rz: 0.055 },
    { name: 'RightToe',      parent: 'RightFoot',   offset: [0, -0.07, 0.13],  rx: 0.052, rz: 0.040 }
  ];

  // Tulang ujung tidak punya anak untuk diukur, jadi panjangnya dibuat
  // eksplisit supaya dagingnya tetap terbentuk.
  var TIP_LENGTH = {
    Head: 0.16, LeftHand: 0.17, RightHand: 0.17, LeftToe: 0.08, RightToe: 0.08
  };

  var RADIAL = 12;   // sisi penampang
  var RINGS = 7;     // cincin sepanjang tulang

  function v3(x, y, z) { return { x: x, y: y, z: z }; }

  /**
   * Bobot skin satu vertex pada posisi t sepanjang tulang.
   *
   * Vertex di tengah tulang milik tulang itu sepenuhnya. Mendekati ujung,
   * bobotnya membaur ke tulang tetangga — tanpa itu sikut dan lutut
   * terlipat seperti sedotan, bukan menekuk.
   */
  function blend(t) {
    var BLEND = 0.3;
    if (t < BLEND) return { other: 'parent', w: (1 - t / BLEND) * 0.45 };
    if (t > 1 - BLEND) return { other: 'child', w: (1 - (1 - t) / BLEND) * 0.45 };
    return { other: null, w: 0 };
  }

  function buildGeometry(bones, index) {
    var positions = [], normals = [], skinIndices = [], skinWeights = [], indices = [];

    bones.forEach(function (bone) {
      var length = bone.length;
      if (!(length > 1e-4)) return;

      var dir = bone.dir;
      // Basis penampang. Sumbu lebarnya dipaksa sedekat mungkin ke sumbu
      // X dunia, supaya torso yang pipih melebar ke samping dan bukan ke
      // arah sembarang yang kebetulan tegak lurus tulang.
      var ref = Math.abs(dir.x) > 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
      var sz = normalize(cross(dir, ref));
      var sx = normalize(cross(sz, dir));

      var childIndex = bone.child >= 0 ? bone.child : bone.index;
      var parentIndex = bone.parent >= 0 ? bone.parent : bone.index;
      var base = positions.length / 3;

      for (var r = 0; r <= RINGS; r++) {
        var t = r / RINGS;
        // Penampang mengecil di kedua ujung supaya sambungannya membulat,
        // bukan terpotong rata seperti pipa.
        var taper = 0.72 + 0.46 * Math.sin(Math.PI * (0.18 + 0.64 * t));
        var radiusX = bone.rx * taper;
        var radiusZ = bone.rz * taper;
        var mix = blend(t);
        var other = mix.other === 'parent' ? parentIndex
          : mix.other === 'child' ? childIndex : bone.index;

        for (var a = 0; a < RADIAL; a++) {
          var ang = a / RADIAL * Math.PI * 2;
          var ca = Math.cos(ang), sa = Math.sin(ang);
          var ox = sx.x * ca * radiusX + sz.x * sa * radiusZ;
          var oy = sx.y * ca * radiusX + sz.y * sa * radiusZ;
          var oz = sx.z * ca * radiusX + sz.z * sa * radiusZ;
          positions.push(
            bone.start.x + dir.x * length * t + ox,
            bone.start.y + dir.y * length * t + oy,
            bone.start.z + dir.z * length * t + oz
          );
          var n = normalize(v3(ox, oy, oz));
          normals.push(n.x, n.y, n.z);
          skinIndices.push(bone.index, other, 0, 0);
          skinWeights.push(1 - mix.w, mix.w, 0, 0);
        }
      }

      for (var ring = 0; ring < RINGS; ring++) {
        for (var k = 0; k < RADIAL; k++) {
          var a0 = base + ring * RADIAL + k;
          var a1 = base + ring * RADIAL + (k + 1) % RADIAL;
          var b0 = a0 + RADIAL, b1 = a1 + RADIAL;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    });

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geom.setIndex(indices);
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    return geom;
  }

  function cross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function normalize(a) {
    var n = Math.hypot(a.x, a.y, a.z) || 1;
    return v3(a.x / n, a.y / n, a.z / n);
  }

  /**
   * Klip contoh yang SENGAJA patah: 8 fps, berjitter, dengan satu
   * quaternion yang dibalik tandanya. Itu memang gunanya contoh bawaan —
   * memberi engine sesuatu untuk dibereskan, bukan memamerkan animasi
   * yang sudah bagus.
   */
  function buildClip(byName, name) {
    var fps = 8, duration = 2.4;
    var count = Math.round(duration * fps) + 1;
    var seed = 20261029;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }

    var times = [];
    var curves = {};
    function curve(bone) {
      if (!curves[bone]) curves[bone] = [];
      return curves[bone];
    }
    var hips = [];
    var q = new THREE.Quaternion(), e = new THREE.Euler();

    for (var i = 0; i < count; i++) {
      var t = i / fps;
      times.push(t);
      var phase = t * Math.PI * 1.35;

      hips.push(rnd() * 0.012, 0.95 + Math.abs(Math.sin(phase)) * 0.09 + rnd() * 0.012, rnd() * 0.012);

      function put(bone, ex, ey, ez, flip) {
        e.set(ex + rnd() * 0.05, ey + rnd() * 0.05, ez + rnd() * 0.05);
        q.setFromEuler(e);
        var s = flip ? -1 : 1;
        curve(bone).push(q.x * s, q.y * s, q.z * s, q.w * s);
      }

      // Hemisphere sengaja dirusak di dua frame — kasus nyata dari
      // eksporter yang berbeda, dan salah satu hal yang diperbaiki engine.
      var broken = (i === 9 || i === 10);

      // Dari pose T, lengan dibawa turun ke samping dulu (putaran
      // sekitar Z), baru diayun maju-mundur. Dibiarkan terangkat
      // membuat sosoknya tinggi kurus dan kameranya menjauh, jadi
      // yang terlihat malah figur kecil di tengah layar.
      var swing = Math.sin(phase);
      var ARM_DOWN = 1.32;

      put('Spine', swing * 0.07, Math.sin(t * 0.9) * 0.12, 0, false);
      put('Chest', Math.sin(phase + 0.5) * 0.06, 0, Math.cos(phase) * 0.05, broken);
      put('LeftUpperArm', swing * 0.55, 0, -ARM_DOWN + 0.14, false);
      put('LeftLowerArm', -0.30 - Math.max(0, swing) * 0.45, 0, 0, false);
      put('RightUpperArm', -swing * 0.55, 0, ARM_DOWN - 0.14, false);
      put('RightLowerArm', -0.30 - Math.max(0, -swing) * 0.45, 0, 0, false);
      put('LeftUpLeg', -swing * 0.42, 0, 0, false);
      put('LeftLeg', Math.max(0, swing) * 0.70, 0, 0, false);
      put('RightUpLeg', swing * 0.42, 0, 0, false);
      put('RightLeg', Math.max(0, -swing) * 0.70, 0, 0, false);
    }

    var tracks = [new THREE.VectorKeyframeTrack(
      byName.Hips.uuid + '.position', new Float32Array(times), new Float32Array(hips))];
    Object.keys(curves).forEach(function (bone) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        byName[bone].uuid + '.quaternion',
        new Float32Array(times), new Float32Array(curves[bone])));
    });
    return new THREE.AnimationClip(name || 'wave_stepped_8fps', duration, tracks);
  }

  /**
   * @param {Object} options { name, clipName, color }
   * @returns {{root, mesh, skeleton, clip, boneNames}}
   */
  function build(options) {
    var opt = options || {};

    var byName = {};
    var bones = [];
    SKELETON.forEach(function (def, i) {
      var bone = new THREE.Bone();
      bone.name = def.name;
      bone.position.set(def.offset[0], def.offset[1], def.offset[2]);
      byName[def.name] = bone;
      bones.push(bone);
      if (def.parent) byName[def.parent].add(bone);
    });

    var root = new THREE.Group();
    root.name = opt.name || 'Avatar';
    root.add(byName.Hips);
    root.updateMatrixWorld(true);

    // Arah dan panjang tiap tulang diukur dari pose rest-nya, bukan
    // ditulis tangan: satu sumber kebenaran untuk rangka dan dagingnya.
    var indexOf = {};
    SKELETON.forEach(function (def, i) { indexOf[def.name] = i; });

    var world = SKELETON.map(function (def) {
      var p = new THREE.Vector3();
      byName[def.name].getWorldPosition(p);
      return p;
    });

    var childOf = {};
    SKELETON.forEach(function (def) {
      if (def.parent && childOf[def.parent] === undefined) childOf[def.parent] = indexOf[def.name];
    });

    var meta = SKELETON.map(function (def, i) {
      var childIndex = childOf[def.name] !== undefined ? childOf[def.name] : -1;
      var start = world[i];
      var dir, length;
      if (childIndex >= 0) {
        var d = new THREE.Vector3().subVectors(world[childIndex], start);
        length = d.length();
        dir = length > 1e-6 ? d.clone().multiplyScalar(1 / length) : new THREE.Vector3(0, 1, 0);
      } else {
        length = TIP_LENGTH[def.name] || 0;
        // Tulang ujung meneruskan arah induknya supaya tangan dan kaki
        // tidak mencuat ke arah yang tidak masuk akal.
        var parentIndex = def.parent ? indexOf[def.parent] : -1;
        dir = parentIndex >= 0
          ? new THREE.Vector3().subVectors(start, world[parentIndex]).normalize()
          : new THREE.Vector3(0, 1, 0);
        if (def.name === 'Head') dir = new THREE.Vector3(0, 1, 0);
      }
      return {
        index: i,
        parent: def.parent ? indexOf[def.parent] : -1,
        child: childIndex,
        rx: def.rx,
        rz: def.rz,
        length: length,
        start: v3(start.x, start.y, start.z),
        dir: v3(dir.x, dir.y, dir.z)
      };
    });

    var geometry = buildGeometry(meta, indexOf);
    var material = new THREE.MeshStandardMaterial({
      color: opt.color !== undefined ? opt.color : 0x9fdcf0,
      roughness: 0.42,
      metalness: 0.08
    });
    // Tidak berpengaruh di three modern (skinning otomatis sejak r130),
    // tapi tetap disetel supaya rig ini juga benar kalau three dipatok
    // ke versi lama.
    material.skinning = true;

    var mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = 'AvatarBody';
    root.add(mesh);
    mesh.bind(new THREE.Skeleton(bones));

    return {
      root: root,
      mesh: mesh,
      skeleton: mesh.skeleton,
      clip: buildClip(byName, opt.clipName),
      boneNames: SKELETON.map(function (d) { return d.name; })
    };
  }

  return { build: build, SKELETON: SKELETON };
});
