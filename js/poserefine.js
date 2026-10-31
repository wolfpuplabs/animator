/*
 * poserefine.js — bereskan titik sendi hasil deteksi pose SEBELUM
 * diubah jadi rotasi tulang.
 *
 * Kenapa perlu lapisan sendiri. posemocap.js menyimpulkan rotasi dengan
 * mengarahkan tiap tulang ke sendi anaknya. Artinya seluruh kesalahan
 * posisi sendi masuk langsung jadi kesalahan rotasi, dan kesalahan
 * sendi di pangkal rantai ikut memutar seluruh anggota badan di
 * bawahnya. Deteksi pose satu kamera punya tiga cacat yang selalu ada:
 *
 *   1. Sendi yang tertutup hilang beberapa frame. Tanpa penanganan,
 *      rotasinya ditahan — anggota badannya membeku, lalu menyentak
 *      saat terbaca lagi. Padahal untuk kedipan pendek, frame sebelum
 *      dan sesudahnya tahu jawabannya. (Untuk celah panjang memang
 *      ditahan, dan itu disengaja: lihat maxGapSeconds.)
 *   2. Setiap frame ditebak sendiri-sendiri, jadi ada derau frekuensi
 *      tinggi: sendi bergetar walau orangnya diam.
 *   3. Kedalaman (z) jauh lebih buruk daripada x dan y. Akibatnya
 *      panjang tulang berubah-ubah tiap frame, padahal tulang orang
 *      tidak memanjang-memendek.
 *
 * Yang dikerjakan di sini, berurutan:
 *
 *   isiCelah  — sendi yang hilang sebentar diinterpolasi dari frame
 *               terdekat yang terbaca, bukan ditahan.
 *   haluskan  — pencocokan kuadratik berbobot (Savitzky-Golay) dengan
 *               bobot = keyakinan deteksi. Derau hilang tapi puncak
 *               gerakan tidak ikut terpangkas seperti pada rata-rata
 *               bergerak biasa.
 *
 * Cacat ketiga — panjang tulang yang berubah-ubah — TIDAK dibetulkan,
 * dan itu keputusan yang mahal didapat. Pernah ada tahap ketiga yang
 * memaksa panjang tiap tulang ke median seluruh frame, dengan
 * koreksinya dibebankan ke z karena z yang paling buruk. Diukur
 * terhadap kebenaran acuan buatan tahap itu tampak yang paling berguna
 * dari ketiganya. Diukur pada keluaran MediaPipe sungguhan dia
 * MENAIKKAN sentakan antar-frame dari 1,78° jadi 4,42° per frame, dan
 * tidak ada satu pun setelan yang menyelamatkannya.
 *
 * Sebabnya: kendala panjang tulang berdiri di atas anggapan bahwa
 * selisih panjang itu derau pengukuran yang berdiri sendiri-sendiri.
 * Kesalahan MediaPipe tidak begitu — dia terstruktur. Anggota badan
 * yang terjepit menghadap kamera diringkusnya jadi sepertiga
 * panjangnya, utuh dan konsisten dengan dirinya sendiri. Memaksa
 * panjangnya pas di frame seperti itu bukan membetulkan pengukuran,
 * tapi mengarang arah tulang dengan percaya diri. Ceritanya lengkap di
 * tests/fixtures/README.md, dan 70 frame yang membuktikannya ikut
 * disimpan supaya tahap itu tidak pernah kembali diam-diam.
 *
 * Sebaran panjang tulang tetap DIUKUR dan dilaporkan, cuma tidak
 * dikoreksi: angkanya diagnosis yang bagus soal seberapa payah
 * detektornya di satu video — di bawah 1 persen pada klip mudah,
 * sekitar 10 persen saat sujud.
 *
 * Yang juga tidak dikerjakan: tidak ada batas sudut sendi, dan twist
 * tetap tebakan. Siku yang hiperekstensi masih mungkin lolos. Keduanya
 * butuh prior yang dipelajari dari data, bukan aturan tangan — lihat
 * README soal MoCapAnything untuk jalur itu.
 *
 * Masukan dan keluarannya format frame yang sama dengan posemocap.js,
 * jadi modul ini bisa dilepas tanpa mengubah apa pun di hilirnya.
 * Tidak bergantung pada three.js maupun MediaPipe.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.PoseRefine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-8;

  /* ------------------------------------------------------------------ *
   * Rantai tulang dalam ruang landmark
   * ------------------------------------------------------------------ *
   * Indeks mengikuti MediaPipe Pose. Dua simpul semu, 'hipCenter' dan
   * 'shoulderCenter', dipakai sebagai pangkal: keduanya titik tengah,
   * jadi deraunya saling meniadakan dan jauh lebih tenang daripada
   * landmark tunggal mana pun. hipCenter adalah akar dan tidak pernah
   * dikoreksi — semua koreksi diukur dari sana.
   *
   * Urutannya penting: induk harus sudah dikoreksi sebelum anaknya.
   */
  var LM = {
    nose: 0, leftEar: 7, rightEar: 8,
    leftShoulder: 11, rightShoulder: 12,
    leftElbow: 13, rightElbow: 14,
    leftWrist: 15, rightWrist: 16,
    leftIndex: 19, rightIndex: 20,
    leftHip: 23, rightHip: 24,
    leftKnee: 25, rightKnee: 26,
    leftAnkle: 27, rightAnkle: 28,
    leftFootIndex: 31, rightFootIndex: 32
  };

  var HIP_CENTER = 'hipCenter';
  var SHOULDER_CENTER = 'shoulderCenter';

  // [induk, anak] — anak berupa indeks landmark, atau simpul semu.
  var CHAIN = [
    [HIP_CENTER, LM.leftHip],
    [HIP_CENTER, LM.rightHip],
    [HIP_CENTER, SHOULDER_CENTER],

    [SHOULDER_CENTER, LM.leftShoulder],
    [SHOULDER_CENTER, LM.rightShoulder],
    [SHOULDER_CENTER, LM.nose],
    [SHOULDER_CENTER, LM.leftEar],
    [SHOULDER_CENTER, LM.rightEar],

    [LM.leftShoulder, LM.leftElbow],
    [LM.leftElbow, LM.leftWrist],
    [LM.leftWrist, LM.leftIndex],

    [LM.rightShoulder, LM.rightElbow],
    [LM.rightElbow, LM.rightWrist],
    [LM.rightWrist, LM.rightIndex],

    [LM.leftHip, LM.leftKnee],
    [LM.leftKnee, LM.leftAnkle],
    [LM.leftAnkle, LM.leftFootIndex],

    [LM.rightHip, LM.rightKnee],
    [LM.rightKnee, LM.rightAnkle],
    [LM.rightAnkle, LM.rightFootIndex]
  ];

  // Setiap landmark yang ikut dibereskan. Sisanya (mata, mulut, jempol,
  // tumit) tidak dipakai rig, jadi dibiarkan apa adanya.
  var TRACKED = (function () {
    var seen = {}, out = [];
    for (var k in LM) if (LM.hasOwnProperty(k)) {
      if (!seen[LM[k]]) { seen[LM[k]] = 1; out.push(LM[k]); }
    }
    return out.sort(function (a, b) { return a - b; });
  })();

  var DEFAULTS = {
    minVisibility: 0.4,  // di bawah ini sendi dianggap tidak terbaca
    // Celah lebih panjang dari ini tidak diisi. Dihitung dari
    // `maxGapSeconds` kalau laju sampling diketahui — sepuluh frame
    // berarti hal yang sangat berbeda pada 12 fps dan pada 30 fps, dan
    // yang menentukan apakah sebuah kedipan masih bisa ditebak adalah
    // berapa lama, bukan berapa frame.
    maxGap: 10,
    // Nol koma empat detik. Batas ini diukur, bukan dipilih: pada
    // fixture sujud, siku kanan hilang delapan frame (sepertiga detik),
    // dan dengan batas lama 6 frame celah itu TIDAK diisi — rotasinya
    // dibekukan lalu menyentak 58° di frame saat siku muncul kembali,
    // dan penghalusan malah memperbesarnya jadi 76°. Dijembatani, frame
    // yang sama cuma bergerak 13°. Jauh di atas setengah detik
    // penjembatanan berhenti jadi penafsiran dan mulai jadi karangan,
    // jadi batasnya tidak dinaikkan lagi walau angkanya masih membaik.
    maxGapSeconds: 0.4,
    // Lebar jendela Savitzky-Golay, dalam frame, ganjil. Tujuh adalah
    // batas atasnya dan itu diukur, bukan ditebak: pada 24 fps jendela
    // 7 masih menyimpan 87% amplitudo gerakan 3 Hz dan 97% gerakan
    // 2 Hz — kira-kira secepat lambaian tangan. Jendela 9 memangkas
    // sepertiga gerakan 3 Hz, dan itu terlihat sebagai gerakan yang
    // jadi lemas.
    window: 7,
    // Kalau laju sampling tangkapan diketahui, lebar jendela dihitung
    // dari durasi ini, bukan dari jumlah frame — supaya tangkapan 12 fps
    // dan 30 fps dihaluskan sekuat yang sama dalam satuan waktu.
    sampleFps: 0,
    windowSeconds: 0.29,
    gapFill: true,
    smooth: true
  };

  function resolveOptions(options) {
    var out = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
    if (options) {
      for (var j in options) {
        if (options.hasOwnProperty(j) && options[j] !== undefined && DEFAULTS.hasOwnProperty(j)) {
          out[j] = options[j];
        }
      }
    }
    if (out.sampleFps > 0 && out.windowSeconds > 0) {
      out.window = Math.round(out.sampleFps * out.windowSeconds);
    }
    if (out.sampleFps > 0 && out.maxGapSeconds > 0) {
      out.maxGap = Math.max(1, Math.round(out.sampleFps * out.maxGapSeconds));
    }
    if (out.window < 3) out.window = 3;
    if (out.window > 9) out.window = 9;   // di atas ini gerakan nyata ikut hilang
    if (out.window % 2 === 0) out.window++;
    return out;
  }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) * 0.5;
  }

  function visibilityOf(p) {
    if (!p) return 0;
    return (p.visibility === undefined) ? 1 : p.visibility;
  }

  /**
   * Salinan dalam frame-nya.
   *
   * Modul ini TIDAK boleh mengubah masukannya: pemanggil memakai
   * frame mentah untuk statistik "sebelum", dan uji perbandingan
   * sebelum/sesudah jadi tidak berarti kalau yang dibandingkan ternyata
   * objek yang sama.
   */
  function cloneFrames(frames) {
    return frames.map(function (frame) {
      var lms = frame.landmarks;
      return {
        time: frame.time,
        landmarks: lms ? lms.map(function (p) {
          if (!p) return p;
          return { x: p.x, y: p.y, z: p.z, visibility: visibilityOf(p) };
        }) : lms
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 1. Isi celah
   * ------------------------------------------------------------------ */

  /**
   * Sendi yang hilang beberapa frame diisi dengan interpolasi linear
   * dari frame terbaca terdekat di kedua sisinya.
   *
   * Celah di ujung rekaman (tidak ada frame terbaca di salah satu sisi)
   * TIDAK diisi: ekstrapolasi dari satu sisi saja gampang melayang jauh,
   * dan hilir sudah punya penanganan untuk sendi yang memang hilang.
   */
  function fillGaps(frames, opt, stats) {
    TRACKED.forEach(function (idx) {
      var ok = [];
      frames.forEach(function (frame, i) {
        var p = frame.landmarks && frame.landmarks[idx];
        if (p && visibilityOf(p) >= opt.minVisibility) ok.push(i);
      });
      if (ok.length < 2) return;

      for (var n = 0; n < ok.length - 1; n++) {
        var a = ok[n], b = ok[n + 1];
        var gap = b - a - 1;
        if (gap <= 0 || gap > opt.maxGap) continue;

        var pa = frames[a].landmarks[idx];
        var pb = frames[b].landmarks[idx];
        for (var i = a + 1; i < b; i++) {
          var lms = frames[i].landmarks;
          if (!lms) continue;
          var t = (i - a) / (b - a);
          var vis = visibilityOf(pa) + (visibilityOf(pb) - visibilityOf(pa)) * t;
          lms[idx] = {
            x: pa.x + (pb.x - pa.x) * t,
            y: pa.y + (pb.y - pa.y) * t,
            z: pa.z + (pb.z - pa.z) * t,
            // Keyakinannya dinaikkan sampai lolos ambang — kalau tidak,
            // hasil interpolasi yang sudah benar tetap dibuang di hilir.
            visibility: Math.max(opt.minVisibility, vis),
            filled: true
          };
          stats.gapsFilled++;
        }
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. Haluskan
   * ------------------------------------------------------------------ */

  /**
   * Pencocokan kuadratik berbobot pada jendela terpusat, lalu dibaca di
   * titik tengahnya (Savitzky-Golay).
   *
   * Dibandingkan rata-rata bergerak: rata-rata bergerak memangkas
   * puncak gerakan, jadi lambaian jadi lebih pendek daripada aslinya.
   * Kuadratik bisa mengikuti lengkungan, jadi yang hilang cuma derau.
   *
   * Bobotnya keyakinan deteksi: frame yang ragu ikut menarik hasil
   * sedikit saja, frame yang hilang tidak ikut sama sekali.
   */
  function smoothSeries(values, weights) {
    var n = values.length;
    var half = (smoothSeries.window - 1) >> 1;
    var out = new Array(n);

    for (var i = 0; i < n; i++) {
      var s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      var t0 = 0, t1 = 0, t2 = 0;
      var vmin = Infinity, vmax = -Infinity;
      var lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);

      for (var j = lo; j <= hi; j++) {
        var w = weights[j];
        if (!(w > 0)) continue;
        var v = values[j];
        var u = j - i, u2 = u * u;
        s0 += w;      s1 += w * u;       s2 += w * u2;
        s3 += w * u2 * u;                s4 += w * u2 * u2;
        t0 += w * v;
        t1 += w * v * u;
        t2 += w * v * u2;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }

      if (!(s0 > 0)) { out[i] = values[i]; continue; }

      // Tiga titik berbobot minimum untuk kuadratik; kurang dari itu
      // sistemnya singular dan rata-rata berbobot sudah yang terbaik.
      var det = s0 * (s2 * s4 - s3 * s3)
              - s1 * (s1 * s4 - s3 * s2)
              + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) < 1e-12) { out[i] = t0 / s0; continue; }

      // Cuma suku konstan yang dibutuhkan: itu nilai di titik tengah.
      var a = (t0 * (s2 * s4 - s3 * s3)
             - s1 * (t1 * s4 - t2 * s3)
             + s2 * (t1 * s3 - t2 * s2)) / det;

      // Hasilnya dikurung ke rentang sampel yang dipakai.
      //
      // Pencocokan kuadratik bisa MELEWATI rentang datanya sendiri —
      // ringing yang sama seperti pada filter polinomial mana pun.
      // Terukur di sini: pada tangga satu satuan dia melesat 0,095
      // satuan tepat di sisi tangganya, dan di tepi array sekitar 0,014
      // pada data berkelengkungan tinggi. Pada gerakan yang mulus dia
      // tidak melesat sama sekali, dan pada 70 frame fixture sujud
      // pengurungan ini terukur TIDAK mengubah hasil akhirnya — 3,79
      // derajat per frame dengan dan tanpa.
      //
      // Jadi dua baris ini bukan perbaikan, melainkan pagar: biayanya
      // nol dan dia membuat satu kelas kesalahan jadi mustahil, bukan
      // cuma jarang. Sendi yang berhenti mendadak — tangan yang
      // menyentuh lantai, kaki yang menapak — adalah tangga, dan di
      // situlah ringing muncul.
      //
      // Catatan untuk yang akan menyentuh bagian ini: versi yang
      // menyusutkan jendela sampai simetris di kedua sisi pernah
      // dicoba, dengan alasan teori yang benar bahwa jendela berat
      // sebelah menggeser fase. Diukur pada fixture yang sama dia
      // sedikit lebih BURUK di setiap panjang celah, karena
      // menghaluskan lebih sedikit frame. Teorinya benar, ongkosnya
      // lebih besar daripada yang dihematnya.
      if (a < vmin) a = vmin;
      else if (a > vmax) a = vmax;

      out[i] = a;
    }
    return out;
  }
  smoothSeries.window = DEFAULTS.window;

  function smoothLandmarks(frames, opt, stats) {
    smoothSeries.window = opt.window;
    var n = frames.length;

    TRACKED.forEach(function (idx) {
      var xs = new Array(n), ys = new Array(n), zs = new Array(n), ws = new Array(n);
      var any = false;

      for (var i = 0; i < n; i++) {
        var p = frames[i].landmarks && frames[i].landmarks[idx];
        var vis = visibilityOf(p);
        if (p && vis >= opt.minVisibility) {
          xs[i] = p.x; ys[i] = p.y; zs[i] = p.z; ws[i] = vis;
          any = true;
        } else {
          xs[i] = p ? p.x : 0; ys[i] = p ? p.y : 0; zs[i] = p ? p.z : 0; ws[i] = 0;
        }
      }
      if (!any) return;

      var sx = smoothSeries(xs, ws), sy = smoothSeries(ys, ws), sz = smoothSeries(zs, ws);
      for (var k = 0; k < n; k++) {
        if (!(ws[k] > 0)) continue;
        var q = frames[k].landmarks[idx];
        q.x = sx[k]; q.y = sy[k]; q.z = sz[k];
        stats.smoothed++;
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 3. Kunci panjang tulang
   * ------------------------------------------------------------------ */

  /** Titik sendi, termasuk simpul semu, untuk satu frame. */
  function readJoints(frame, opt) {
    var lms = frame.landmarks;
    var j = {};
    if (!lms) return j;

    TRACKED.forEach(function (idx) {
      var p = lms[idx];
      if (p && visibilityOf(p) >= opt.minVisibility) j[idx] = [p.x, p.y, p.z];
    });

    var lh = j[LM.leftHip], rh = j[LM.rightHip];
    if (lh && rh) j[HIP_CENTER] = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2, (lh[2] + rh[2]) / 2];
    var ls = j[LM.leftShoulder], rs = j[LM.rightShoulder];
    if (ls && rs) j[SHOULDER_CENTER] = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2];
    return j;
  }

  function segmentLength(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Median panjang tiap segmen rantai di seluruh frame. */
  function measureChain(frames, opt) {
    var samples = CHAIN.map(function () { return []; });
    frames.forEach(function (frame) {
      var j = readJoints(frame, opt);
      CHAIN.forEach(function (edge, e) {
        var a = j[edge[0]], b = j[edge[1]];
        if (a && b) {
          var len = segmentLength(a, b);
          if (len > EPS) samples[e].push(len);
        }
      });
    });
    return samples.map(median);
  }

  /**
   * Sebaran panjang tulang, dalam persen dari panjang medianya.
   *
   * Ini ukuran langsung seberapa buruk kedalaman deteksi: tulang orang
   * tidak memanjang-memendek, jadi setiap persen di sini adalah murni
   * kesalahan. Dipakai di statistik supaya perbaikannya bisa dilihat
   * sebagai angka, bukan cuma dirasakan.
   */
  function boneLengthSpread(frames, opt) {
    var lens = measureChain(frames, opt);
    var worst = 0, sum = 0, count = 0;

    frames.forEach(function (frame) {
      var j = readJoints(frame, opt);
      CHAIN.forEach(function (edge, e) {
        var a = j[edge[0]], b = j[edge[1]];
        if (!a || !b || !(lens[e] > EPS)) return;
        var rel = Math.abs(segmentLength(a, b) - lens[e]) / lens[e];
        if (rel > worst) worst = rel;
        sum += rel; count++;
      });
    });

    return {
      mean: count ? (sum / count) * 100 : 0,
      max: worst * 100
    };
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {Array} frames [{ time, landmarks:[{x,y,z,visibility}] }]
   * @param {Object} options lihat DEFAULTS
   * @returns {{frames:Array, stats:Object}} frame BARU; masukannya utuh
   */
  function refine(frames, options) {
    var opt = resolveOptions(options);
    var stats = {
      frames: frames ? frames.length : 0,
      gapsFilled: 0,
      smoothed: 0,
      // Diagnosis, bukan sesuatu yang dikoreksi — lihat catatan di
      // kepala berkas ini.
      spread: { mean: 0, max: 0 }
    };

    if (!frames || frames.length === 0) return { frames: [], stats: stats };

    var out = cloneFrames(frames);

    if (opt.gapFill) fillGaps(out, opt, stats);
    if (opt.smooth) smoothLandmarks(out, opt, stats);

    stats.spread = boneLengthSpread(out, opt);
    return { frames: out, stats: stats };
  }

  return {
    refine: refine,
    DEFAULTS: DEFAULTS,
    CHAIN: CHAIN,
    LM: LM,
    TRACKED: TRACKED,
    resolveOptions: resolveOptions,
    boneLengthSpread: boneLengthSpread,
    _internal: {
      median: median,
      cloneFrames: cloneFrames,
      fillGaps: fillGaps,
      smoothLandmarks: smoothLandmarks,
      smoothSeries: smoothSeries,
      measureChain: measureChain,
      readJoints: readJoints
    }
  };
});
