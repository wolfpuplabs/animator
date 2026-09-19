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

  root.ThreeAdapter = {
    clipToData: clipToData,
    dataToClip: dataToClip,
    enhanceClip: enhanceClip,
    countKeys: countKeys,
    sampleMotionPath: sampleMotionPath,
    trackType: trackType
  };
})(typeof self !== 'undefined' ? self : this);
