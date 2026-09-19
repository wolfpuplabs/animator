/*
 * skinfix.js — perbaikan bobot skin dan envelope.
 *
 * Ini bukan soal frame. Menambah frame membuat gerakan lebih halus, tapi
 * kalau bobot skin-nya sendiri rusak, deformasinya tetap jelek di setiap
 * frame — lengan menciut waktu diputar, vertex nyangkut di tempat, batas
 * pengaruh tulang bergerigi.
 *
 * Yang diperbaiki:
 *
 *   1. Sanitasi   — bobot negatif, NaN, indeks tulang di luar jangkauan.
 *   2. Prune      — buang pengaruh remeh yang hanya jadi derau.
 *   3. Orphan     — vertex tanpa pengaruh sama sekali; tanpa ini mereka
 *                   runtuh ke titik asal saat model dianimasikan.
 *   4. Envelope   — haluskan medan bobot antar-vertex bertetangga, yang
 *                   memperbaiki batas pengaruh bergerigi dan efek
 *                   "candy wrapper" saat sendi dipuntir.
 *   5. Normalisasi— jumlah bobot per vertex harus 1. Kalau tidak, mesh
 *                   mengempis atau meledak saat tulang bergerak.
 *
 * Tidak bergantung pada three.js — array angka biasa, bisa diuji di node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.SkinFix = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-8;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var DEFAULTS = {
    maxInfluences: 4,    // glTF menyimpan 4 per set; lebih dari itu perlu set tambahan
    minWeight: 0.01,     // di bawah ini pengaruhnya tak terlihat, hanya menambah derau
    smoothing: 0.5,      // kekuatan penghalusan envelope, 0 = mati
    iterations: 2,
    weldTolerance: 1e-5, // vertex sedekat ini dianggap titik yang sama
    fixOrphans: true
  };

  function resolveOptions(options) {
    var out = {};
    for (var key in DEFAULTS) if (DEFAULTS.hasOwnProperty(key)) out[key] = DEFAULTS[key];
    if (options) {
      for (var k in options) if (options.hasOwnProperty(k) && options[k] !== undefined) out[k] = options[k];
    }
    out.maxInfluences = Math.max(1, Math.min(8, out.maxInfluences | 0));
    out.minWeight = clamp(out.minWeight, 0, 0.5);
    out.smoothing = clamp(out.smoothing, 0, 1);
    out.iterations = Math.max(0, Math.min(10, out.iterations | 0));
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Weld: satukan vertex yang berbagi posisi
   * ------------------------------------------------------------------ *
   * Mesh glTF hampir selalu terbelah di jahitan UV dan normal: satu titik
   * di permukaan bisa jadi tiga vertex terpisah yang tidak terhubung di
   * buffer indeks. Kalau penghalusan dijalankan di atas topologi mentah,
   * tiap sisi jahitan dihaluskan sendiri-sendiri dan hasilnya justru
   * meninggalkan garis jahitan yang kelihatan.
   */
  function buildWeld(position, vertexCount, tolerance) {
    var groupOf = new Int32Array(vertexCount);
    var members = [];
    var lookup = Object.create(null);
    var inv = 1 / Math.max(tolerance, 1e-9);

    for (var i = 0; i < vertexCount; i++) {
      var x = Math.round(position[i * 3] * inv);
      var y = Math.round(position[i * 3 + 1] * inv);
      var z = Math.round(position[i * 3 + 2] * inv);
      var key = x + '|' + y + '|' + z;
      var g = lookup[key];
      if (g === undefined) {
        g = members.length;
        lookup[key] = g;
        members.push([i]);
      } else {
        members[g].push(i);
      }
      groupOf[i] = g;
    }
    return { groupOf: groupOf, members: members };
  }

  /** Ketetanggaan antar-grup weld, diambil dari sisi segitiga. */
  function buildAdjacency(index, vertexCount, groupOf, groupCount) {
    var sets = new Array(groupCount);
    for (var g = 0; g < groupCount; g++) sets[g] = Object.create(null);

    function link(a, b) {
      var ga = groupOf[a], gb = groupOf[b];
      if (ga === gb) return;
      sets[ga][gb] = 1;
      sets[gb][ga] = 1;
    }

    if (index && index.length) {
      for (var t = 0; t + 2 < index.length; t += 3) {
        link(index[t], index[t + 1]);
        link(index[t + 1], index[t + 2]);
        link(index[t + 2], index[t]);
      }
    } else {
      for (var v = 0; v + 2 < vertexCount; v += 3) {
        link(v, v + 1);
        link(v + 1, v + 2);
        link(v + 2, v);
      }
    }

    var out = new Array(groupCount);
    for (var k = 0; k < groupCount; k++) {
      var keys = Object.keys(sets[k]);
      var arr = new Int32Array(keys.length);
      for (var n = 0; n < keys.length; n++) arr[n] = +keys[n];
      out[k] = arr;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Operasi pada satu daftar pengaruh
   * ------------------------------------------------------------------ */

  /** Daftar pengaruh = array {idx, w}. Disortir besar ke kecil. */
  function prune(list, maxInfluences, minWeight) {
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].w > minWeight) kept.push(list[i]);
    }
    // Kalau semua di bawah ambang, jangan buang semuanya — sisakan yang
    // terbesar, kalau tidak vertexnya jadi orphan buatan kita sendiri.
    if (!kept.length && list.length) {
      var best = list[0];
      for (var j = 1; j < list.length; j++) if (list[j].w > best.w) best = list[j];
      if (best.w > 0) kept.push(best);
    }
    kept.sort(function (a, b) { return b.w - a.w; });
    if (kept.length > maxInfluences) kept.length = maxInfluences;
    return kept;
  }

  function normalize(list) {
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i].w;
    if (sum < EPS) return false;
    var inv = 1 / sum;
    for (var j = 0; j < list.length; j++) list[j].w *= inv;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} mesh {position, index, skinIndex, skinWeight, vertexCount,
   *                       bonePositions?, boneCount?}
   *        bonePositions dipakai untuk menambal vertex orphan: dipilih
   *        tulang terdekat dari posisi vertex (ruang bind).
   * @param {Object} options lihat DEFAULTS
   * @returns {{skinIndex, skinWeight, stats}}
   */
  function repair(mesh, options) {
    var opt = resolveOptions(options);
    var count = mesh.vertexCount;
    var srcIndex = mesh.skinIndex;
    var srcWeight = mesh.skinWeight;
    var stride = Math.max(1, Math.round(srcWeight.length / Math.max(count, 1)));
    var boneCount = mesh.boneCount ||
      (mesh.bonePositions ? mesh.bonePositions.length : 0);

    var stats = {
      vertexCount: count,
      stride: stride,
      orphansFixed: 0,
      unnormalizedFixed: 0,
      negativeOrInvalidFixed: 0,
      outOfRangeFixed: 0,
      influencesPruned: 0,
      maxInfluencesBefore: 0,
      maxInfluencesAfter: 0,
      weldGroups: 0,
      smoothedGroups: 0,
      verticesChanged: 0,
      maxWeightErrorBefore: 0,
      maxWeightErrorAfter: 0
    };

    // --- 1 & 2: sanitasi + prune
    var lists = new Array(count);
    for (var v = 0; v < count; v++) {
      var raw = [];
      var sum = 0;
      var used = 0;
      for (var s = 0; s < stride; s++) {
        var bi = srcIndex[v * stride + s];
        var w = srcWeight[v * stride + s];

        if (!isFinite(w) || w < 0) { w = 0; stats.negativeOrInvalidFixed++; }
        if (!isFinite(bi) || bi < 0 || (boneCount && bi >= boneCount)) {
          if (w > 0) stats.outOfRangeFixed++;
          bi = 0; w = 0;
        }
        if (w > 0) { used++; sum += w; raw.push({ idx: bi | 0, w: w }); }
      }
      if (used > stats.maxInfluencesBefore) stats.maxInfluencesBefore = used;
      var err = Math.abs(sum - 1);
      if (used > 0 && err > stats.maxWeightErrorBefore) stats.maxWeightErrorBefore = err;

      var pruned = prune(raw, opt.maxInfluences, opt.minWeight);
      stats.influencesPruned += Math.max(0, raw.length - pruned.length);
      lists[v] = pruned;
    }

    // --- 3: vertex tanpa pengaruh
    if (opt.fixOrphans) {
      for (var o = 0; o < count; o++) {
        if (lists[o].length) continue;
        stats.orphansFixed++;
        lists[o] = [{ idx: nearestBone(mesh, o), w: 1 }];
      }
    }

    // --- 4: penghalusan envelope
    var weld = null;
    if (opt.smoothing > 0 && opt.iterations > 0 && count > 2) {
      weld = buildWeld(mesh.position, count, opt.weldTolerance);
      stats.weldGroups = weld.members.length;
      var adjacency = buildAdjacency(mesh.index, count, weld.groupOf, weld.members.length);
      smoothEnvelope(lists, weld, adjacency, opt, stats);
    }

    // --- 5: normalisasi akhir
    var outIndex = new Uint16Array(count * opt.maxInfluences);
    var outWeight = new Float32Array(count * opt.maxInfluences);

    /*
     * Berapa vertex yang bobotnya benar-benar berubah.
     *
     * Ini ukuran yang jujur tentang seberapa banyak kerja yang terjadi.
     * Menghitung "bobot yang dinormalisasi" saja menyesatkan pada berkas
     * glTF: GLTFLoader sudah memanggil normalizeSkinWeights saat impor,
     * jadi angka itu praktis selalu nol di sana meski perbaikan lain
     * (pemangkasan pengaruh remeh, penghalusan envelope) tetap bekerja.
     */
    function changedFromSource(v, list) {
      var src = Object.create(null);
      for (var s = 0; s < stride; s++) {
        var w = srcWeight[v * stride + s];
        if (isFinite(w) && w > 0) src[srcIndex[v * stride + s]] = (src[srcIndex[v * stride + s]] || 0) + w;
      }
      var seen = Object.create(null);
      for (var i = 0; i < list.length; i++) {
        seen[list[i].idx] = 1;
        if (Math.abs((src[list[i].idx] || 0) - list[i].w) > 1e-4) return true;
      }
      for (var key in src) if (!seen[key] && src[key] > 1e-4) return true;
      return false;
    }

    for (var k = 0; k < count; k++) {
      var list = lists[k];
      var before = 0;
      for (var a = 0; a < list.length; a++) before += list[a].w;
      if (Math.abs(before - 1) > 1e-4 && list.length) stats.unnormalizedFixed++;
      if (!normalize(list) && list.length) { list[0].w = 1; }

      if (list.length > stats.maxInfluencesAfter) stats.maxInfluencesAfter = list.length;
      if (changedFromSource(k, list)) stats.verticesChanged++;

      var after = 0;
      for (var b = 0; b < list.length; b++) {
        outIndex[k * opt.maxInfluences + b] = list[b].idx;
        outWeight[k * opt.maxInfluences + b] = list[b].w;
        after += list[b].w;
      }
      if (list.length) {
        var e2 = Math.abs(after - 1);
        if (e2 > stats.maxWeightErrorAfter) stats.maxWeightErrorAfter = e2;
      }
    }

    stats.influencesPerVertex = opt.maxInfluences;
    return { skinIndex: outIndex, skinWeight: outWeight, stats: stats };
  }

  /** Tulang terdekat dari sebuah vertex, untuk menambal orphan. */
  function nearestBone(mesh, vertexIndex) {
    var bones = mesh.bonePositions;
    if (!bones || !bones.length) return 0;
    var px = mesh.position[vertexIndex * 3];
    var py = mesh.position[vertexIndex * 3 + 1];
    var pz = mesh.position[vertexIndex * 3 + 2];
    var best = 0, bestD = Infinity;
    for (var i = 0; i < bones.length; i++) {
      var dx = bones[i][0] - px, dy = bones[i][1] - py, dz = bones[i][2] - pz;
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Penghalusan Laplacian pada medan bobot.
   *
   * Dikerjakan per grup weld, bukan per vertex, supaya jahitan UV tidak
   * ikut jadi batas penghalusan. Hasil tiap iterasi langsung dipangkas
   * kembali ke batas pengaruh, kalau tidak jumlah pengaruh per vertex akan
   * membengkak tiap iterasi.
   */
  function smoothEnvelope(lists, weld, adjacency, opt, stats) {
    var members = weld.members;
    var groupCount = members.length;

    // bobot gabungan per grup (rata-rata anggotanya)
    var groupWeights = new Array(groupCount);
    for (var g = 0; g < groupCount; g++) {
      groupWeights[g] = mergeLists(members[g].map(function (v) { return lists[v]; }));
    }

    for (var iter = 0; iter < opt.iterations; iter++) {
      var next = new Array(groupCount);
      for (var i = 0; i < groupCount; i++) {
        var neighbors = adjacency[i];
        if (!neighbors.length) { next[i] = groupWeights[i]; continue; }

        var acc = Object.create(null);
        var own = groupWeights[i];
        for (var a = 0; a < own.length; a++) {
          acc[own[a].idx] = (acc[own[a].idx] || 0) + own[a].w * (1 - opt.smoothing);
        }
        var share = opt.smoothing / neighbors.length;
        for (var n = 0; n < neighbors.length; n++) {
          var nb = groupWeights[neighbors[n]];
          for (var b = 0; b < nb.length; b++) {
            acc[nb[b].idx] = (acc[nb[b].idx] || 0) + nb[b].w * share;
          }
        }

        var list = [];
        for (var key in acc) list.push({ idx: +key, w: acc[key] });
        list = prune(list, opt.maxInfluences, opt.minWeight);
        normalize(list);
        next[i] = list;
        if (iter === 0) stats.smoothedGroups++;
      }
      groupWeights = next;
    }

    // sebarkan kembali ke tiap vertex anggota grup
    for (var gg = 0; gg < groupCount; gg++) {
      var src = groupWeights[gg];
      var group = members[gg];
      for (var m = 0; m < group.length; m++) {
        lists[group[m]] = src.map(function (e) { return { idx: e.idx, w: e.w }; });
      }
    }
  }

  /** Gabungkan beberapa daftar pengaruh jadi satu rata-rata. */
  function mergeLists(listArray) {
    if (listArray.length === 1) {
      return listArray[0].map(function (e) { return { idx: e.idx, w: e.w }; });
    }
    var acc = Object.create(null);
    for (var i = 0; i < listArray.length; i++) {
      var l = listArray[i];
      for (var j = 0; j < l.length; j++) acc[l[j].idx] = (acc[l[j].idx] || 0) + l[j].w;
    }
    var out = [];
    for (var key in acc) out.push({ idx: +key, w: acc[key] / listArray.length });
    normalize(out);
    return out;
  }

  return {
    repair: repair,
    DEFAULTS: DEFAULTS,
    resolveOptions: resolveOptions,
    _internal: {
      buildWeld: buildWeld,
      buildAdjacency: buildAdjacency,
      prune: prune,
      normalize: normalize,
      mergeLists: mergeLists,
      nearestBone: nearestBone
    }
  };
});
