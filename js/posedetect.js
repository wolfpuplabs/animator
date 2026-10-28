/*
 * posedetect.js — ambil titik sendi dari berkas video.
 *
 * Memakai MediaPipe Pose Landmarker lewat WebAssembly, jadi seluruh
 * deteksi berjalan di peramban; video tidak dikirim ke mana pun.
 *
 * Video dibaca dengan cara menggeser posisi putar lalu menunggu frame
 * siap, bukan memutarnya secara nyata. Lebih lambat, tapi hasilnya sama
 * setiap kali dijalankan dan tidak ada frame yang terlewat saat perangkat
 * sedang sibuk.
 */
(function (root) {
  'use strict';

  // Bisa ditimpa sebelum pemakaian, misalnya untuk menunjuk berkas lokal.
  var CONFIG = {
    module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/' +
           'pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
  };

  var landmarkerPromise = null;

  /*
   * MediaPipe mode VIDEO menolak frame yang timestamp-nya tidak lebih
   * besar dari frame sebelumnya. Video kedua mulai lagi dari nol, jadi
   * tanpa penghitung yang terus naik seluruh frame video berikutnya
   * ditolak dan deteksinya gagal tanpa pesan yang jelas.
   */
  var timestampCursor = 0;

  function config() {
    var override = root.MFS_MEDIAPIPE || {};
    return {
      module: override.module || CONFIG.module,
      wasm: override.wasm || CONFIG.wasm,
      model: override.model || CONFIG.model
    };
  }

  /** Dimuat sekali lalu dipakai ulang; menyiapkannya mahal. */
  function getLandmarker() {
    if (landmarkerPromise) return landmarkerPromise;
    var cfg = config();
    // Specifier relatif tidak bisa di-resolve oleh import() yang dipanggil
    // dari script klasik — base URL-nya about:blank. Jadi dijadikan URL
    // absolut terhadap halaman lebih dulu.
    var moduleUrl = cfg.module;
    try { moduleUrl = new URL(cfg.module, document.baseURI).href; } catch (err) { /* biarkan apa adanya */ }

    landmarkerPromise = import(/* webpackIgnore: true */ moduleUrl)
      .then(function (vision) {
        // Nama metodenya berganti antar versi MediaPipe: yang lama
        // resolveForVisionTasks, yang baru forVisionTasks.
        var resolver = vision.FilesetResolver;
        var resolve = resolver.forVisionTasks || resolver.resolveForVisionTasks;
        if (typeof resolve !== 'function') {
          throw new Error('FilesetResolver tidak punya metode yang dikenal');
        }
        return resolve.call(resolver, cfg.wasm).then(function (fileset) {
          function create(delegate) {
            return vision.PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: cfg.model, delegate: delegate },
              runningMode: 'VIDEO',
              numPoses: 1,
              minPoseDetectionConfidence: 0.5,
              minPosePresenceConfidence: 0.5,
              minTrackingConfidence: 0.5
            });
          }
          // Delegate GPU jauh lebih cepat tapi butuh WebGL2 yang sehat.
          // Kalau gagal, jatuh ke CPU: lambat masih jauh lebih baik
          // daripada pesan "model gagal diunduh" yang menyesatkan.
          return create('GPU').catch(function (err) {
            console.warn('Delegate GPU gagal, memakai CPU:', err);
            return create('CPU');
          });
        });
      })
      .catch(function (err) {
        landmarkerPromise = null; // biar percobaan berikutnya tidak ikut gagal
        throw err;
      });
    return landmarkerPromise;
  }

  function loadVideo(url) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      var done = false;
      video.addEventListener('loadeddata', function () {
        if (done) return;
        done = true;
        resolve(video);
      });
      video.addEventListener('error', function () {
        reject(new Error('video tidak bisa dibaca'));
      });
      video.src = url;
      video.load();
    });
  }

  /**
   * Dapatkan durasi yang bisa dipakai.
   *
   * Berkas WebM hasil MediaRecorder — termasuk rekaman layar — sering
   * tidak menyimpan durasi di metadata, dan peramban melaporkannya
   * sebagai Infinity sampai berkasnya dijelajahi sampai akhir. Menolak
   * berkas seperti itu berarti menolak sebagian besar rekaman layar.
   */
  function resolveDuration(video) {
    if (video.duration > 0 && isFinite(video.duration)) {
      return Promise.resolve(video.duration);
    }
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        video.removeEventListener('durationchange', onChange);
        var d = video.duration;
        try { video.currentTime = 0; } catch (err) { /* abaikan */ }
        resolve(isFinite(d) && d > 0 ? d : 0);
      }
      function onChange() {
        if (isFinite(video.duration) && video.duration > 0) finish();
      }
      video.addEventListener('durationchange', onChange);
      // memaksa peramban menjelajah ke akhir berkas
      try { video.currentTime = 1e7; } catch (err) { finish(); }
      setTimeout(finish, 3000);
    });
  }

  function seek(video, time) {
    return new Promise(function (resolve) {
      var settled = false;
      function onSeeked() {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        // beri satu frame supaya piksel benar-benar siap dibaca
        requestAnimationFrame(function () { resolve(); });
      }
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
      // beberapa peramban tidak memicu 'seeked' kalau waktunya tidak berubah
      setTimeout(onSeeked, 400);
    });
  }

  /**
   * @param {File|Blob} file berkas video
   * @param {Object} options { fps, maxFrames, onProgress(done,total), signal }
   * @returns {Promise<{frames, width, height, duration, detected}>}
   */
  function captureFromVideo(file, options) {
    var opt = options || {};
    var fps = Math.max(1, Math.min(60, opt.fps || 24));
    var maxFrames = opt.maxFrames || 1800;
    var url = URL.createObjectURL(file);

    return Promise.all([getLandmarker(), loadVideo(url)]).then(function (both) {
      var landmarker = both[0];
      var video = both[1];

      return resolveDuration(video).then(function (duration) {
      if (!(duration > 0) || !isFinite(duration)) {
        throw new Error('durasi video tidak terbaca');
      }

      var count = Math.min(maxFrames, Math.max(2, Math.round(duration * fps)));
      var step = duration / count;
      var frames = [];
      var detected = 0;
      var index = 0;

      function next() {
        if (opt.signal && opt.signal.aborted) return Promise.reject(new Error('dibatalkan'));
        if (index >= count) return Promise.resolve();

        var time = Math.min(index * step, Math.max(duration - 1e-3, 0));
        return seek(video, time).then(function () {
          var result;
          try {
            result = landmarker.detectForVideo(video, timestampCursor + Math.round(time * 1000));
          } catch (err) {
            result = null;
          }

          var world = result && result.worldLandmarks && result.worldLandmarks[0];
          if (world) {
            detected++;
            // visibility ada di landmarks layar, bukan di worldLandmarks
            var screen = result.landmarks && result.landmarks[0];
            frames.push({
              time: time,
              landmarks: world.map(function (p, i) {
                var vis = screen && screen[i] ? screen[i].visibility : 1;
                return { x: p.x, y: p.y, z: p.z, visibility: vis === undefined ? 1 : vis };
              })
            });
          } else {
            frames.push({ time: time, landmarks: [] });
          }

          index++;
          if (opt.onProgress) opt.onProgress(index, count);
          return next();
        });
      }

      return next().then(function () {
        // sisakan jarak supaya tangkapan berikutnya tetap maju
        timestampCursor += Math.round(duration * 1000) + 1000;
        return {
          frames: frames, detected: detected, duration: duration,
          width: video.videoWidth, height: video.videoHeight, sampleFps: fps
        };
      }).finally(function () {
        URL.revokeObjectURL(url);
        video.removeAttribute('src');
        video.load();
      });
      });
    }).catch(function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  function isSupported() {
    return typeof WebAssembly === 'object' && typeof document !== 'undefined';
  }

  root.PoseDetect = {
    captureFromVideo: captureFromVideo,
    isSupported: isSupported,
    config: config,
    reset: function () { landmarkerPromise = null; timestampCursor = 0; }
  };
})(typeof self !== 'undefined' ? self : this);
