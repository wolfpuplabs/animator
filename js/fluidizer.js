/*
 * fluidizer.js — MFS (Motion Fluidity Synthesis) core engine.
 *
 * Catatan jujur: ini BUKAN neural network. Ini pipeline signal-processing
 * deterministik untuk kurva animasi, dengan tahapan yang mirip semangat
 * upscaler frame modern: rekonstruksi sinyal -> filter sadar-gerak ->
 * sintesis detail sekunder -> kompresi output.
 *
 * Pipeline per kurva:
 *   1. Hemisphere alignment (quaternion)  — buang flip/pop rotasi.
 *   2. Reconstruct  — resample ke grid seragam dengan Hermite hold-aware
 *                     (posisi/skala) dan Squad (rotasi). C1-continuous.
 *   3. Denoise      — bilateral temporal filter: hilangkan jitter tanpa
 *                     melumerkan snap/pose kunci.
 *   4. Synthesize   — second-order dynamics: follow-through, cushion,
 *                     overshoot organik. Dimatikan di area kontak.
 *   5. Compact      — decimation keyframe dengan batas error, supaya
 *                     hasil 120fps tidak meledakkan ukuran file.
 *
 * Tidak bergantung pada three.js — murni array angka, bisa diuji di node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Fluidizer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;
  var MAX_SAMPLES = 24000; // pagar pengaman: clip panjang x fps tinggi

  /* ------------------------------------------------------------------ *
   * Util skalar
   * ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function smoothstep(e0, e1, x) {
    var d = e1 - e0;
    if (Math.abs(d) < EPS) return x < e0 ? 0 : 1;
    var t = clamp((x - e0) / d, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Median non-destruktif; dipakai untuk skala robust (tahan outlier). */
  function median(arr) {
    if (!arr.length) return 0;
    var copy = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    var mid = copy.length >> 1;
    return copy.length % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) * 0.5;
  }

  /* ------------------------------------------------------------------ *
   * Quaternion (layout xyzw, sama seperti three.js)
   * ------------------------------------------------------------------ */

  function qDot(a, ai, b, bi) {
    return a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3];
  }

  function qNormalize(q, o) {
    var l = Math.sqrt(q[o] * q[o] + q[o + 1] * q[o + 1] + q[o + 2] * q[o + 2] + q[o + 3] * q[o + 3]);
    if (l < EPS) { q[o] = 0; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 1; return; }
    var inv = 1 / l;
    q[o] *= inv; q[o + 1] *= inv; q[o + 2] *= inv; q[o + 3] *= inv;
  }

  function qCopy(src, si, dst, di) {
    dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
  }

  function qMul(a, ai, b, bi, out, oi) {
    var ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
    var bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
    out[oi]     = aw * bx + ax * bw + ay * bz - az * by;
    out[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
    out[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
    out[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
  }

  /** Invers quaternion unit = konjugat. */
  function qConj(a, ai, out, oi) {
    out[oi] = -a[ai]; out[oi + 1] = -a[ai + 1]; out[oi + 2] = -a[ai + 2]; out[oi + 3] = a[ai + 3];
  }

  /** log quaternion unit -> vektor half-angle (axis * theta/2). */
  function qLog(q, o, out) {
    var x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
    var s = Math.sqrt(x * x + y * y + z * z);
    if (s < 1e-8) { out[0] = x; out[1] = y; out[2] = z; return out; }
    var half = Math.atan2(s, w); // setengah sudut rotasi
    var k = half / s;
    out[0] = x * k; out[1] = y * k; out[2] = z * k;
    return out;
  }

  /** exp vektor half-angle -> quaternion unit. */
  function qExp(v, out, oi) {
    var a = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (a < 1e-8) {
      out[oi] = v[0]; out[oi + 1] = v[1]; out[oi + 2] = v[2]; out[oi + 3] = 1;
      qNormalize(out, oi);
      return;
    }
    var s = Math.sin(a) / a;
    out[oi] = v[0] * s; out[oi + 1] = v[1] * s; out[oi + 2] = v[2] * s; out[oi + 3] = Math.cos(a);
  }

  function qSlerp(a, ai, b, bi, t, out, oi) {
    var d = qDot(a, ai, b, bi);
    var bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (d > 0.9995) { // hampir sejajar -> lerp + normalize, hindari div-by-zero
      out[oi]     = lerp(a[ai], bx, t);
      out[oi + 1] = lerp(a[ai + 1], by, t);
      out[oi + 2] = lerp(a[ai + 2], bz, t);
      out[oi + 3] = lerp(a[ai + 3], bw, t);
      qNormalize(out, oi);
      return;
    }
    var theta = Math.acos(clamp(d, -1, 1));
    var sinTheta = Math.sin(theta);
    var wa = Math.sin((1 - t) * theta) / sinTheta;
    var wb = Math.sin(t * theta) / sinTheta;
    out[oi]     = a[ai] * wa + bx * wb;
    out[oi + 1] = a[ai + 1] * wa + by * wb;
    out[oi + 2] = a[ai + 2] * wa + bz * wb;
    out[oi + 3] = a[ai + 3] * wa + bw * wb;
  }

  /** Sudut rotasi (radian, 0..PI) antara dua quaternion. */
  function qAngle(a, ai, b, bi) {
    var d = Math.abs(clamp(qDot(a, ai, b, bi), -1, 1));
    return 2 * Math.acos(d);
  }

  /**
   * Samakan hemisphere semua key supaya interpolasi tidak "lewat jalan jauh".
   * Ini penyebab nomor satu rotasi yang tiba-tiba melintir 360 derajat.
   */
  function alignHemisphere(values, count) {
    var flips = 0;
    for (var i = 1; i < count; i++) {
      var o = i * 4, p = o - 4;
      if (qDot(values, p, values, o) < 0) {
        values[o] = -values[o]; values[o + 1] = -values[o + 1];
        values[o + 2] = -values[o + 2]; values[o + 3] = -values[o + 3];
        flips++;
      }
    }
    return flips;
  }

  /* ------------------------------------------------------------------ *
   * Tahap 2 — Reconstruct
   * ------------------------------------------------------------------ */

  /**
   * Tangen Catmull-Rom untuk sampling waktu non-uniform, dengan limiter
   * monotonik (Fritsch-Carlson). Limiter inilah yang bikin pose "hold"
   * tetap diam: kalau dua secant berlawanan arah atau salah satunya datar,
   * tangen dipaksa nol sehingga kurva tidak melengkung keluar.
   */
  function computeTangents(times, values, stride, n, holdAware) {
    var m = new Float64Array(n * stride);
    if (n < 2) return m;

    for (var j = 0; j < stride; j++) {
      for (var i = 0; i < n; i++) {
        var t;
        if (i === 0) {
          t = (values[stride + j] - values[j]) / Math.max(times[1] - times[0], EPS);
        } else if (i === n - 1) {
          t = (values[(n - 1) * stride + j] - values[(n - 2) * stride + j]) /
              Math.max(times[n - 1] - times[n - 2], EPS);
        } else {
          var dtPrev = Math.max(times[i] - times[i - 1], EPS);
          var dtNext = Math.max(times[i + 1] - times[i], EPS);
          var dPrev = (values[i * stride + j] - values[(i - 1) * stride + j]) / dtPrev;
          var dNext = (values[(i + 1) * stride + j] - values[i * stride + j]) / dtNext;
          // rata-rata berbobot waktu (Catmull-Rom non-uniform)
          t = (dPrev * dtNext + dNext * dtPrev) / (dtPrev + dtNext);

          if (holdAware) {
            if (dPrev * dNext <= 0) {
              t = 0; // ekstrem lokal atau hold -> jangan overshoot
            } else {
              var lim = 3 * Math.min(Math.abs(dPrev), Math.abs(dNext));
              if (Math.abs(t) > lim) t = Math.sign(t) * lim;
            }
          }
        }
        m[i * stride + j] = t;
      }
    }
    return m;
  }

  /** Cari indeks segmen [i, i+1] yang memuat t. */
  function findSegment(times, n, t, hint) {
    var i = clamp(hint | 0, 0, n - 2);
    while (i > 0 && t < times[i]) i--;
    while (i < n - 2 && t >= times[i + 1]) i++;
    return i;
  }

  function resampleNumeric(times, values, stride, n, outTimes, holdAware) {
    var out = new Float64Array(outTimes.length * stride);
    if (n === 0) return out;
    if (n === 1) {
      for (var a = 0; a < outTimes.length; a++) {
        for (var b = 0; b < stride; b++) out[a * stride + b] = values[b];
      }
      return out;
    }

    var m = computeTangents(times, values, stride, n, holdAware);
    var seg = 0;

    for (var k = 0; k < outTimes.length; k++) {
      var t = outTimes[k];
      if (t <= times[0]) {
        for (var c0 = 0; c0 < stride; c0++) out[k * stride + c0] = values[c0];
        continue;
      }
      if (t >= times[n - 1]) {
        for (var c1 = 0; c1 < stride; c1++) out[k * stride + c1] = values[(n - 1) * stride + c1];
        continue;
      }

      seg = findSegment(times, n, t, seg);
      var t0 = times[seg], t1 = times[seg + 1];
      var h = Math.max(t1 - t0, EPS);
      var s = (t - t0) / h;
      var s2 = s * s, s3 = s2 * s;
      var h00 = 2 * s3 - 3 * s2 + 1;
      var h10 = s3 - 2 * s2 + s;
      var h01 = -2 * s3 + 3 * s2;
      var h11 = s3 - s2;

      for (var j = 0; j < stride; j++) {
        var v0 = values[seg * stride + j];
        var v1 = values[(seg + 1) * stride + j];
        out[k * stride + j] = h00 * v0 + h10 * h * m[seg * stride + j] +
                              h01 * v1 + h11 * h * m[(seg + 1) * stride + j];
      }
    }
    return out;
  }

  /**
   * Squad (spherical cubic) untuk rotasi: C1-continuous, jadi tidak ada
   * "patah" kecepatan sudut tiap melewati keyframe seperti slerp berantai.
   */
  function computeSquadControls(values, n) {
    var s = new Float64Array(n * 4);
    var inv = [0, 0, 0, 0], tmp = [0, 0, 0, 0];
    var l0 = [0, 0, 0], l1 = [0, 0, 0], v = [0, 0, 0];

    for (var i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) { qCopy(values, i * 4, s, i * 4); continue; }
      qConj(values, i * 4, inv, 0);
      qMul(inv, 0, values, (i + 1) * 4, tmp, 0); qLog(tmp, 0, l0);
      qMul(inv, 0, values, (i - 1) * 4, tmp, 0); qLog(tmp, 0, l1);
      v[0] = -0.25 * (l0[0] + l1[0]);
      v[1] = -0.25 * (l0[1] + l1[1]);
      v[2] = -0.25 * (l0[2] + l1[2]);
      qExp(v, tmp, 0);
      qMul(values, i * 4, tmp, 0, s, i * 4);
      qNormalize(s, i * 4);
    }
    return s;
  }

  function resampleQuaternion(times, values, n, outTimes) {
    var out = new Float64Array(outTimes.length * 4);
    if (n === 0) return out;
    if (n === 1) {
      for (var a = 0; a < outTimes.length; a++) qCopy(values, 0, out, a * 4);
      return out;
    }

    var ctrl = computeSquadControls(values, n);
    var p = [0, 0, 0, 0], q = [0, 0, 0, 0];
    var seg = 0;

    for (var k = 0; k < outTimes.length; k++) {
      var t = outTimes[k];
      if (t <= times[0]) { qCopy(values, 0, out, k * 4); continue; }
      if (t >= times[n - 1]) { qCopy(values, (n - 1) * 4, out, k * 4); continue; }

      seg = findSegment(times, n, t, seg);
      var t0 = times[seg], t1 = times[seg + 1];
      var u = (t - t0) / Math.max(t1 - t0, EPS);

      // Segmen yang praktis tanpa rotasi: pakai slerp murni supaya
      // kontrol squad dari tetangga tidak menyuntik goyangan palsu.
      if (qAngle(values, seg * 4, values, (seg + 1) * 4) < 1e-4) {
        qSlerp(values, seg * 4, values, (seg + 1) * 4, u, out, k * 4);
        continue;
      }

      qSlerp(values, seg * 4, values, (seg + 1) * 4, u, p, 0);
      qSlerp(ctrl, seg * 4, ctrl, (seg + 1) * 4, u, q, 0);
      qSlerp(p, 0, q, 0, 2 * u * (1 - u), out, k * 4);
      qNormalize(out, k * 4);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Motion mask — analog "motion vector"
   * ------------------------------------------------------------------ *
   * Kita perlu tahu di mana kurva sedang bergerak dan di mana dia diam
   * (kontak kaki, pose hold). Area diam tidak boleh di-smooth atau
   * di-spring, kalau tidak kaki akan meluncur dan hold jadi melayang.
   */

  function buildMotionMask(times, values, stride, n, isQuat, outTimes, contactSensitivity) {
    var count = outTimes.length;
    var mask = new Float64Array(count);
    if (n < 2) return mask; // satu key = diam total -> mask 0

    // kecepatan per segmen sumber
    var speeds = new Float64Array(n - 1);
    for (var i = 0; i < n - 1; i++) {
      var dt = Math.max(times[i + 1] - times[i], EPS);
      var d;
      if (isQuat) {
        d = qAngle(values, i * 4, values, (i + 1) * 4);
      } else {
        var acc = 0;
        for (var j = 0; j < stride; j++) {
          var dv = values[(i + 1) * stride + j] - values[i * stride + j];
          acc += dv * dv;
        }
        d = Math.sqrt(acc);
      }
      speeds[i] = d / dt;
    }

    // skala referensi robust: median kecepatan yang bukan nol
    var nonZero = [];
    for (var s = 0; s < speeds.length; s++) if (speeds[s] > EPS) nonZero.push(speeds[s]);
    var ref = median(nonZero);
    if (ref < EPS) return mask;

    var lo = ref * 0.02 * (1 + contactSensitivity * 4);
    var hi = ref * 0.25 * (1 + contactSensitivity * 2);

    var seg = 0;
    for (var k = 0; k < count; k++) {
      var t = clamp(outTimes[k], times[0], times[n - 1]);
      seg = findSegment(times, n, t, seg);
      mask[k] = smoothstep(lo, hi, speeds[seg]);
    }

    // sebar sedikit ke tetangga supaya transisi hold->gerak tidak menggigit
    var blurred = new Float64Array(count);
    var r = 2;
    for (var a = 0; a < count; a++) {
      var sum = 0, wsum = 0;
      for (var o = -r; o <= r; o++) {
        var idx = clamp(a + o, 0, count - 1);
        var w = 1 / (1 + Math.abs(o));
        sum += mask[idx] * w; wsum += w;
      }
      blurred[a] = sum / wsum;
    }
    return blurred;
  }

  /* ------------------------------------------------------------------ *
   * Tahap 3 — Denoise (bilateral temporal filter)
   * ------------------------------------------------------------------ *
   * Gaussian biasa menghapus jitter tapi juga melumerkan snap/impact.
   * Bilateral memberi bobot ganda: jarak waktu DAN selisih nilai, jadi
   * lonjakan besar (impact, snap) dipertahankan sementara getaran kecil
   * di sekitarnya hilang.
   */

  /**
   * Indeks tetangga di dalam window filter.
   *
   * Menjepit indeks di tepi (cara naif) menarik frame-frame awal dan akhir
   * ke arah nilai ujungnya — pop yang kelihatan di frame 0 dan di titik
   * loop. Jadi: kurva menyambung di-wrap melewati batas, kurva biasa
   * memakai window yang menciut simetris sehingga tidak ada bias sama
   * sekali (di i=0 radiusnya 0, sample tidak disentuh).
   */
  function windowRadius(i, count, radius, wrap) {
    if (wrap) return radius;
    return Math.min(radius, i, count - 1 - i);
  }

  function windowIndex(i, o, count, wrap) {
    if (!wrap) return i + o;
    var idx = (i + o) % count;
    return idx < 0 ? idx + count : idx;
  }

  function bilateralNumeric(samples, count, stride, sigmaT, sigmaRange, mask, wrap) {
    if (count < 3 || sigmaT < 0.05) return samples;
    var out = new Float64Array(samples.length);
    var radius = Math.max(1, Math.min(32, Math.ceil(sigmaT * 2.5)));
    var invT2 = 1 / (2 * sigmaT * sigmaT);
    var useRange = sigmaRange > EPS;
    var invR2 = useRange ? 1 / (2 * sigmaRange * sigmaRange) : 0;

    for (var i = 0; i < count; i++) {
      var amount = mask ? mask[i] : 1;
      var r = windowRadius(i, count, radius, wrap);
      if (amount < 1e-3 || r === 0) {
        for (var c = 0; c < stride; c++) out[i * stride + c] = samples[i * stride + c];
        continue;
      }
      var acc = new Float64Array(stride);
      var wsum = 0;
      for (var o = -r; o <= r; o++) {
        var idx = windowIndex(i, o, count, wrap);
        var w = Math.exp(-(o * o) * invT2);
        if (useRange) {
          var dist2 = 0;
          for (var j = 0; j < stride; j++) {
            var d = samples[idx * stride + j] - samples[i * stride + j];
            dist2 += d * d;
          }
          w *= Math.exp(-dist2 * invR2);
        }
        for (var j2 = 0; j2 < stride; j2++) acc[j2] += samples[idx * stride + j2] * w;
        wsum += w;
      }
      for (var j3 = 0; j3 < stride; j3++) {
        var filtered = acc[j3] / wsum;
        var orig = samples[i * stride + j3];
        out[i * stride + j3] = lerp(orig, filtered, amount);
      }
    }
    return out;
  }

  function bilateralQuaternion(samples, count, sigmaT, sigmaRange, mask, wrap) {
    if (count < 3 || sigmaT < 0.05) return samples;
    var out = new Float64Array(samples.length);
    var radius = Math.max(1, Math.min(32, Math.ceil(sigmaT * 2.5)));
    var invT2 = 1 / (2 * sigmaT * sigmaT);
    var useRange = sigmaRange > EPS;
    var invR2 = useRange ? 1 / (2 * sigmaRange * sigmaRange) : 0;
    var avg = [0, 0, 0, 0];

    for (var i = 0; i < count; i++) {
      var amount = mask ? mask[i] : 1;
      var r = windowRadius(i, count, radius, wrap);
      if (amount < 1e-3 || r === 0) { qCopy(samples, i * 4, out, i * 4); continue; }

      avg[0] = 0; avg[1] = 0; avg[2] = 0; avg[3] = 0;
      var wsum = 0;
      for (var o = -r; o <= r; o++) {
        var idx = windowIndex(i, o, count, wrap);
        var w = Math.exp(-(o * o) * invT2);
        var ang = qAngle(samples, i * 4, samples, idx * 4);
        if (useRange) w *= Math.exp(-(ang * ang) * invR2);
        // selaraskan hemisphere terhadap sample pusat sebelum dirata-rata
        var sign = qDot(samples, i * 4, samples, idx * 4) < 0 ? -1 : 1;
        avg[0] += samples[idx * 4] * w * sign;
        avg[1] += samples[idx * 4 + 1] * w * sign;
        avg[2] += samples[idx * 4 + 2] * w * sign;
        avg[3] += samples[idx * 4 + 3] * w * sign;
        wsum += w;
      }
      avg[0] /= wsum; avg[1] /= wsum; avg[2] /= wsum; avg[3] /= wsum;
      qNormalize(avg, 0);
      qSlerp(samples, i * 4, avg, 0, amount, out, i * 4);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Tahap 4 — Synthesize (second-order dynamics)
   * ------------------------------------------------------------------ *
   * Sistem massa-pegas-peredam orde dua. Bukan sekadar "bouncing": ini
   * yang memberi follow-through dan cushion, dua prinsip animasi yang
   * bikin gerakan terbaca hidup. r > 0 memberi respons awal yang cepat
   * sehingga tidak terasa telat, z < 1 memberi overshoot di akhir gerak.
   */

  /**
   * Pre-roll pegas hanya sah kalau kurvanya memang menyambung dari ujung
   * ke pangkal. Kalau tidak (misal rotasi yang terus berputar satu arah),
   * pass kedua akan mulai dengan error raksasa dan pegasnya berosilasi
   * sepanjang klip. Jadi jangan percaya centang "looping" begitu saja —
   * periksa datanya.
   */
  function isCyclic(samples, count, stride, isQuat) {
    if (count < 3) return false;
    var last = count - 1;

    if (isQuat) {
      var gap = qAngle(samples, 0, samples, last * 4);
      var travel = 0;
      for (var i = 1; i < count; i++) travel += qAngle(samples, (i - 1) * 4, samples, i * 4);
      if (travel < EPS) return true; // diam total
      return gap <= Math.max(0.02 * travel, 1e-4);
    }

    var diff = 0, min = Infinity, max = -Infinity;
    for (var c = 0; c < stride; c++) {
      var d = samples[last * stride + c] - samples[c];
      diff += d * d;
    }
    diff = Math.sqrt(diff);
    for (var k = 0; k < count * stride; k++) {
      var v = samples[k];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var range = max - min;
    if (range < EPS) return true;
    return diff <= 0.02 * range;
  }

  function dynamicsCoefficients(f, z, r, dt) {
    var w = 2 * Math.PI * f;
    var k1 = z / (Math.PI * f);
    var k2 = 1 / (w * w);
    var k3 = r * z / w;
    // jaga stabilitas untuk dt besar tanpa harus sub-stepping
    var k2min = 1.1 * (dt * dt / 4 + dt * k1 / 2);
    if (k2 < k2min) k2 = k2min;
    return { k1: k1, k2: k2, k3: k3 };
  }

  function dynamicsNumeric(samples, count, stride, dt, f, z, r, amount, mask, loop) {
    if (amount < 1e-3 || count < 3) return samples;
    var co = dynamicsCoefficients(f, z, r, dt);
    var out = new Float64Array(samples.length);
    var y = new Float64Array(stride);
    var yd = new Float64Array(stride);
    var xPrev = new Float64Array(stride);

    for (var c = 0; c < stride; c++) {
      // Mulai dengan kecepatan input, bukan nol — kalau nol, frame-frame
      // pertama tertinggal di belakang dan terlihat seperti lag.
      yd[c] = (samples[stride + c] - samples[c]) / dt;
      // Posisi awal diundur satu frame: integrasi pertama di dalam loop
      // membawanya tepat ke samples[0], jadi hasilnya tidak maju sefreim.
      y[c] = samples[c] - dt * yd[c];
      // xPrev ikut diundur. Kalau diisi samples[0], kecepatan input di
      // iterasi pertama terbaca nol dan peredam langsung memangkas
      // kecepatan awal yang baru saja kita pasang.
      xPrev[c] = y[c];
    }

    // Pre-roll satu putaran supaya state pegas sudah mapan di frame 0.
    // Hanya untuk kurva yang benar-benar menyambung ujung-pangkal.
    var passes = (loop && isCyclic(samples, count, stride, false)) ? 2 : 1;
    for (var pass = 0; pass < passes; pass++) {
      for (var i = 0; i < count; i++) {
        var base = i * stride;
        for (var j = 0; j < stride; j++) {
          var x = samples[base + j];
          var xd = (x - xPrev[j]) / dt;
          xPrev[j] = x;
          y[j] += dt * yd[j];
          yd[j] += dt * (x + co.k3 * xd - y[j] - co.k1 * yd[j]) / co.k2;
          if (pass === passes - 1) {
            var a = amount * (mask ? mask[i] : 1);
            out[base + j] = lerp(x, y[j], a);
          }
        }
      }
    }
    return out;
  }

  function dynamicsQuaternion(samples, count, dt, f, z, r, amount, mask, loop) {
    if (amount < 1e-3 || count < 3) return samples;
    var co = dynamicsCoefficients(f, z, r, dt);
    var out = new Float64Array(samples.length);
    var y = [0, 0, 0, 0], w = [0, 0, 0], inv = [0, 0, 0, 0], tmp = [0, 0, 0, 0];
    var delta = [0, 0, 0], xd = [0, 0, 0], step = [0, 0, 0];
    var xPrev = [0, 0, 0, 0];

    // kecepatan sudut awal diambil dari dua sample pertama (lihat catatan
    // di dynamicsNumeric soal lag di frame awal)
    qConj(samples, 0, inv, 0);
    qMul(inv, 0, samples, 4, tmp, 0);
    qLog(tmp, 0, delta);
    w[0] = delta[0] * 2 / dt; w[1] = delta[1] * 2 / dt; w[2] = delta[2] * 2 / dt;

    // orientasi awal diundur satu frame, alasan sama seperti versi numerik
    step[0] = -0.5 * w[0] * dt; step[1] = -0.5 * w[1] * dt; step[2] = -0.5 * w[2] * dt;
    qExp(step, tmp, 0);
    qMul(samples, 0, tmp, 0, y, 0);
    qNormalize(y, 0);
    qCopy(y, 0, xPrev, 0);

    var passes = (loop && isCyclic(samples, count, 4, true)) ? 2 : 1;
    for (var pass = 0; pass < passes; pass++) {
      for (var i = 0; i < count; i++) {
        var o = i * 4;
        // kecepatan sudut input (rotation vector penuh / dt)
        qConj(xPrev, 0, inv, 0);
        qMul(inv, 0, samples, o, tmp, 0);
        qLog(tmp, 0, xd);
        xd[0] = xd[0] * 2 / dt; xd[1] = xd[1] * 2 / dt; xd[2] = xd[2] * 2 / dt;
        qCopy(samples, o, xPrev, 0);

        // integrasi orientasi dengan kecepatan sudut saat ini
        step[0] = 0.5 * w[0] * dt; step[1] = 0.5 * w[1] * dt; step[2] = 0.5 * w[2] * dt;
        qExp(step, tmp, 0);
        qMul(y, 0, tmp, 0, y, 0);
        qNormalize(y, 0);

        // error orientasi sebagai rotation vector
        qConj(y, 0, inv, 0);
        qMul(inv, 0, samples, o, tmp, 0);
        if (tmp[3] < 0) { tmp[0] = -tmp[0]; tmp[1] = -tmp[1]; tmp[2] = -tmp[2]; tmp[3] = -tmp[3]; }
        qLog(tmp, 0, delta);
        delta[0] *= 2; delta[1] *= 2; delta[2] *= 2;

        for (var c = 0; c < 3; c++) {
          w[c] += dt * (delta[c] + co.k3 * xd[c] - co.k1 * w[c]) / co.k2;
        }
        // pagar: cegah ledakan numerik pada kurva rotasi ekstrem
        var wl = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
        var wmax = 200;
        if (wl > wmax) { var kk = wmax / wl; w[0] *= kk; w[1] *= kk; w[2] *= kk; }

        if (pass === passes - 1) {
          var a = amount * (mask ? mask[i] : 1);
          qSlerp(samples, o, y, 0, a, out, o);
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Tahap 5 — Compact (decimation keyframe berbatas error)
   * ------------------------------------------------------------------ *
   * Hasil 120fps itu indah tapi boros. Kita buang key yang bisa
   * direkonstruksi ulang lewat interpolasi linear dalam batas error
   * tertentu, jadi file tetap ramping tanpa kehilangan bentuk kurva.
   */

  function decimate(times, values, stride, count, tolerance, isQuat) {
    if (count <= 2 || tolerance <= 0) {
      return { times: Array.prototype.slice.call(times), values: Array.prototype.slice.call(values) };
    }

    var keep = [0];
    var i = 0;
    var WINDOW = 512; // batas atas agar kompleksitas tidak meledak
    var a = [0, 0, 0, 0];

    while (i < count - 1) {
      var best = i + 1;
      var j = i + 2;
      var limit = Math.min(count - 1, i + WINDOW);

      while (j <= limit) {
        var ok = true;
        var t0 = times[i], t1 = times[j];
        var span = Math.max(t1 - t0, EPS);

        for (var k = i + 1; k < j; k++) {
          var u = (times[k] - t0) / span;
          var err = 0;
          if (isQuat) {
            qSlerp(values, i * 4, values, j * 4, u, a, 0);
            err = qAngle(a, 0, values, k * 4);
          } else {
            for (var c = 0; c < stride; c++) {
              var pred = lerp(values[i * stride + c], values[j * stride + c], u);
              var d = Math.abs(pred - values[k * stride + c]);
              if (d > err) err = d;
            }
          }
          if (err > tolerance) { ok = false; break; }
        }

        if (!ok) break;
        best = j;
        j++;
      }

      keep.push(best);
      i = best;
    }

    var outTimes = new Array(keep.length);
    var outValues = new Array(keep.length * stride);
    for (var n = 0; n < keep.length; n++) {
      outTimes[n] = times[keep[n]];
      for (var s = 0; s < stride; s++) outValues[n * stride + s] = values[keep[n] * stride + s];
    }
    return { times: outTimes, values: outValues };
  }

  /* ------------------------------------------------------------------ *
   * Metrik kualitas
   * ------------------------------------------------------------------ */

  /**
   * Skor kehalusan bebas-skala: RMS percepatan dibagi RMS kecepatan.
   *
   * L1 sengaja dihindari: kurva patah dan kurva mulus yang melewati titik
   * yang sama punya total variasi kecepatan yang mirip, jadi L1 hampir
   * tidak bisa membedakannya. RMS menghukum percepatan yang menumpuk di
   * satu titik (persis ciri interpolasi linear di setiap keyframe) dan
   * memaafkan percepatan yang tersebar halus. Makin kecil makin mulus.
   */
  function jerkMetric(samples, count, stride, isQuat) {
    if (count < 3) return 0;

    var data = samples, s = stride;
    if (isQuat) {
      // Samakan hemisphere dulu supaya selisih 4D mewakili jarak rotasi.
      data = new Float64Array(samples.length);
      for (var i0 = 0; i0 < samples.length; i0++) data[i0] = samples[i0];
      alignHemisphere(data, count);
      s = 4;
    }

    var velSq = 0, accSq = 0;
    for (var i = 1; i < count; i++) {
      var d = 0;
      for (var c = 0; c < s; c++) {
        var dv = data[i * s + c] - data[(i - 1) * s + c];
        d += dv * dv;
      }
      velSq += d;

      if (i < count - 1) {
        var a = 0;
        for (var c2 = 0; c2 < s; c2++) {
          var d2 = data[(i + 1) * s + c2] - 2 * data[i * s + c2] + data[(i - 1) * s + c2];
          a += d2 * d2;
        }
        accSq += a;
      }
    }

    var velRms = Math.sqrt(velSq / (count - 1));
    if (velRms < EPS) return 0;
    return Math.sqrt(accSq / (count - 2)) / velRms;
  }

  /** Resample linear — dipakai sebagai baseline "seperti apa aslinya diputar". */
  function resampleLinear(times, values, stride, n, outTimes, isQuat) {
    var out = new Float64Array(outTimes.length * stride);
    if (n === 0) return out;
    var seg = 0;
    for (var k = 0; k < outTimes.length; k++) {
      var t = outTimes[k];
      if (n === 1 || t <= times[0]) {
        for (var c = 0; c < stride; c++) out[k * stride + c] = values[c];
        continue;
      }
      if (t >= times[n - 1]) {
        for (var c2 = 0; c2 < stride; c2++) out[k * stride + c2] = values[(n - 1) * stride + c2];
        continue;
      }
      seg = findSegment(times, n, t, seg);
      var u = (t - times[seg]) / Math.max(times[seg + 1] - times[seg], EPS);
      if (isQuat) {
        qSlerp(values, seg * 4, values, (seg + 1) * 4, u, out, k * 4);
      } else {
        for (var j = 0; j < stride; j++) {
          out[k * stride + j] = lerp(values[seg * stride + j], values[(seg + 1) * stride + j], u);
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Preset kualitas
   * ------------------------------------------------------------------ */

  /*
   * Catatan kalibrasi: `reduction` adalah trade-off langsung terhadap
   * kehalusan — decimation merekonstruksi ulang dengan interpolasi linear,
   * jadi setiap key yang dibuang mengembalikan sedikit "sudut" ke kurva.
   * Pada klip uji, reduction 0.18 memangkas gain kehalusan dari 0.46 ke
   * 0.26. Karena tujuan alat ini kehalusan, preset sengaja dijaga rendah
   * dan hanya mode Performance yang menukarnya demi ukuran file.
   */
  var PRESETS = {
    performance: { fps: 30,  smoothing: 0.25, followThrough: 0.00, contactLock: 0.5, reduction: 0.30, label: 'Performance' },
    balanced:    { fps: 60,  smoothing: 0.45, followThrough: 0.20, contactLock: 0.5, reduction: 0.12, label: 'Balanced' },
    quality:     { fps: 90,  smoothing: 0.60, followThrough: 0.35, contactLock: 0.6, reduction: 0.05, label: 'Quality' },
    ultra:       { fps: 120, smoothing: 0.75, followThrough: 0.50, contactLock: 0.7, reduction: 0.00, label: 'Ultra Fluid' }
  };

  var DEFAULTS = {
    fps: 60,
    smoothing: 0.45,
    followThrough: 0.2,
    contactLock: 0.5,
    reduction: 0.12,
    holdAware: true,
    loop: true
  };

  function resolveOptions(options) {
    var base = {};
    var key;
    if (options && options.preset && PRESETS[options.preset]) {
      var p = PRESETS[options.preset];
      for (key in DEFAULTS) if (DEFAULTS.hasOwnProperty(key)) base[key] = DEFAULTS[key];
      for (key in p) if (p.hasOwnProperty(key) && key !== 'label') base[key] = p[key];
    } else {
      for (key in DEFAULTS) if (DEFAULTS.hasOwnProperty(key)) base[key] = DEFAULTS[key];
    }
    if (options) {
      for (key in options) {
        if (options.hasOwnProperty(key) && options[key] !== undefined && key !== 'preset') base[key] = options[key];
      }
    }
    base.fps = clamp(base.fps, 8, 240);
    base.smoothing = clamp(base.smoothing, 0, 1);
    base.followThrough = clamp(base.followThrough, 0, 1);
    base.contactLock = clamp(base.contactLock, 0, 1);
    base.reduction = clamp(base.reduction, 0, 1);
    return base;
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {{duration:number, tracks:Array, name?:string}} clip
   * @param {Object} options lihat DEFAULTS / PRESETS
   * @returns {{name:string, duration:number, tracks:Array, stats:Object}}
   */
  function enhance(clip, options) {
    var opt = resolveOptions(options);
    var tracks = clip.tracks || [];
    var duration = clip.duration;

    if (!(duration > 0)) {
      duration = 0;
      for (var d = 0; d < tracks.length; d++) {
        var tt = tracks[d].times;
        if (tt && tt.length) duration = Math.max(duration, tt[tt.length - 1]);
      }
    }

    var sampleCount = Math.max(2, Math.round(duration * opt.fps) + 1);
    var effectiveFps = opt.fps;
    if (sampleCount > MAX_SAMPLES) {
      sampleCount = MAX_SAMPLES;
      effectiveFps = (sampleCount - 1) / Math.max(duration, EPS);
    }
    var dt = duration / (sampleCount - 1);

    var grid = new Float64Array(sampleCount);
    for (var g = 0; g < sampleCount; g++) grid[g] = Math.min(g * dt, duration);

    var outTracks = [];
    var stats = {
      fps: effectiveFps,
      sampleCount: sampleCount,
      duration: duration,
      inputKeys: 0,
      outputKeys: 0,
      tracksProcessed: 0,
      tracksCopied: 0,
      quaternionFlipsFixed: 0,
      jerkBefore: 0,
      jerkDenoised: 0,
      jerkSynth: 0,
      jerkAfter: 0,
      weight: 0
    };

    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var times = track.times;
      var values = track.values;
      var n = times ? times.length : 0;
      var stride = n > 0 ? Math.max(1, Math.round(values.length / n)) : 1;
      var type = track.type || 'vector';

      stats.inputKeys += n;

      // Tipe diskrit tidak punya "kehalusan" — salin apa adanya.
      if (type === 'bool' || type === 'string' || n < 2) {
        outTracks.push({
          name: track.name,
          type: type,
          times: Array.prototype.slice.call(times || []),
          values: Array.prototype.slice.call(values || [])
        });
        stats.outputKeys += n;
        stats.tracksCopied++;
        continue;
      }

      var isQuat = (type === 'quaternion');
      var work = new Float64Array(values.length);
      for (var v = 0; v < values.length; v++) work[v] = values[v];

      if (isQuat) {
        stride = 4;
        stats.quaternionFlipsFixed += alignHemisphere(work, n);
      }

      // --- baseline untuk metrik
      var baseline = resampleLinear(times, work, stride, n, grid, isQuat);
      stats.jerkBefore += jerkMetric(baseline, sampleCount, stride, isQuat);

      // --- 2. Reconstruct
      var samples = isQuat
        ? resampleQuaternion(times, work, n, grid)
        : resampleNumeric(times, work, stride, n, grid, opt.holdAware);

      // --- motion mask
      var mask = buildMotionMask(times, work, stride, n, isQuat, grid, opt.contactLock);
      var cyclic = opt.loop && isCyclic(samples, sampleCount, stride, isQuat);

      // --- 3. Denoise
      if (opt.smoothing > 0) {
        var sigmaT = opt.smoothing * 0.05 * effectiveFps; // ~50ms pada setting maksimum
        var sigmaRange = estimateRangeSigma(samples, sampleCount, stride, isQuat, opt.smoothing);
        samples = isQuat
          ? bilateralQuaternion(samples, sampleCount, sigmaT, sigmaRange, mask, cyclic)
          : bilateralNumeric(samples, sampleCount, stride, sigmaT, sigmaRange, mask, cyclic);
      }

      // Diukur sebelum tahap sintesis: ini murni kualitas rekonstruksi +
      // denoise. Follow-through sesudahnya SENGAJA menambah percepatan
      // (itulah overshoot-nya), jadi mencampur keduanya jadi satu angka
      // akan terbaca seolah-olah alatnya merusak kurva.
      stats.jerkDenoised += jerkMetric(samples, sampleCount, stride, isQuat);

      // --- 4. Synthesize
      if (opt.followThrough > 0) {
        var meanSeg = (times[n - 1] - times[0]) / Math.max(n - 1, 1);
        var f = clamp(1 / (2 * Math.max(meanSeg, 1 / 120)), 1.2, 8);
        var z = lerp(0.95, 0.45, opt.followThrough);
        // r = 2 membuat lag pada gerakan berkecepatan tetap tepat nol
        // (k1 == k3), jadi animasi tidak melar mundur beberapa frame.
        // Overshoot-nya murni datang dari z < 1 saat gerakan berbelok.
        var r = 2.0;
        samples = isQuat
          ? dynamicsQuaternion(samples, sampleCount, dt, f, z, r, opt.followThrough, mask, opt.loop)
          : dynamicsNumeric(samples, sampleCount, stride, dt, f, z, r, opt.followThrough, mask, opt.loop);
      }

      // Dense, setelah sintesis: bareng jerkDenoised (yang juga dense),
      // selisih keduanya mengisolasi efek follow-through saja.
      stats.jerkSynth += jerkMetric(samples, sampleCount, stride, isQuat);

      // --- 5. Compact
      var tol = computeTolerance(samples, sampleCount, stride, isQuat, opt.reduction);
      var packed = decimate(grid, samples, stride, sampleCount, tol, isQuat);

      if (isQuat) {
        for (var q = 0; q < packed.times.length; q++) qNormalize(packed.values, q * 4);
      }

      // Diukur SETELAH decimation, pakai interpolasi linear seperti yang
      // dilakukan player saat runtime — jadi angkanya jujur soal trade-off
      // antara jumlah keyframe dan kehalusan, bukan angka ideal di atas kertas.
      var played = resampleLinear(packed.times, packed.values, stride, packed.times.length, grid, isQuat);
      stats.jerkAfter += jerkMetric(played, sampleCount, stride, isQuat);

      outTracks.push({
        name: track.name,
        type: type,
        times: packed.times,
        values: packed.values
      });

      stats.outputKeys += packed.times.length;
      stats.tracksProcessed++;
    }

    var counted = Math.max(stats.tracksProcessed, 1);
    stats.jerkBefore /= counted;
    stats.jerkDenoised /= counted;
    stats.jerkSynth /= counted;
    stats.jerkAfter /= counted;

    function gainOf(after) {
      return stats.jerkBefore > EPS ? clamp(1 - after / stats.jerkBefore, -1, 1) : 0;
    }

    // Angka utama: apa yang benar-benar didapat saat diputar, sudah
    // termasuk biaya keyframe reduction.
    stats.smoothnessGain = gainOf(stats.jerkAfter);
    // Kualitas kurva sebelum dipadatkan, tanpa efek overshoot.
    stats.reconstructionGain = gainOf(stats.jerkDenoised);
    // Sama-sama diukur pada grid rapat, jadi selisihnya murni kontribusi
    // follow-through (negatif = overshoot menambah percepatan, memang itu
    // tujuannya — bukan kerusakan).
    stats.overshootDelta = gainOf(stats.jerkSynth) - stats.reconstructionGain;
    stats.followThrough = opt.followThrough;
    stats.weight = estimateBytes(outTracks);

    return { name: clip.name || 'enhanced', duration: duration, tracks: outTracks, stats: stats };
  }

  /**
   * sigma domain-nilai untuk bilateral: dihitung dari median pergerakan
   * antar-sample, jadi otomatis menyesuaikan skala model (cm vs meter).
   */
  function estimateRangeSigma(samples, count, stride, isQuat, smoothing) {
    if (count < 2) return 0;
    var deltas = [];
    var step = Math.max(1, Math.floor(count / 512)); // cukup ambil cuplikan
    for (var i = step; i < count; i += step) {
      if (isQuat) {
        deltas.push(qAngle(samples, (i - step) * 4, samples, i * 4));
      } else {
        var acc = 0;
        for (var j = 0; j < stride; j++) {
          var d = samples[i * stride + j] - samples[(i - step) * stride + j];
          acc += d * d;
        }
        deltas.push(Math.sqrt(acc));
      }
    }
    var m = median(deltas);
    if (m < EPS) return 0; // sinyal datar: bilateral tidak relevan
    return m * lerp(2, 12, smoothing);
  }

  function computeTolerance(samples, count, stride, isQuat, reduction) {
    if (reduction <= 0) return 0;
    if (isQuat) return lerp(0.0002, 0.015, reduction); // radian
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < count * stride; i++) {
      var v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var range = max - min;
    if (!(range > EPS)) range = 1;
    return range * lerp(0.0005, 0.02, reduction);
  }

  function estimateBytes(tracks) {
    var total = 0;
    for (var i = 0; i < tracks.length; i++) {
      total += tracks[i].times.length * 4 + tracks[i].values.length * 4;
    }
    return total;
  }

  return {
    enhance: enhance,
    PRESETS: PRESETS,
    DEFAULTS: DEFAULTS,
    resolveOptions: resolveOptions,
    // diekspos untuk unit test / pemakaian lanjutan
    _internal: {
      alignHemisphere: alignHemisphere,
      resampleNumeric: resampleNumeric,
      resampleQuaternion: resampleQuaternion,
      resampleLinear: resampleLinear,
      bilateralNumeric: bilateralNumeric,
      bilateralQuaternion: bilateralQuaternion,
      dynamicsNumeric: dynamicsNumeric,
      dynamicsQuaternion: dynamicsQuaternion,
      decimate: decimate,
      isCyclic: isCyclic,
      windowRadius: windowRadius,
      jerkMetric: jerkMetric,
      buildMotionMask: buildMotionMask,
      qSlerp: qSlerp,
      qAngle: qAngle,
      qNormalize: qNormalize,
      qMul: qMul,
      qExp: qExp,
      qLog: qLog
    }
  };
});
