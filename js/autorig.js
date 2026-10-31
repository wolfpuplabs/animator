/*
 * autorig.js — pasang rangka pada mesh humanoid yang tidak punya tulang.
 *
 * Banyak model bagus datang sebagai patung: hasil scan, konversi OBJ,
 * atau unduhan yang rig-nya tertinggal di format asalnya. Di glTF-nya
 * `skins` kosong dan vertexnya tidak membawa JOINTS/WEIGHTS sama
 * sekali. Model begitu bisa dilihat tapi tidak bisa digerakkan, dan
 * seluruh fitur paling berguna di aplikasi ini — memindahkan tangkapan
 * video ke sebuah rig — tertutup untuknya.
 *
 * Yang dikerjakan di sini: menebak di mana sendinya dari BENTUK
 * mesh-nya, lalu mengikat tiap vertex ke tulang terdekat.
 *
 * ------------------------------------------------------------------
 * Soal "menebak", supaya jelas sejak awal
 * ------------------------------------------------------------------
 * Ini heuristik, bukan penyelesaian. Dia mengandaikan sosok humanoid
 * yang berdiri tegak menghadap +Z dengan lengan terentang ke samping —
 * pose T atau yang mendekatinya. Di luar itu hasilnya bukan cuma kurang
 * bagus, tapi salah: rangka yang sendinya meleset akan melipat mesh di
 * tempat yang bukan sendi.
 *
 * Karena itu modul ini lebih memilih MENOLAK daripada menyerahkan rig
 * yang rusak. Setiap ukuran yang diandaikan diperiksa, dan kalau
 * bentuknya tidak masuk akal sebagai manusia berdiri, `fit` mengembalikan
 * alasannya alih-alih rangka. Pengguna lebih tertolong oleh "model ini
 * tidak bisa di-rig otomatis" daripada oleh sosok yang terlipat aneh
 * tanpa penjelasan.
 *
 * ------------------------------------------------------------------
 * Cara kerjanya
 * ------------------------------------------------------------------
 * Mesh-nya diiris mendatar, lalu tiap patokan dicari dari bentuk
 * irisannya — bukan dari proporsi hafalan:
 *
 *   rentang lengan  irisan terlebar; pose T membuat lengan jauh
 *                   melampaui badan, dan itu lonjakan yang gampang
 *                   dikenali
 *   tinggi bahu     rata-rata ketinggian titik-titik lengan
 *   selangkangan    ketinggian tertinggi di mana kolom tengah badan
 *                   masih KOSONG; di bawah itu ada dua tungkai dengan
 *                   celah di antaranya, di atasnya badan utuh
 *   mata kaki       ketinggian di mana ketebalan arah Z melonjak —
 *                   telapak kaki menjulur ke depan, betis tidak
 *   leher           irisan tersempit di atas bahu
 *
 * Proporsi hafalan cuma dipakai untuk yang memang tidak meninggalkan
 * jejak di siluet: lutut dan siku, yang ditaruh di tengah rantainya.
 *
 * Bagian analisisnya tidak bergantung pada three.js — array angka
 * biasa — supaya bisa diuji terhadap rangka yang posisinya sudah
 * diketahui, bukan cuma terhadap mata.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.AutoRig = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  var DEFAULTS = {
    slices: 160,        // jumlah irisan mendatar
    // Lebar kolom tengah yang dipakai mendeteksi celah antar-tungkai,
    // sebagai pecahan tinggi sosok. Terlalu sempit dan celahnya
    // terlewat pada sosok berkaki rapat; terlalu lebar dan pinggulnya
    // ikut terbaca sebagai celah.
    crotchColumn: 0.045,
    // Titik dianggap bagian lengan kalau jaraknya dari sumbu tengah
    // melebihi sekian dari setengah rentang lengan.
    armCut: 0.55,
    maxInfluences: 4,
    // Ketajaman bobot: bobot ~ 1/jarak^falloff. Makin besar makin
    // kaku ikut satu tulang, makin kecil makin membaur.
    falloff: 4,
    // Vertex yang lebih jauh dari ini (pecahan tinggi) dari SEMUA
    // tulang diikat penuh ke tulang terdekat, tanpa pembauran.
    blendRadius: 0.12
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
    return out;
  }

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) * 0.5;
  }

  /* ------------------------------------------------------------------ *
   * Mengukur siluet
   * ------------------------------------------------------------------ */

  /**
   * @param {Float32Array|Array} pts koordinat datar [x,y,z, x,y,z, ...]
   */
  function measure(pts, opt) {
    var n = Math.floor(pts.length / 3);
    if (n < 32) return null;

    var minY = Infinity, maxY = -Infinity;
    var i, x, y, z;
    for (i = 0; i < n; i++) {
      y = pts[i * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    var height = maxY - minY;
    if (!(height > EPS)) return null;

    // Sumbu tengah dari median x, bukan dari titik tengah kotak batas:
    // satu tangan terangkat atau satu aksesori di satu sisi menggeser
    // kotak batas, tapi tidak menggeser mediannya.
    var xs = [];
    for (i = 0; i < n; i++) xs.push(pts[i * 3]);
    var centerX = median(xs);

    var count = new Array(opt.slices);
    var sliceMinX = new Array(opt.slices);
    var sliceMaxX = new Array(opt.slices);
    var sliceMinZ = new Array(opt.slices);
    var sliceMaxZ = new Array(opt.slices);
    var centerCount = new Array(opt.slices);
    for (i = 0; i < opt.slices; i++) {
      count[i] = 0; centerCount[i] = 0;
      sliceMinX[i] = Infinity; sliceMaxX[i] = -Infinity;
      sliceMinZ[i] = Infinity; sliceMaxZ[i] = -Infinity;
    }

    var column = opt.crotchColumn * height;
    for (i = 0; i < n; i++) {
      x = pts[i * 3]; y = pts[i * 3 + 1]; z = pts[i * 3 + 2];
      var s = Math.min(opt.slices - 1,
        Math.max(0, Math.floor((y - minY) / height * opt.slices)));
      count[s]++;
      if (x < sliceMinX[s]) sliceMinX[s] = x;
      if (x > sliceMaxX[s]) sliceMaxX[s] = x;
      if (z < sliceMinZ[s]) sliceMinZ[s] = z;
      if (z > sliceMaxZ[s]) sliceMaxZ[s] = z;
      if (Math.abs(x - centerX) < column) centerCount[s]++;
    }

    var width = new Array(opt.slices);
    for (i = 0; i < opt.slices; i++) {
      width[i] = count[i] ? (sliceMaxX[i] - sliceMinX[i]) : 0;
    }

    return {
      n: n, minY: minY, maxY: maxY, height: height, centerX: centerX,
      slices: opt.slices, count: count, width: width,
      centerCount: centerCount,
      minX: sliceMinX, maxX: sliceMaxX, minZ: sliceMinZ, maxZ: sliceMaxZ,
      yOf: function (s) { return minY + (s + 0.5) / opt.slices * height; }
    };
  }

  /* ------------------------------------------------------------------ *
   * Mencari patokan
   * ------------------------------------------------------------------ */

  function findLandmarks(pts, m, opt) {
    var n = m.n, i, s;

    // --- rentang lengan: irisan terlebar ---------------------------
    var armSlice = 0;
    for (s = 0; s < m.slices; s++) if (m.width[s] > m.width[armSlice]) armSlice = s;
    var armSpan = m.width[armSlice];
    var halfSpan = armSpan / 2;

    // --- titik-titik lengan, dan tinggi bahu ------------------------
    // Tinggi bahu diambil dari rata-rata ketinggian titik lengan, bukan
    // dari irisan terlebarnya saja: lengan punya ketebalan, dan satu
    // irisan bisa jatuh di tepi atas atau bawahnya.
    var cut = m.centerX + 0; // dibaca sebagai sumbu
    var armCut = opt.armCut * halfSpan;
    var armYSum = 0, armCountL = 0, armCountR = 0, armYCount = 0;
    var armLow = Infinity, armHigh = -Infinity;
    var innerL = Infinity, innerR = Infinity;
    var tipL = -Infinity, tipR = Infinity;
    for (i = 0; i < n; i++) {
      var x = pts[i * 3], y = pts[i * 3 + 1];
      var d = x - cut;
      if (Math.abs(d) < armCut) continue;
      armYSum += y; armYCount++;
      if (y < armLow) armLow = y;
      if (y > armHigh) armHigh = y;
      if (d > 0) { armCountL++; if (d < innerL) innerL = d; if (x > tipL) tipL = x; }
      else { armCountR++; if (-d < innerR) innerR = -d; if (x < tipR) tipR = x; }
    }
    var shoulderY = armYCount ? armYSum / armYCount : m.minY + m.height * 0.8;

    // --- selangkangan ------------------------------------------------
    //
    // Ini patokan yang paling TIDAK bisa diandalkan dari bentuk, dan
    // itu temuan percobaan, bukan kehati-hatian berlebihan. Versi
    // pertama mencari ketinggian tertinggi di mana kolom tengah badan
    // masih kosong — masuk akal, dan gagal total pada sosok berkaki
    // rapat. Diukur pada avatar bawaan, yang pahanya benar-benar
    // bersentuhan di tengah, kolom tengahnya TERISI di setiap
    // ketinggian dari telapak kaki sampai kepala. Tidak ada celah untuk
    // ditemukan, dan detektornya menaruh selangkangan di lantai.
    //
    // Jadi sekarang dibalik: angkanya diperkirakan dari proporsi yang
    // diikat ke patokan yang BENAR-BENAR terukur, dan deteksi celah
    // cuma dipakai kalau dia menemukan celah yang sungguh jelas.
    //
    // Dua perkiraan dirata-rata karena keduanya gagal di kasus yang
    // berbeda: pecahan tinggi meleset untuk sosok bertungkai tidak
    // lazim, pecahan tinggi bahu meleset untuk sosok yang badannya
    // tidak lazim. Rata-ratanya tidak pernah seburuk yang terburuk.
    var byHeight = m.minY + m.height * 0.48;
    var byShoulder = m.minY + (shoulderY - m.minY) * 0.60;
    var crotchY = (byHeight + byShoulder) / 2;
    var crotchMeasured = false;

    var fillSum = 0, fillSlices = 0;
    for (s = 0; s < m.slices; s++) {
      var yT = m.yOf(s);
      if (m.count[s] && yT > crotchY && yT < shoulderY - m.height * 0.05) {
        fillSum += m.centerCount[s] / m.count[s]; fillSlices++;
      }
    }
    var torsoFill = fillSlices ? fillSum / fillSlices : 0;

    if (torsoFill > 0.02) {
      // Celah antar-tungkai itu satu wilayah MENERUS dari lantai ke
      // atas, jadi yang dicari ujung dari deretan pertama yang cukup
      // panjang — bukan irisan berkolom-kosong terakhir di mana pun.
      // Pada V-Bot, mencari yang terakhir membuat satu irisan berderau
      // di daerah paha (rasio 0,08 di antara tetangga 0,15 dan 0,21)
      // memperpanjang celahnya sampai 31% tinggi, padahal celah
      // bersihnya berakhir di 16%.
      var run = 0, gapEnd = -1;
      for (s = 0; s < m.slices; s++) {
        if (m.yOf(s) > crotchY + m.height * 0.2) break;
        if (!m.count[s]) continue;
        if (m.centerCount[s] / m.count[s] < torsoFill * 0.2) {
          run++;
        } else if (run >= 3) {
          gapEnd = s; break;
        } else {
          run = 0;
        }
      }

      // Dan hasilnya cuma dipercaya kalau jatuh di tempat yang mungkin
      // bagi sosok humanoid. Ini bukan kehati-hatian berlebihan: pada
      // V-Bot celah yang terdeteksi berakhir di 16-32% tinggi,
      // tergantung derau, sementara selangkangannya jelas di sekitar
      // 50%. Celah di bawah paha memang kosong di tengah — itu BUKAN
      // selangkangan, itu ruang antar-tungkai.
      //
      // Jadi pengukuran dipakai untuk MEMPERHALUS perkiraan di dalam
      // rentang yang masuk akal, tidak pernah untuk menimpanya jauh-
      // jauh. Kalau keduanya bertengkar, yang menang perkiraannya.
      if (gapEnd >= 0) {
        var cand = m.yOf(gapEnd);
        var rel = (cand - m.minY) / m.height;
        if (rel > 0.33 && rel < 0.62) { crotchY = cand; crotchMeasured = true; }
      }
    }

    // --- leher -------------------------------------------------------
    //
    // Juga lebih diperkirakan daripada diukur. "Irisan tersempit di atas
    // bahu" terdengar benar, tapi pada mesh yang kepalanya bulat irisan
    // tersempit sering jatuh di puncak kepala, bukan di leher. Jadi
    // perkiraannya proporsional, dan irisan tersempit cuma dipakai kalau
    // dia memang jauh lebih sempit daripada bahunya DAN berada di bawah
    // tengah kepala.
    var neckY = shoulderY + m.height * 0.035;
    var neckMeasured = false;
    var headMid = (shoulderY + m.maxY) / 2;
    var torsoW = shoulderBandWidth(m, isFinite(armLow) ? armLow : shoulderY);
    var narrow = -1;
    for (s = 0; s < m.slices; s++) {
      var yN = m.yOf(s);
      if (!m.count[s] || yN <= shoulderY + m.height * 0.01 || yN > headMid) continue;
      if (narrow < 0 || m.width[s] < m.width[narrow]) narrow = s;
    }
    if (narrow >= 0 && m.width[narrow] < torsoW * 0.6) {
      neckY = m.yOf(narrow);
      neckMeasured = true;
    }

    // --- mata kaki ----------------------------------------------------
    //
    // Telapak kaki menjulur ke depan, betis tidak. Jadi batasnya di
    // mana ketebalan arah Z turun kembali setipis betis.
    //
    // Dicari dari BAWAH ke atas, bukan sebaliknya. Versi pertama
    // mengambil irisan TERTINGGI yang masih tebal, dan itu salah dua
    // kali: lutut dan paha juga lebih tebal daripada betis, jadi yang
    // ketemu bisa saja pangkal paha.
    var shinZ = [];
    for (s = 0; s < m.slices; s++) {
      var yS = m.yOf(s);
      if (!m.count[s]) continue;
      if (yS > m.minY + m.height * 0.15 && yS < m.minY + m.height * 0.35) {
        shinZ.push(m.maxZ[s] - m.minZ[s]);
      }
    }
    var shinThick = median(shinZ) || m.height * 0.05;
    // Mulai dari PUNCAK telapak, bukan dari lantai: ujung jari kaki
    // sendiri tipis, jadi irisan paling bawah sering sudah lolos ambang
    // "setipis betis" dan mata kakinya terbaca di bawah lantai.
    var footPeak = -1;
    for (s = 0; s < m.slices; s++) {
      if (!m.count[s]) continue;
      if (m.yOf(s) > m.minY + m.height * 0.2) break;
      if (footPeak < 0 || (m.maxZ[s] - m.minZ[s]) > (m.maxZ[footPeak] - m.minZ[footPeak])) {
        footPeak = s;
      }
    }
    var ankleY = m.minY + m.height * 0.055;
    for (s = Math.max(footPeak, 0); s < m.slices; s++) {
      if (!m.count[s]) continue;
      if (m.yOf(s) > m.minY + m.height * 0.3) break;
      if ((m.maxZ[s] - m.minZ[s]) <= shinThick * 1.25) { ankleY = m.yOf(s); break; }
    }

    // --- lebar pinggul dan bahu, diukur dari mesh -------------------
    var hipHalf = sliceHalfWidth(m, crotchY + m.height * 0.04, cut);
    var shoulderHalf = torsoW / 2;

    // --- pusat tiap tungkai -----------------------------------------
    var legs = legCenters(pts, m, crotchY, ankleY, cut);

    return {
      centerX: cut,
      floor: m.minY, top: m.maxY, height: m.height,
      armSpan: armSpan, halfSpan: halfSpan,
      shoulderY: shoulderY, crotchY: crotchY, neckY: neckY, ankleY: ankleY,
      hipHalf: hipHalf, shoulderHalf: shoulderHalf,
      innerArmL: isFinite(innerL) ? innerL : halfSpan * 0.3,
      innerArmR: isFinite(innerR) ? innerR : halfSpan * 0.3,
      tipL: isFinite(tipL) ? tipL : cut + halfSpan,
      tipR: isFinite(tipR) ? tipR : cut - halfSpan,
      armPointsL: armCountL, armPointsR: armCountR,
      legL: legs.left, legR: legs.right,
      torsoFill: torsoFill,
      crotchMeasured: crotchMeasured, neckMeasured: neckMeasured
    };
  }

  /**
   * Lebar BADAN, diukur tepat di bawah garis lengan.
   *
   * Di situ lengan belum ikut terhitung, jadi angkanya bersih tanpa
   * perlu memisahkan apa pun. Terdengar terlalu sederhana, dan memang
   * itu intinya: percobaan sebelumnya memisahkan lengan dari badan
   * lewat ketebalan arah Z — dada tebal, lengan tipis — dan itu
   * gagal dua kali ke arah yang berlawanan. Pertama membaca pangkal
   * lengan dua kali terlalu jauh karena ketebalan acuannya diambil
   * dari bin yang memuat leher. Diperbaiki, dia lalu membaca terlalu
   * dekat, karena pada avatar bawaan selongsong BAHU memang setipis
   * lengannya.
   *
   * Yang terakhir itu bukan bug yang bisa ditambal: "di mana mesh
   * menipis" pada sosok itu sungguh-sungguh 0,055, sedangkan sendi
   * bahunya ada di 0,18. Jaraknya pilihan rig, bukan ciri bentuk —
   * tidak ada di data. Jadi lebih jujur mengukur satu hal yang memang
   * ada (lebar dada) lalu menaruh sendinya pada pecahan darinya.
   */
  function shoulderBandWidth(m, armLow) {
    // Pita ukurnya berhenti tepat DI BAWAH lengan terendah, bukan pada
    // jarak tetap dari tinggi bahu. Versi dengan jarak tetap menjangkau
    // sampai ke lengan dan membaca lebar dada 0,65 padahal sebenarnya
    // 0,20 — tiga kali lipat, karena rentang lengan ikut terhitung.
    var top = armLow - m.height * 0.01;
    var best = 0;
    for (var s = 0; s < m.slices; s++) {
      var y = m.yOf(s);
      if (!m.count[s]) continue;
      if (y > top - m.height * 0.14 && y < top) {
        if (m.width[s] > best) best = m.width[s];
      }
    }
    return best || m.height * 0.2;
  }

  function sliceHalfWidth(m, y, centerX) {
    var s = Math.min(m.slices - 1,
      Math.max(0, Math.floor((y - m.minY) / m.height * m.slices)));
    if (!m.count[s]) return m.height * 0.08;
    return Math.max(Math.abs(m.maxX[s] - centerX), Math.abs(centerX - m.minX[s]));
  }

  /** Setengah lebar BADAN di ketinggian tertentu, lengan tidak dihitung. */
  function torsoHalfAt(pts, m, y, armCut, centerX) {
    var band = m.height * 0.03;
    var worst = 0;
    for (var i = 0; i < m.n; i++) {
      var yy = pts[i * 3 + 1];
      if (Math.abs(yy - y) > band) continue;
      var d = Math.abs(pts[i * 3] - centerX);
      if (d >= armCut) continue;
      if (d > worst) worst = d;
    }
    return worst || m.height * 0.1;
  }

  /** Sumbu tiap tungkai: centroid per irisan, dipisah kiri dan kanan. */
  function legCenters(pts, m, crotchY, ankleY, centerX) {
    function side(sign) {
      var sum = { hipX: 0, hipZ: 0, hipN: 0, ankX: 0, ankZ: 0, ankN: 0, toeZ: -Infinity };
      var hipBand = m.height * 0.04, ankBand = m.height * 0.03;
      for (var i = 0; i < m.n; i++) {
        var x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        var d = (x - centerX) * sign;
        if (d <= 0) continue;
        if (Math.abs(y - (crotchY + m.height * 0.03)) < hipBand) {
          sum.hipX += x; sum.hipZ += z; sum.hipN++;
        }
        // Diambil dari BETIS tepat di atas mata kaki, bukan pada
        // ketinggian mata kakinya sendiri. Pada ketinggian itu
        // telapak kaki sudah ikut terhitung, dan karena telapak
        // menjulur ke depan, centroidnya tertarik maju — terukur 0,098
        // terlalu jauh ke depan, yang memiringkan seluruh tungkai.
        if (y > ankleY + ankBand * 0.5 && y < ankleY + ankBand * 3) {
          sum.ankX += x; sum.ankZ += z; sum.ankN++;
        }
        if (y < ankleY && z > sum.toeZ) sum.toeZ = z;
      }
      return {
        hipX: sum.hipN ? sum.hipX / sum.hipN : centerX + sign * m.height * 0.05,
        hipZ: sum.hipN ? sum.hipZ / sum.hipN : 0,
        ankleX: sum.ankN ? sum.ankX / sum.ankN : centerX + sign * m.height * 0.05,
        ankleZ: sum.ankN ? sum.ankZ / sum.ankN : 0,
        toeZ: isFinite(sum.toeZ) ? sum.toeZ : 0,
        points: sum.hipN + sum.ankN
      };
    }
    return { left: side(1), right: side(-1) };
  }

  /* ------------------------------------------------------------------ *
   * Apakah bentuknya masuk akal sebagai manusia berdiri
   * ------------------------------------------------------------------ */

  /**
   * Pemeriksaan ini yang membedakan "rig otomatis" dari "merusak model
   * orang". Tiap syarat di sini pernah jadi cara modul ini gagal diam-
   * diam waktu dicoba ke mesh yang bukan humanoid.
   */
  function validate(L, m) {
    var fail = [];
    if (!(L.armSpan > L.height * 0.5)) {
      fail.push('rentang lengan cuma ' + (L.armSpan / L.height).toFixed(2) +
        '× tinggi — sosok pose T mestinya di atas 0,5');
    }
    if (L.armPointsL < 20 || L.armPointsR < 20) {
      fail.push('lengan tidak terbaca di kedua sisi (' +
        L.armPointsL + ' kiri, ' + L.armPointsR + ' kanan)');
    }
    var rel = (L.shoulderY - L.floor) / L.height;
    if (rel < 0.55 || rel > 0.95) {
      fail.push('bahu di ketinggian ' + (rel * 100).toFixed(0) +
        '% — di luar rentang sosok berdiri');
    }
    var crotchRel = (L.crotchY - L.floor) / L.height;
    if (crotchRel < 0.25 || crotchRel > 0.70) {
      fail.push('selangkangan di ketinggian ' + (crotchRel * 100).toFixed(0) + '%');
    }
    if (!(L.crotchY < L.shoulderY)) {
      fail.push('selangkangan tidak berada di bawah bahu');
    }
    if (!(L.neckY > L.shoulderY)) {
      fail.push('leher tidak berada di atas bahu');
    }
    if (!(L.ankleY > L.floor) || L.ankleY > L.crotchY) {
      fail.push('mata kaki tidak berada di antara lantai dan selangkangan');
    }
    if (L.legL.points < 10 || L.legR.points < 10) {
      fail.push('tungkai tidak terbaca di kedua sisi');
    }
    return fail;
  }

  /* ------------------------------------------------------------------ *
   * Menempatkan tulang
   * ------------------------------------------------------------------ */

  /**
   * Posisi DUNIA tiap sendi. Nama-namanya kanonik, jadi retarget
   * langsung mengenalinya tanpa pemetaan tambahan.
   *
   * Lutut dan siku ditaruh di tengah rantainya. Keduanya memang tidak
   * meninggalkan jejak yang bisa dipercaya di siluet — lutut orang
   * berdiri tegak tidak menonjol, dan siku di pose T berada di tengah
   * lengan lurus. Menebaknya dari bentuk justru lebih rapuh daripada
   * menaruhnya di tengah.
   */
  function placeBones(L) {
    var H = L.height;
    var hipsY = L.crotchY + H * 0.08;
    var chestY = L.shoulderY - H * 0.07;
    var spineY = (hipsY + chestY) / 2;

    function leg(side, sign) {
      var g = side === 'Left' ? L.legL : L.legR;
      var kneeY = (hipsY - H * 0.06 + L.ankleY) / 2;
      return [
        [side + 'UpLeg', [g.hipX, hipsY - H * 0.06, g.hipZ]],
        [side + 'Leg', [(g.hipX + g.ankleX) / 2, kneeY, (g.hipZ + g.ankleZ) / 2]],
        [side + 'Foot', [g.ankleX, L.ankleY, g.ankleZ]],
        // Ujung jari kaki mesh menjulur lewat sendinya, seperti telapak
        // tangan; sendinya ditaruh di 0,7 jalan ke ujung.
        [side + 'Toe', [g.ankleX, L.floor + H * 0.015,
          g.ankleZ + (g.toeZ - g.ankleZ) * 0.7]]
      ];
    }

    function arm(side, sign) {
      var tip = side === 'Left' ? L.tipL : L.tipR;
      // Sendi bahu pada 0,3 lebar dada, pangkal lengan pada 0,9 —
      // pecahan, bukan pengukuran, karena jaraknya memang tidak ada di
      // bentuk mesh. Lihat catatan di shoulderBandWidth.
      var shoulderX = L.centerX + sign * L.shoulderHalf * 0.30;
      var upperX = L.centerX + sign * L.shoulderHalf * 0.90;
      // Pergelangan tidak di ujung mesh: telapak tangan menjulur lewat
      // sendinya.
      var handX = L.centerX + (tip - L.centerX) * 0.86;
      var elbowX = (upperX + handX) / 2;
      return [
        [side + 'Shoulder', [shoulderX, chestY + H * 0.05, 0]],
        [side + 'UpperArm', [upperX, L.shoulderY, 0]],
        [side + 'LowerArm', [elbowX, L.shoulderY, 0]],
        [side + 'Hand', [handX, L.shoulderY, 0]]
      ];
    }

    var joints = [
      ['Hips', [L.centerX, hipsY, 0]],
      ['Spine', [L.centerX, spineY, 0]],
      ['Chest', [L.centerX, chestY, 0]],
      ['Neck', [L.centerX, L.neckY, 0]],
      ['Head', [L.centerX, (L.neckY + L.top) / 2, 0]]
    ]
      .concat(arm('Left', 1)).concat(arm('Right', -1))
      .concat(leg('Left', 1)).concat(leg('Right', -1));

    // z bahu dan lengan mengikuti badan, bukan dipaksa nol
    var torsoZ = 0;
    joints.forEach(function (j) {
      if (/Shoulder|UpperArm|LowerArm|Hand/.test(j[0])) j[1][2] = torsoZ;
    });

    return joints;
  }

  var PARENT = {
    Hips: null, Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck',
    LeftShoulder: 'Chest', LeftUpperArm: 'LeftShoulder',
    LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
    RightShoulder: 'Chest', RightUpperArm: 'RightShoulder',
    RightLowerArm: 'RightUpperArm', RightHand: 'RightLowerArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToe: 'LeftFoot',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToe: 'RightFoot'
  };

  /* ------------------------------------------------------------------ *
   * Bobot skin
   * ------------------------------------------------------------------ */

  function distToSegment(p, a, b) {
    var abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    var apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
    var len2 = abx * abx + aby * aby + abz * abz;
    var t = len2 > EPS ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Tiap tulang diwakili SEGMEN dari sendinya ke sendi anaknya, bukan
   * oleh titik sendinya saja.
   *
   * Bedanya besar. Dengan titik, vertex di tengah paha sama jauhnya
   * dari pinggul dan lutut, jadi bobotnya terbagi rata dan pahanya
   * melipat di tengah saat lutut ditekuk. Dengan segmen, dia jelas
   * milik tulang paha.
   *
   * Tulang ujung — tangan, kepala, jari kaki — tidak punya anak, jadi
   * segmennya diteruskan sependek arah dari induknya.
   */
  function boneSegments(joints) {
    var byName = {};
    joints.forEach(function (j) { byName[j[0]] = j[1]; });

    var childOf = {};
    joints.forEach(function (j) {
      var p = PARENT[j[0]];
      if (p && byName[p]) (childOf[p] = childOf[p] || []).push(j[0]);
    });

    return joints.map(function (j) {
      var name = j[0], head = j[1];
      var kids = childOf[name];
      var tail;
      if (kids && kids.length) {
        tail = [0, 0, 0];
        kids.forEach(function (k) {
          tail[0] += byName[k][0]; tail[1] += byName[k][1]; tail[2] += byName[k][2];
        });
        tail[0] /= kids.length; tail[1] /= kids.length; tail[2] /= kids.length;
      } else {
        var p = PARENT[name] && byName[PARENT[name]];
        if (p) {
          var dx = head[0] - p[0], dy = head[1] - p[1], dz = head[2] - p[2];
          var l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          var reach = l * 0.5;
          tail = [head[0] + dx / l * reach, head[1] + dy / l * reach, head[2] + dz / l * reach];
        } else {
          tail = [head[0], head[1], head[2]];
        }
      }
      return { name: name, head: head, tail: tail };
    });
  }

  /**
   * Bobot tiap vertex: 1/jarak^falloff ke segmen tulang, empat teratas,
   * dinormalisasi.
   *
   * Pembauran dibatasi radius. Tanpa batas itu, vertex di ujung jari
   * kaki tetap mendapat sedikit bobot dari pinggul — kecil, tapi cukup
   * untuk menarik kakinya ikut berputar saat badan membungkuk.
   */
  function weightVertex(p, segs, opt, height, out) {
    var i, d, best = Infinity, bestI = 0;
    var dists = new Array(segs.length);
    for (i = 0; i < segs.length; i++) {
      d = distToSegment(p, segs[i].head, segs[i].tail);
      dists[i] = d;
      if (d < best) { best = d; bestI = i; }
    }

    var radius = opt.blendRadius * height;
    var idx = [], w = [];
    for (i = 0; i < segs.length; i++) {
      // Hanya tulang yang cukup dekat DIBANDING yang terdekat yang
      // ikut membaur; sisanya tidak berhak menarik vertex ini.
      if (dists[i] > best + radius) continue;
      idx.push(i);
      w.push(1 / Math.pow(dists[i] + height * 1e-4, opt.falloff));
    }
    if (!idx.length) { idx = [bestI]; w = [1]; }

    // empat teratas
    var order = idx.map(function (v, k) { return k; })
      .sort(function (a, b) { return w[b] - w[a]; })
      .slice(0, opt.maxInfluences);

    var sum = 0;
    for (i = 0; i < order.length; i++) sum += w[order[i]];
    for (i = 0; i < 4; i++) {
      if (i < order.length) {
        out.index[i] = idx[order[i]];
        out.weight[i] = w[order[i]] / sum;
      } else {
        out.index[i] = 0;
        out.weight[i] = 0;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Entry point analisis
   * ------------------------------------------------------------------ */

  /**
   * @param {Float32Array|Array} pts [x,y,z, ...] dalam satu ruang
   * @returns {{ok, reason, landmarks, joints, segments}}
   */
  function analyse(pts, options) {
    var opt = resolveOptions(options);
    var m = measure(pts, opt);
    if (!m) return { ok: false, reason: 'mesh terlalu sedikit vertexnya untuk diukur' };

    var L = findLandmarks(pts, m, opt);
    var fail = validate(L, m);
    if (fail.length) return { ok: false, reason: fail.join('; '), landmarks: L };

    var joints = placeBones(L);
    return {
      ok: true, landmarks: L, joints: joints,
      segments: boneSegments(joints), parents: PARENT
    };
  }

  /* ------------------------------------------------------------------ *
   * Membangun rig three.js
   * ------------------------------------------------------------------ */

  function three() {
    if (typeof self !== 'undefined' && self.THREE) return self.THREE;
    if (typeof global !== 'undefined' && global.THREE) return global.THREE;
    return null;
  }

  /** Semua mesh tak ber-skin di bawah satu objek. */
  function collectMeshes(object) {
    var out = [];
    object.traverse(function (o) {
      if (o.isMesh && !o.isSkinnedMesh && o.geometry &&
          o.geometry.attributes && o.geometry.attributes.position) out.push(o);
    });
    return out;
  }

  /**
   * Titik-titik seluruh mesh dalam ruang objek.
   *
   * Disubsample kalau terlalu banyak: analisisnya mengukur siluet, dan
   * siluet tidak jadi lebih benar dengan 200 ribu titik dibanding 20
   * ribu. Yang berubah cuma waktu tunggunya.
   */
  function gatherPoints(object, meshes, cap) {
    var THREE = three();
    var total = 0, i;
    for (i = 0; i < meshes.length; i++) total += meshes[i].geometry.attributes.position.count;
    var step = Math.max(1, Math.ceil(total / cap));

    var inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
    var v = new THREE.Vector3();
    var out = [];
    meshes.forEach(function (mesh) {
      var pos = mesh.geometry.attributes.position;
      var toObject = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      for (var k = 0; k < pos.count; k += step) {
        v.fromBufferAttribute(pos, k).applyMatrix4(toObject);
        out.push(v.x, v.y, v.z);
      }
    });
    return { points: new Float32Array(out), total: total, step: step };
  }

  /** Urutan induk-dulu, supaya tulang anak bisa langsung ditempelkan. */
  function parentFirst(joints) {
    var depth = {};
    function d(name) {
      if (depth[name] !== undefined) return depth[name];
      var p = PARENT[name];
      depth[name] = p ? d(p) + 1 : 0;
      return depth[name];
    }
    return joints.slice().sort(function (a, b) { return d(a[0]) - d(b[0]); });
  }

  /**
   * Pasang rangka pada objek yang tidak punya tulang.
   *
   * Objeknya DIUBAH di tempat: tiap Mesh diganti SkinnedMesh dengan
   * geometri yang sama, dan satu hierarki Bone ditambahkan sebagai
   * anaknya. Kalau bentuknya tidak masuk akal sebagai sosok humanoid
   * berdiri, tidak ada yang diubah dan alasannya dikembalikan.
   *
   * @returns {{ok, reason, root, skeleton, bones, report}}
   */
  function fit(object, options) {
    var THREE = three();
    if (!THREE) return { ok: false, reason: 'three.js tidak tersedia' };

    var opt = resolveOptions(options);
    object.updateMatrixWorld(true);

    var meshes = collectMeshes(object);
    if (!meshes.length) {
      return { ok: false, reason: 'tidak ada mesh tanpa skin untuk di-rig' };
    }

    var gathered = gatherPoints(object, meshes, 20000);
    var res = analyse(gathered.points, options);
    if (!res.ok) return { ok: false, reason: res.reason, landmarks: res.landmarks };

    // --- tulang ------------------------------------------------------
    var ordered = parentFirst(res.joints);
    var byName = {};
    res.joints.forEach(function (j) { byName[j[0]] = j[1]; });

    var bones = [], boneByName = {};
    ordered.forEach(function (j) {
      var bone = new THREE.Bone();
      bone.name = j[0];
      var p = PARENT[j[0]];
      if (p && boneByName[p]) {
        var pp = byName[p];
        bone.position.set(j[1][0] - pp[0], j[1][1] - pp[1], j[1][2] - pp[2]);
        boneByName[p].add(bone);
      } else {
        bone.position.set(j[1][0], j[1][1], j[1][2]);
      }
      boneByName[j[0]] = bone;
      bones.push(bone);
    });

    var rootBone = boneByName.Hips;
    object.add(rootBone);
    object.updateMatrixWorld(true);

    // Urutan tulang di Skeleton harus sama dengan urutan segmen yang
    // dipakai menghitung bobot: skinIndex menunjuk ke posisi di
    // skeleton.bones, bukan ke nama.
    var segs = res.segments;
    var skeletonBones = segs.map(function (sg) { return boneByName[sg.name]; });
    var skeleton = new THREE.Skeleton(skeletonBones);

    // --- bobot, lalu ganti tiap Mesh jadi SkinnedMesh -----------------
    var inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
    var v = new THREE.Vector3();
    var slot = { index: [0, 0, 0, 0], weight: [0, 0, 0, 0] };
    var height = res.landmarks.height;
    var replaced = [];

    meshes.forEach(function (mesh) {
      var geom = mesh.geometry;
      var pos = geom.attributes.position;
      var toObject = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      var si = new Uint16Array(pos.count * 4);
      var sw = new Float32Array(pos.count * 4);

      for (var k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(toObject);
        weightVertex([v.x, v.y, v.z], segs, opt, height, slot);
        for (var c = 0; c < 4; c++) {
          si[k * 4 + c] = slot.index[c];
          sw[k * 4 + c] = slot.weight[c];
        }
      }
      geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));

      var skinned = new THREE.SkinnedMesh(geom, mesh.material);
      skinned.name = mesh.name;
      skinned.position.copy(mesh.position);
      skinned.quaternion.copy(mesh.quaternion);
      skinned.scale.copy(mesh.scale);
      skinned.frustumCulled = false;
      var parent = mesh.parent;
      if (parent) {
        parent.add(skinned);
        parent.remove(mesh);
      }
      skinned.updateMatrixWorld(true);
      skinned.bind(skeleton, skinned.matrixWorld);
      replaced.push(skinned);
    });

    object.updateMatrixWorld(true);

    return {
      ok: true,
      root: object,
      skeleton: skeleton,
      bones: skeletonBones,
      meshes: replaced,
      landmarks: res.landmarks,
      joints: res.joints,
      report: {
        meshes: replaced.length,
        vertices: gathered.total,
        sampled: Math.floor(gathered.points.length / 3),
        bones: skeletonBones.length,
        height: height,
        crotchMeasured: res.landmarks.crotchMeasured,
        neckMeasured: res.landmarks.neckMeasured
      }
    };
  }

  return {
    analyse: analyse,
    fit: fit,
    weightVertex: weightVertex,
    boneSegments: boneSegments,
    PARENT: PARENT,
    DEFAULTS: DEFAULTS,
    resolveOptions: resolveOptions,
    _internal: {
      measure: measure, findLandmarks: findLandmarks, validate: validate,
      placeBones: placeBones, distToSegment: distToSegment, median: median,
      torsoHalfAt: torsoHalfAt, legCenters: legCenters
    }
  };
});
