/*
 * three-adapter.js — jembatan antara THREE.AnimationClip dan engine MFS.
 *
 * Engine sengaja tidak tahu apa-apa soal three.js (supaya bisa diuji di
 * node dan dipakai di pipeline lain). File ini yang menerjemahkan.
 */
(function (root) {
  'use strict';

  var TYPE_TO_CTOR = {
    vector: 'VectorKeyframeTrack',
    quaternion: 'QuaternionKeyframeTrack',
    number: 'NumberKeyframeTrack',
    color: 'ColorKeyframeTrack',
    bool: 'BooleanKeyframeTrack',
    string: 'StringKeyframeTrack'
  };

  /** Deteksi tipe track; fallback ke konstruktornya kalau perlu. */
  function trackType(track) {
    if (track.ValueTypeName) return track.ValueTypeName;
    if (track instanceof THREE.QuaternionKeyframeTrack) return 'quaternion';
    if (track instanceof THREE.NumberKeyframeTrack) return 'number';
    if (track instanceof THREE.BooleanKeyframeTrack) return 'bool';
    if (track instanceof THREE.StringKeyframeTrack) return 'string';
    return 'vector';
  }

  function clipToData(clip) {
    var tracks = [];
    for (var i = 0; i < clip.tracks.length; i++) {
      var t = clip.tracks[i];
      tracks.push({
        name: t.name,
        type: trackType(t),
        times: Array.prototype.slice.call(t.times),
        values: Array.prototype.slice.call(t.values)
      });
    }
    return { name: clip.name, duration: clip.duration, tracks: tracks };
  }

  function dataToClip(data) {
    var tracks = [];
    for (var i = 0; i < data.tracks.length; i++) {
      var t = data.tracks[i];
      if (!t.times.length) continue;
      var ctorName = TYPE_TO_CTOR[t.type] || 'VectorKeyframeTrack';
      var Ctor = THREE[ctorName];
      if (!Ctor) Ctor = THREE.VectorKeyframeTrack;

      var times = (t.type === 'bool' || t.type === 'string')
        ? t.times.slice()
        : new Float32Array(t.times);
      var values = (t.type === 'bool' || t.type === 'string')
        ? t.values.slice()
        : new Float32Array(t.values);

      tracks.push(new Ctor(t.name, times, values));
    }
    return new THREE.AnimationClip(data.name || 'clip', data.duration, tracks);
  }

  /** Enhance sebuah THREE.AnimationClip, kembalikan clip baru + statistik. */
  function enhanceClip(clip, options) {
    var result = Fluidizer.enhance(clipToData(clip), options);
    return { clip: dataToClip(result), stats: result.stats };
  }

  /** Hitung total keyframe sebuah clip (untuk laporan UI). */
  function countKeys(clip) {
    var total = 0;
    for (var i = 0; i < clip.tracks.length; i++) total += clip.tracks[i].times.length;
    return total;
  }

  /**
   * Ambil jalur gerak (world position) sebuah node sepanjang clip, dengan
   * cara benar-benar mengevaluasi clip lewat mixer sementara. Dipakai
   * untuk menggambar motion trail pembanding original vs enhanced.
   */
  function sampleMotionPath(rootObject, clip, nodeName, sampleCount) {
    var target = nodeName ? rootObject.getObjectByName(nodeName) : null;
    if (!target) {
      // fallback: node pertama yang benar-benar dianimasikan posisinya
      for (var i = 0; i < clip.tracks.length; i++) {
        var parsed = THREE.PropertyBinding.parseTrackName(clip.tracks[i].name);
        if (parsed.propertyName !== 'position') continue;
        var candidate = parsed.nodeName ? rootObject.getObjectByName(parsed.nodeName) : rootObject;
        if (candidate) { target = candidate; break; }
      }
    }
    if (!target) return null;

    var mixer = new THREE.AnimationMixer(rootObject);
    var action = mixer.clipAction(clip);
    action.play();

    var points = [];
    var dur = clip.duration || 0;
    var n = Math.max(2, sampleCount | 0);
    var v = new THREE.Vector3();

    for (var s = 0; s < n; s++) {
      var t = dur * s / (n - 1);
      mixer.setTime(t);
      rootObject.updateMatrixWorld(true);
      v.setFromMatrixPosition(target.matrixWorld);
      points.push(v.clone());
    }

    // Cukup hentikan aksinya. Memanggil uncacheClip lalu uncacheRoot pada
    // mixer yang sama di r128 melepas aksi yang sama dua kali dan merusak
    // pembukuan internalnya; mixer sementara ini toh langsung dibuang.
    action.stop();
    return points;
  }

  /**
   * Posisi tiap tulang dalam ruang geometri mesh.
   *
   * boneInverse memetakan ruang skin ke ruang tulang, jadi inversnya
   * memberi titik asal tulang di ruang skin. Ruang skin sendiri adalah
   * posisi geometri setelah bindMatrix, jadi hasilnya dikembalikan lewat
   * bindMatrixInverse supaya sebanding dengan atribut position mentah.
   */
  function boneRestPositions(mesh) {
    var out = [];
    var skeleton = mesh.skeleton;
    if (!skeleton || !skeleton.boneInverses) return out;

    var m = new THREE.Matrix4();
    var v = new THREE.Vector3();
    for (var i = 0; i < skeleton.boneInverses.length; i++) {
      m.copy(skeleton.boneInverses[i]).invert();
      v.setFromMatrixPosition(m);
      v.applyMatrix4(mesh.bindMatrixInverse);
      out.push([v.x, v.y, v.z]);
    }
    return out;
  }

  var ORIGINAL_SKIN = '__mfsOriginalSkin';

  function skinnedMeshes(root) {
    var list = [];
    root.traverse(function (child) {
      if (child.isSkinnedMesh && child.geometry &&
          child.geometry.attributes.skinIndex && child.skeleton) {
        list.push(child);
      }
    });
    return list;
  }

  /**
   * Perbaiki bobot skin seluruh mesh dalam model.
   *
   * Selalu dihitung ulang dari data ASLI, bukan dari hasil perbaikan
   * sebelumnya — kalau tidak, menggeser slider lalu menjalankan ulang akan
   * menghaluskan di atas yang sudah halus sampai envelope-nya lumer.
   */
  function repairSkinning(root, options) {
    var meshes = skinnedMeshes(root);
    var totals = {
      meshes: 0, vertices: 0, orphansFixed: 0, unnormalizedFixed: 0,
      negativeOrInvalidFixed: 0, outOfRangeFixed: 0, influencesPruned: 0,
      weldGroups: 0, verticesChanged: 0,
      maxWeightErrorBefore: 0, maxWeightErrorAfter: 0
    };
    if (!meshes.length) return { meshes: 0, totals: totals };

    // glTF menyimpan 4 pengaruh per set; menyimpang dari itu membuat
    // berkas hasil tidak bisa dibaca sebagian besar mesin.
    var opts = {};
    for (var key in options) if (options.hasOwnProperty(key)) opts[key] = options[key];
    opts.maxInfluences = 4;

    meshes.forEach(function (mesh) {
      var geom = mesh.geometry;
      if (!mesh.userData[ORIGINAL_SKIN]) {
        mesh.userData[ORIGINAL_SKIN] = {
          index: geom.attributes.skinIndex.array.slice(),
          weight: geom.attributes.skinWeight.array.slice(),
          itemSize: geom.attributes.skinIndex.itemSize
        };
      }
      var original = mesh.userData[ORIGINAL_SKIN];

      var result = SkinFix.repair({
        position: geom.attributes.position.array,
        index: geom.index ? geom.index.array : null,
        skinIndex: original.index,
        skinWeight: original.weight,
        vertexCount: geom.attributes.position.count,
        boneCount: mesh.skeleton.bones.length,
        bonePositions: boneRestPositions(mesh)
      }, opts);

      geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(result.skinIndex, 4));
      geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(result.skinWeight, 4));

      var s = result.stats;
      totals.meshes++;
      totals.vertices += s.vertexCount;
      totals.orphansFixed += s.orphansFixed;
      totals.unnormalizedFixed += s.unnormalizedFixed;
      totals.negativeOrInvalidFixed += s.negativeOrInvalidFixed;
      totals.outOfRangeFixed += s.outOfRangeFixed;
      totals.influencesPruned += s.influencesPruned;
      totals.weldGroups += s.weldGroups;
      totals.verticesChanged += s.verticesChanged;
      totals.maxWeightErrorBefore = Math.max(totals.maxWeightErrorBefore, s.maxWeightErrorBefore);
      totals.maxWeightErrorAfter = Math.max(totals.maxWeightErrorAfter, s.maxWeightErrorAfter);
    });

    return { meshes: totals.meshes, totals: totals };
  }

  /** Kembalikan bobot skin ke data asli yang disimpan saat perbaikan pertama. */
  function restoreSkinning(root) {
    var restored = 0;
    skinnedMeshes(root).forEach(function (mesh) {
      var original = mesh.userData[ORIGINAL_SKIN];
      if (!original) return;
      mesh.geometry.setAttribute('skinIndex',
        new THREE.Uint16BufferAttribute(original.index.slice(), original.itemSize));
      mesh.geometry.setAttribute('skinWeight',
        new THREE.Float32BufferAttribute(original.weight.slice(), original.itemSize));
      restored++;
    });
    return restored;
  }

  function hasSkinning(root) {
    return skinnedMeshes(root).length > 0;
  }

  root.ThreeAdapter = {
    repairSkinning: repairSkinning,
    restoreSkinning: restoreSkinning,
    hasSkinning: hasSkinning,
    boneRestPositions: boneRestPositions,
    clipToData: clipToData,
    dataToClip: dataToClip,
    enhanceClip: enhanceClip,
    countKeys: countKeys,
    sampleMotionPath: sampleMotionPath,
    trackType: trackType
  };
})(typeof self !== 'undefined' ? self : this);
