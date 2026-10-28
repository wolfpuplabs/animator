/*
 * posepipeline.js — ubah keluaran PoseMocap jadi rig three.js.
 *
 * Membangun hierarki Bone dalam pose rest, satu SkinnedMesh sederhana
 * sebagai badannya, dan AnimationClip dari track rotasi. Hasilnya rig
 * sungguhan: bisa dibersihkan oleh engine, diperbaiki bobot skin-nya, dan
 * diekspor sebagai GLB seperti model yang diunggah pengguna.
 */
(function (root) {
  'use strict';

  var SEGMENTS = 6;

  /** Tebal tiap tulang, sekadar supaya badannya terlihat. */
  function boneRadius(bone, scale) {
    var base = Math.max(bone.length * 0.18, scale * 0.012);
    if (/Hand|Foot|Neck/.test(bone.name)) return base * 0.8;
    if (/Hips|Spine|Chest/.test(bone.name)) return base * 1.15;
    return base;
  }

  /**
   * Posisi rest tiap pangkal tulang, ditumpuk dari offset induknya.
   * Dipakai untuk menempatkan geometri sebelum skinning dihitung.
   */
  function restPositions(bones) {
    var byName = {};
    bones.forEach(function (b) { byName[b.name] = b; });
    var pos = {};
    bones.forEach(function (bone) {
      var parent = bone.parent ? pos[bone.parent] : null;
      var base = parent || new THREE.Vector3();
      pos[bone.name] = base.clone().add(new THREE.Vector3().fromArray(bone.offset));
    });
    return pos;
  }

  /**
   * Geometri badan: satu batang per tulang, tiap vertex dibobot penuh ke
   * tulangnya sendiri. Tanpa pembauran — perbaikan envelope di panel
   * Skinning yang nanti melandaikan sambungannya kalau diminta.
   */
  function buildBodyGeometry(bones, restPos, scale) {
    var positions = [], normals = [], skinIndices = [], skinWeights = [], indices = [];
    var vertexOffset = 0;
    var up = new THREE.Vector3(0, 1, 0);

    bones.forEach(function (bone, boneIndex) {
      if (!(bone.length > 0)) return;

      var radius = boneRadius(bone, scale);
      var geom = new THREE.CylinderGeometry(radius * 0.75, radius, bone.length, SEGMENTS, 1, false);
      // silinder three berpusat di titik asal dan mengarah ke +Y;
      // geser supaya pangkalnya di nol, lalu putar ke arah tulang
      geom.translate(0, bone.length / 2, 0);

      var dir = new THREE.Vector3().fromArray(bone.restDirection).normalize();
      var quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      // BufferGeometry.applyQuaternion baru ada setelah r128.
      geom.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quat));

      var origin = restPos[bone.name];
      geom.translate(origin.x, origin.y, origin.z);

      var pos = geom.attributes.position;
      var nrm = geom.attributes.normal;
      for (var i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        skinIndices.push(boneIndex, 0, 0, 0);
        skinWeights.push(1, 0, 0, 0);
      }
      var idx = geom.index;
      for (var k = 0; k < idx.count; k++) indices.push(idx.getX(k) + vertexOffset);
      vertexOffset += pos.count;
      geom.dispose();
    });

    // Kepala: bola di ujung tulang Chest. Tanpa ini sosoknya sulit dibaca
    // arah hadapnya, dan deteksi pose tidak memberi sendi untuk tengkorak.
    var chestIndex = -1;
    bones.forEach(function (b, i) { if (b.name === 'Chest') chestIndex = i; });
    if (chestIndex >= 0) {
      var chest = bones[chestIndex];
      var headRadius = Math.max(chest.length * 0.42, scale * 0.03);
      var head = new THREE.SphereGeometry(headRadius, 12, 10);
      var tip = restPos.Chest.clone().add(
        new THREE.Vector3().fromArray(chest.restDirection).multiplyScalar(chest.length)
      );
      head.translate(tip.x, tip.y, tip.z);
      var hp = head.attributes.position, hn = head.attributes.normal;
      for (var h = 0; h < hp.count; h++) {
        positions.push(hp.getX(h), hp.getY(h), hp.getZ(h));
        normals.push(hn.getX(h), hn.getY(h), hn.getZ(h));
        skinIndices.push(chestIndex, 0, 0, 0);
        skinWeights.push(1, 0, 0, 0);
      }
      var hi = head.index;
      for (var g = 0; g < hi.count; g++) indices.push(hi.getX(g) + vertexOffset);
      vertexOffset += hp.count;
      head.dispose();
    }

    var merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    merged.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    merged.setIndex(indices);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  function buildClip(result, name) {
    var tracks = [];
    result.tracks.forEach(function (t) {
      if (!t.times.length) return;
      var times = new Float32Array(t.times);
      var values = new Float32Array(t.values);
      if (t.type === 'quaternion') tracks.push(new THREE.QuaternionKeyframeTrack(t.name, times, values));
      else tracks.push(new THREE.VectorKeyframeTrack(t.name, times, values));
    });
    return new THREE.AnimationClip(name || 'Capture', result.duration, tracks);
  }

  /**
   * @param {Object} result keluaran PoseMocap.build
   * @returns {{root: THREE.Group, mesh: THREE.SkinnedMesh, clip: THREE.AnimationClip}}
   */
  function buildRig(result, options) {
    var opts = options || {};
    if (!result.bones.length) return null;

    // Dipakai sebagai lantai ketebalan tulang, jadi yang dicari tulang
    // terpanjang: kalau diambil yang terakhir, badan rig kecil jadi tipis
    // sampai nyaris tidak terlihat.
    var scale = 0;
    result.bones.forEach(function (b) { scale = Math.max(scale, b.length); });
    scale = scale || 1;

    var boneObjects = {};
    var ordered = [];
    result.bones.forEach(function (def) {
      var bone = new THREE.Bone();
      bone.name = def.name;
      bone.position.fromArray(def.offset);
      boneObjects[def.name] = bone;
      ordered.push(bone);
    });

    var rootBone = null;
    result.bones.forEach(function (def) {
      if (def.parent) boneObjects[def.parent].add(boneObjects[def.name]);
      else rootBone = boneObjects[def.name];
    });

    var root = new THREE.Group();
    root.name = opts.name || 'PoseCapture';
    root.add(rootBone);

    // matriks dunia harus mutakhir sebelum Skeleton menghitung invers bind
    root.updateMatrixWorld(true);

    var geometry = buildBodyGeometry(result.bones, restPositions(result.bones), scale);
    var material = new THREE.MeshStandardMaterial({
      color: 0x22d3ee, roughness: 0.45, metalness: 0.05
    });
    var mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = 'CaptureBody';
    root.add(mesh);
    mesh.bind(new THREE.Skeleton(ordered));

    return { root: root, mesh: mesh, clip: buildClip(result, opts.clipName) };
  }

  root.PosePipeline = {
    buildRig: buildRig,
    buildClip: buildClip,
    restPositions: restPositions,
    buildBodyGeometry: buildBodyGeometry
  };
})(typeof self !== 'undefined' ? self : this);
