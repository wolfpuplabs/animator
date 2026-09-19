/*
 * app.js — viewer, kontrol, dan glue untuk engine MFS.
 */
(function () {
  'use strict';

  var state = {
    scene: null, camera: null, renderer: null, controls: null, clock: null,
    root: null,
    mixer: null,
    action: null,
    originalClips: [],
    enhancedClips: null,
    clipStats: [],
    clipIndex: 0,
    view: 'original',
    playing: true,
    speed: 1,
    duration: 0,
    scrubbing: false,
    fileName: 'model',
    trailGroup: null,
    presetName: 'balanced',
    clipFilter: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ================================================================== *
   * Scene
   * ================================================================== */

  function initScene() {
    var host = $('canvas-host');

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x0b1120);
    state.scene.fog = new THREE.Fog(0x0b1120, 18, 55);

    state.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    state.camera.position.set(3.2, 2.4, 5.2);

    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    state.renderer.outputEncoding = THREE.sRGBEncoding;
    host.appendChild(state.renderer.domElement);

    state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.07;
    state.controls.target.set(0, 0.8, 0);

    state.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x14202e, 0.85));

    var key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.bias = -0.0008;
    state.scene.add(key);

    var rim = new THREE.DirectionalLight(0x7dd3fc, 0.55);
    rim.position.set(-6, 3, -5);
    state.scene.add(rim);

    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.ShadowMaterial({ opacity: 0.4 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    state.scene.add(floor);

    var grid = new THREE.GridHelper(40, 40, 0x3b82f6, 0x223049);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    state.scene.add(grid);

    state.trailGroup = new THREE.Group();
    state.scene.add(state.trailGroup);

    state.clock = new THREE.Clock();
    window.addEventListener('resize', onResize);
    onResize();
    tick();
  }

  function onResize() {
    var host = $('canvas-host');
    var w = host.clientWidth || 1;
    var h = host.clientHeight || 1;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(w, h, false);
  }

  function tick() {
    requestAnimationFrame(tick);
    var delta = state.clock.getDelta();

    if (state.mixer && state.action && state.playing && !state.scrubbing) {
      state.mixer.update(delta * state.speed);
      syncTransport();
    }

    state.controls.update();
    state.renderer.render(state.scene, state.camera);
  }

  /**
   * Kotak batas sepanjang ANIMASI, bukan cuma pose diam.
   *
   * Memakai pose awal saja bikin kamera terlalu dekat: model yang
   * melompat atau berjalan langsung keluar frame begitu diputar.
   * (Untuk skinned mesh angkanya perkiraan — three r128 tidak menghitung
   * deformasi skinning di setFromObject — tapi jauh lebih baik daripada
   * satu pose.)
   */
  function animatedBounds(object, clip) {
    var box = new THREE.Box3();
    if (!clip || !(clip.duration > 0)) {
      box.setFromObject(object);
      return box;
    }

    var mixer = new THREE.AnimationMixer(object);
    var action = mixer.clipAction(clip);
    action.play();

    var probe = new THREE.Box3();
    var steps = 24;
    for (var i = 0; i < steps; i++) {
      mixer.setTime(clip.duration * i / (steps - 1));
      object.updateMatrixWorld(true);
      probe.setFromObject(object);
      if (!probe.isEmpty()) box.union(probe);
    }

    action.stop();
    mixer.setTime(0);
    object.updateMatrixWorld(true);
    return box;
  }

  function frameCamera(object, clip) {
    var box = animatedBounds(object, clip);
    if (box.isEmpty()) return;

    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z) || 1;
    var fov = state.camera.fov * Math.PI / 180;
    var dist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.1;

    state.camera.position.set(center.x + dist * 0.55, center.y + maxDim * 0.45, center.z + dist);
    state.camera.near = Math.max(maxDim / 500, 0.01);
    state.camera.far = dist * 12;
    state.camera.updateProjectionMatrix();
    state.controls.target.copy(center);
    state.controls.update();
  }

  /* ================================================================== *
   * Demo: animasi yang sengaja dibuat patah
   * ================================================================== */

  function buildDemo() {
    var group = new THREE.Group();
    group.name = 'Hopper';

    var bodyMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.35, metalness: 0.15 });
    var limbMat = new THREE.MeshStandardMaterial({ color: 0x8b5cf6, roughness: 0.5 });

    var body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 28), bodyMat);
    body.name = 'Body';
    body.castShadow = true;
    group.add(body);

    var head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 22), bodyMat);
    head.position.set(0, 0.62, 0.08);
    head.castShadow = true;
    body.add(head);

    [-0.3, 0.3].forEach(function (x) {
      var foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), limbMat);
      foot.position.set(x, -0.52, 0.06);
      foot.castShadow = true;
      body.add(foot);
    });

    // --- Kurva animasi: 8 fps, dengan jitter dan satu quaternion yang
    // sengaja dibalik tandanya (kasus nyata dari eksporter yang berbeda).
    var fps = 8, duration = 2.4;
    var count = Math.round(duration * fps) + 1;
    var seed = 20260919;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }

    var times = [], pos = [], quat = [], scale = [];
    var q = new THREE.Quaternion();
    var e = new THREE.Euler();

    for (var i = 0; i < count; i++) {
      var t = i / fps;
      times.push(t);

      var phase = t * Math.PI * 1.35;
      var hop = Math.abs(Math.sin(phase)) * 1.15;
      pos.push(
        Math.sin(t * 1.1) * 1.3 + rnd() * 0.05,
        0.62 + hop + rnd() * 0.05,
        Math.cos(t * 0.85) * 0.9 + rnd() * 0.05
      );

      e.set(Math.sin(phase) * 0.28 + rnd() * 0.05, t * 1.6, Math.cos(phase) * 0.22 + rnd() * 0.05);
      q.setFromEuler(e);
      var flip = (i === 9 || i === 10) ? -1 : 1; // hemisphere sengaja dirusak
      quat.push(q.x * flip, q.y * flip, q.z * flip, q.w * flip);

      // squash & stretch mengikuti fase lompatan
      var stretch = 1 + Math.sin(phase) * 0.14;
      scale.push(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
    }

    var clip = new THREE.AnimationClip('hop_stepped_8fps', duration, [
      new THREE.VectorKeyframeTrack('Hopper.position', times, pos),
      new THREE.QuaternionKeyframeTrack('Hopper.quaternion', times, quat),
      new THREE.VectorKeyframeTrack('Body.scale', times, scale)
    ]);

    state.fileName = 'demo_hopper';
    setModel(group, [clip], 'Demo Hopper (8 fps stepped)');
  }

  /* ================================================================== *
   * Model & clip
   * ================================================================== */

  function disposeObject(obj) {
    obj.traverse(function (child) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        var mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(function (m) { if (m.dispose) m.dispose(); });
      }
    });
  }

  function setModel(root, clips, label) {
    if (state.root) {
      state.scene.remove(state.root);
      disposeObject(state.root);
    }
    clearTrails();

    root.traverse(function (child) {
      if (child.isMesh || child.isSkinnedMesh) {
        child.castShadow = true;
        child.receiveShadow = false;
        if (child.frustumCulled !== undefined) child.frustumCulled = false;
      }
    });

    state.root = root;
    state.scene.add(root);
    state.originalClips = clips || [];
    state.enhancedClips = null;
    state.clipStats = [];
    state.clipIndex = 0;
    state.clipFilter = '';
    $('clip-filter').value = '';
    state.view = 'original';
    state.mixer = new THREE.AnimationMixer(root);

    frameCamera(root, state.originalClips[0]);
    renderClipList();
    rebindAction(false);
    refreshButtons();
    clearStats();
    toast('Dimuat: ' + label);
  }

  /** Klip hasil enhance untuk indeks tertentu, atau null kalau belum diproses. */
  function enhancedFor(index) {
    return state.enhancedClips ? (state.enhancedClips[index] || null) : null;
  }

  function hasAnyEnhanced() {
    if (!state.enhancedClips) return false;
    for (var i = 0; i < state.enhancedClips.length; i++) {
      if (state.enhancedClips[i]) return true;
    }
    return false;
  }

  /**
   * Daftar klip untuk ditampilkan/diekspor. Dalam mode Enhanced, klip yang
   * belum diproses ikut apa adanya — supaya export tidak diam-diam
   * kehilangan animasi hanya karena pengguna memproses satu klip saja.
   */
  function activeClipList() {
    if (state.view !== 'enhanced' || !state.enhancedClips) return state.originalClips;
    return state.originalClips.map(function (clip, i) {
      return state.enhancedClips[i] || clip;
    });
  }

  function activeClip() {
    if (state.view === 'enhanced') {
      var enhanced = enhancedFor(state.clipIndex);
      if (enhanced) return enhanced;
    }
    return state.originalClips[state.clipIndex] || null;
  }

  /**
   * Selalu bikin mixer baru saat set klip berganti.
   *
   * Alternatifnya (uncacheClip pada klip yang aksinya masih aktif) merusak
   * pembukuan internal AnimationMixer di three r128 — play() berikutnya
   * melempar "Cannot set properties of undefined". Mixer baru itu murah
   * dan menjamin state bersih.
   */
  function rebindAction(preserveTime) {
    if (!state.root) return;
    var prevTime = (preserveTime && state.action) ? state.action.time : 0;

    if (state.mixer) state.mixer.stopAllAction();
    state.action = null;
    state.mixer = new THREE.AnimationMixer(state.root);

    var clip = activeClip();
    if (!clip) {
      state.duration = 0;
      syncTransport();
      return;
    }

    state.action = state.mixer.clipAction(clip);
    state.action.setLoop(THREE.LoopRepeat, Infinity);
    state.action.clampWhenFinished = false;
    state.action.play();
    state.duration = clip.duration || 0;

    var t = state.duration > 0 ? Math.min(prevTime, state.duration) : 0;
    state.mixer.setTime(t);
    syncTransport();
    rebuildTrails();
  }

  var FILTER_THRESHOLD = 8; // di bawah ini daftar sudah cukup pendek untuk dipindai mata

  function clipLabel(clip, index) {
    return clip.name || ('Clip ' + (index + 1));
  }

  /**
   * Daftar animasi. Model dari Mixamo dan sejenisnya sering membawa puluhan
   * klip, jadi yang penting bukan cuma bisa memilih: tiap baris harus
   * langsung memberi tahu durasi, jumlah keyframe, dan apakah klip itu
   * sudah diproses — supaya tidak perlu klik satu per satu untuk tahu.
   */
  function renderClipList() {
    var section = $('clip-section');
    var list = $('clip-list');
    var clips = state.originalClips;

    if (!clips.length) {
      section.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    section.style.display = '';

    var filterBox = $('clip-filter');
    var showFilter = clips.length > FILTER_THRESHOLD;
    filterBox.style.display = showFilter ? '' : 'none';
    if (!showFilter && state.clipFilter) {
      state.clipFilter = '';
      filterBox.value = '';
    }

    var needle = state.clipFilter.trim().toLowerCase();
    var shown = 0;
    list.innerHTML = '';

    clips.forEach(function (clip, i) {
      if (needle && clipLabel(clip, i).toLowerCase().indexOf(needle) === -1) return;
      shown++;

      var enhanced = enhancedFor(i);
      var row = document.createElement('button');
      row.className = 'clip-row' + (i === state.clipIndex ? ' active' : '');
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === state.clipIndex ? 'true' : 'false');

      var originalKeys = ThreeAdapter.countKeys(clip);
      var meta = clip.duration.toFixed(2) + 's · ' +
        (enhanced
          ? originalKeys.toLocaleString() + ' → ' + ThreeAdapter.countKeys(enhanced).toLocaleString() + ' key'
          : originalKeys.toLocaleString() + ' key');

      var body = document.createElement('span');
      body.className = 'clip-body';
      var name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = clipLabel(clip, i);
      var metaEl = document.createElement('span');
      metaEl.className = 'clip-meta';
      metaEl.textContent = meta;
      body.appendChild(name);
      body.appendChild(metaEl);

      var badge = document.createElement('span');
      badge.className = 'clip-badge' + (enhanced ? ' done' : '');
      badge.title = enhanced ? 'Sudah di-enhance' : 'Belum diproses';

      row.appendChild(body);
      row.appendChild(badge);
      row.title = clipLabel(clip, i) + (enhanced ? ' — sudah di-enhance' : ' — belum diproses');
      row.addEventListener('click', function () { selectClip(i); });
      list.appendChild(row);
    });

    $('clip-empty').style.display = shown === 0 ? '' : 'none';

    var enhancedCount = 0;
    for (var k = 0; k < clips.length; k++) if (enhancedFor(k)) enhancedCount++;
    $('clip-count').textContent = clips.length + ' klip' +
      (enhancedCount ? ' · ' + enhancedCount + ' diproses' : '');

    var activeRow = list.querySelector('.clip-row.active');
    if (activeRow && activeRow.scrollIntoView) activeRow.scrollIntoView({ block: 'nearest' });
  }

  function selectClip(index) {
    if (index < 0 || index >= state.originalClips.length || index === state.clipIndex) return;
    state.clipIndex = index;
    rebindAction(false);
    refreshButtons();
    renderStats();
    renderClipList();
  }

  /** Pindah klip relatif, mengikuti urutan yang sedang terlihat di daftar. */
  function stepClip(delta) {
    var rows = $('clip-list').querySelectorAll('.clip-row');
    if (rows.length < 2) return;
    var at = -1;
    for (var i = 0; i < rows.length; i++) {
      if (parseInt(rows[i].dataset.index, 10) === state.clipIndex) { at = i; break; }
    }
    var next = at === -1 ? 0 : (at + delta + rows.length) % rows.length;
    selectClip(parseInt(rows[next].dataset.index, 10));
  }

  /* ================================================================== *
   * Load file
   * ================================================================== */

  function loadFile(file) {
    var url = URL.createObjectURL(file);
    var loader = new THREE.GLTFLoader();

    showOverlay('Memuat model 3D…', file.name);
    state.fileName = file.name.replace(/\.[^/.]+$/, '') || 'model';

    loader.load(url, function (gltf) {
      URL.revokeObjectURL(url);
      hideOverlay();
      if (!gltf.animations || !gltf.animations.length) {
        setModel(gltf.scene, [], file.name);
        toast('Model dimuat, tapi tidak ada klip animasi di dalamnya.', true);
        return;
      }
      setModel(gltf.scene, gltf.animations, file.name);
    }, function (evt) {
      if (evt && evt.lengthComputable) {
        $('overlay-sub').textContent = Math.round(evt.loaded / evt.total * 100) + '%';
      }
    }, function (err) {
      URL.revokeObjectURL(url);
      hideOverlay();
      console.error(err);
      toast('Gagal membaca file. Untuk .gltf dengan file terpisah, pakai .glb.', true);
    });
  }

  /* ================================================================== *
   * Enhance
   * ================================================================== */

  function readOptions() {
    return {
      fps: parseInt($('opt-fps').value, 10),
      smoothing: parseInt($('opt-smooth').value, 10) / 100,
      followThrough: parseInt($('opt-follow').value, 10) / 100,
      contactLock: parseInt($('opt-contact').value, 10) / 100,
      reduction: parseInt($('opt-reduce').value, 10) / 100,
      loop: $('opt-loop').checked,
      holdAware: true
    };
  }

  function runEnhance() {
    if (!state.originalClips.length) return;

    var options = readOptions();
    var startedAt = performance.now();

    // Model dengan puluhan animasi bisa makan waktu lama kalau semuanya
    // diproses. Kalau pengguna cuma menyetel satu klip, hormati itu.
    var targets = [];
    if ($('opt-all-clips').checked) {
      for (var t = 0; t < state.originalClips.length; t++) targets.push(t);
    } else {
      targets.push(state.clipIndex);
    }

    var results = new Array(targets.length);
    showOverlay('Mensintesis gerakan…', 'Menyiapkan');

    // Diproses per klip lewat timeout supaya UI tidak membeku pada model
    // besar, dan progresnya kelihatan.
    var i = 0;
    function step() {
      if (i >= targets.length) {
        finish();
        return;
      }
      var index = targets[i];
      var clip = state.originalClips[index];
      $('overlay-sub').textContent = 'Klip ' + (i + 1) + '/' + targets.length +
        ' — ' + clipLabel(clip, index);
      try {
        results[i] = ThreeAdapter.enhanceClip(clip, options);
      } catch (err) {
        console.error('Gagal memproses klip', clip.name, err);
        hideOverlay();
        toast('Gagal memproses klip "' + clipLabel(clip, index) + '": ' + err.message, true);
        return;
      }
      i++;
      setTimeout(step, 0);
    }

    function finish() {
      var elapsed = performance.now() - startedAt;
      var n = state.originalClips.length;

      // Hasil lama untuk klip lain dipertahankan, jadi memproses satu klip
      // tidak membatalkan pekerjaan sebelumnya.
      var clips = new Array(n);
      var stats = new Array(n);
      for (var k = 0; k < n; k++) {
        clips[k] = state.enhancedClips ? (state.enhancedClips[k] || null) : null;
        stats[k] = state.clipStats ? (state.clipStats[k] || null) : null;
      }
      targets.forEach(function (index, slot) {
        clips[index] = results[slot].clip;
        stats[index] = results[slot].stats;
      });

      state.enhancedClips = clips;
      state.clipStats = stats;
      state.lastElapsed = elapsed;
      state.view = 'enhanced';

      rebindAction(true);
      refreshButtons();
      renderStats();
      renderClipList();
      hideOverlay();
      toast(targets.length + ' klip selesai dalam ' + elapsed.toFixed(0) +
        ' ms — tekan C untuk bandingkan A/B.');
    }

    setTimeout(step, 30);
  }

  function resetEnhance() {
    state.enhancedClips = null;
    state.clipStats = [];
    state.view = 'original';
    rebindAction(true);
    refreshButtons();
    renderClipList();
    clearStats();
    toast('Kembali ke animasi original.');
  }

  /* ================================================================== *
   * Statistik
   * ================================================================== */

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function clearStats() {
    ['st-jitter', 'st-recon', 'st-fps', 'st-keys', 'st-tracks', 'st-flips', 'st-weight', 'st-time']
      .forEach(function (id) { $(id).textContent = '—'; });
    $('st-jitter').parentNode.classList.remove('warn');
    $('row-recon').style.display = 'none';
  }

  function signedPercent(v) {
    return (v >= 0 ? '−' : '+') + Math.abs(v * 100).toFixed(1) + '%';
  }

  function renderStats() {
    var stats = state.clipStats[state.clipIndex];
    if (!stats) {
      clearStats();
      if (hasAnyEnhanced()) $('st-jitter').textContent = 'belum diproses';
      return;
    }

    // Angka utama sengaja diukur setelah keyframe reduction dan setelah
    // follow-through, jadi ini benar-benar yang akan terlihat saat diputar.
    var gain = stats.smoothnessGain;
    var row = $('st-jitter').parentNode;
    $('st-jitter').textContent = signedPercent(gain);
    row.classList.toggle('warn', gain < -0.005);

    // Kalau angka utama tertekan oleh overshoot atau oleh pemangkasan
    // keyframe, tunjukkan kualitas kurva mentahnya supaya jelas apa yang
    // sebenarnya terjadi.
    var recon = stats.reconstructionGain;
    if (Math.abs(recon - gain) > 0.02) {
      $('row-recon').style.display = '';
      $('st-recon').textContent = signedPercent(recon);
      $('row-recon').title = stats.followThrough > 0
        ? 'Kurva sebelum dipadatkan dan sebelum overshoot ditambahkan.'
        : 'Kurva sebelum dipadatkan keyframe reduction.';
    } else {
      $('row-recon').style.display = 'none';
    }

    $('st-fps').textContent = stats.fps.toFixed(0) + ' fps';
    $('st-keys').textContent = stats.inputKeys.toLocaleString() + ' → ' + stats.outputKeys.toLocaleString();
    $('st-tracks').textContent = stats.tracksProcessed + (stats.tracksCopied ? ' (+' + stats.tracksCopied + ' disalin)' : '');
    $('st-flips').textContent = String(stats.quaternionFlipsFixed);
    $('st-weight').textContent = formatBytes(stats.weight);
    $('st-time').textContent = state.lastElapsed ? state.lastElapsed.toFixed(0) + ' ms' : '—';
  }

  /* ================================================================== *
   * Motion trail
   * ================================================================== */

  function clearTrails() {
    if (!state.trailGroup) return;
    while (state.trailGroup.children.length) {
      var child = state.trailGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  function makeTrail(points, color, opacity) {
    var geom = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
    return new THREE.Line(geom, mat);
  }

  function rebuildTrails() {
    clearTrails();
    var enabled = $('opt-trail').checked;
    $('legend').classList.toggle('visible', enabled && !!enhancedFor(state.clipIndex));
    if (!enabled || !state.root) return;

    var original = state.originalClips[state.clipIndex];
    if (!original) return;

    try {
      var pts = ThreeAdapter.sampleMotionPath(state.root, original, null, 240);
      if (pts && pts.length > 1) state.trailGroup.add(makeTrail(pts, 0xfb7185, 0.85));

      if (enhancedFor(state.clipIndex)) {
        var pts2 = ThreeAdapter.sampleMotionPath(state.root, enhancedFor(state.clipIndex), null, 240);
        if (pts2 && pts2.length > 1) state.trailGroup.add(makeTrail(pts2, 0x22d3ee, 0.95));
      }
    } catch (err) {
      console.warn('Motion trail tidak bisa dibuat:', err);
    }

    // sampling di atas memakai mixer sementara pada root yang sama,
    // jadi kembalikan pose ke waktu playback saat ini
    if (state.mixer && state.action) state.mixer.setTime(state.action.time);
  }

  /* ================================================================== *
   * Export
   * ================================================================== */

  function download(blob, filename) {
    var link = document.createElement('a');
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportGLB() {
    if (!state.root) return;
    var clips = activeClipList();
    var suffix = (state.view === 'enhanced') ? '_enhanced' : '_original';

    showOverlay('Menyiapkan GLB…', clips.length + ' klip animasi');

    // Reset ke frame 0 supaya pose yang tersimpan adalah pose bind/awal,
    // bukan pose acak di tengah animasi.
    if (state.mixer) state.mixer.setTime(0);
    state.root.updateMatrixWorld(true);
    state.root.traverse(function (child) {
      if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
    });

    var exporter = new THREE.GLTFExporter();
    var options = { binary: true, animations: clips, includeCustomExtensions: true };

    var onDone = function (result) {
      hideOverlay();
      if (result instanceof ArrayBuffer) {
        download(new Blob([result], { type: 'model/gltf-binary' }), state.fileName + suffix + '.glb');
        toast('GLB tersimpan (' + clips.length + ' klip).');
      } else {
        // Sebagian build mengabaikan opsi binary; jangan bungkus objek JSON
        // ke dalam Blob biner — itu menghasilkan file rusak.
        download(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }),
                 state.fileName + suffix + '.gltf');
        toast('Eksporter mengembalikan glTF JSON, disimpan sebagai .gltf.');
      }
    };

    var onError = function (err) {
      hideOverlay();
      console.error('GLTFExporter:', err);
      toast('Gagal mengekspor GLB: ' + (err && err.message ? err.message : err), true);
    };

    setTimeout(function () {
      try {
        // Tanda tangan parse() berubah antar-versi three: versi lama
        // (r128) memakai (input, onDone, options), versi baru menyisipkan
        // onError di tengah. Deteksi arity agar opsi tidak tertukar —
        // kalau tertukar, `binary: true` dan daftar animasi ikut hilang.
        if (exporter.parse.length >= 4) {
          exporter.parse(state.root, onDone, onError, options);
        } else {
          exporter.parse(state.root, onDone, options);
        }
      } catch (err) {
        onError(err);
      }
    }, 60);
  }

  function exportJSON() {
    var clip = activeClip();
    if (!clip) return;
    var suffix = (state.view === 'enhanced') ? '_enhanced' : '_original';
    var json = THREE.AnimationClip.toJSON(clip);
    download(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }),
             state.fileName + '_' + (clip.name || 'clip') + suffix + '.json');
    toast('Klip "' + (clip.name || 'clip') + '" tersimpan sebagai JSON.');
  }

  /* ================================================================== *
   * UI
   * ================================================================== */

  function showOverlay(text, sub) {
    $('overlay-text').textContent = text;
    $('overlay-sub').textContent = sub || '';
    $('overlay').classList.add('active');
  }

  function hideOverlay() { $('overlay').classList.remove('active'); }

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 4200);
  }

  function refreshButtons() {
    var hasClips = state.originalClips.length > 0;
    var hasEnhanced = hasAnyEnhanced();

    $('btn-run').disabled = !hasClips;
    $('btn-reset').disabled = !hasEnhanced;
    $('btn-export-glb').disabled = !state.root;
    $('btn-export-json').disabled = !activeClip();
    $('btn-view-enhanced').disabled = !hasEnhanced;

    $('btn-view-original').classList.toggle('active', state.view === 'original');
    $('btn-view-enhanced').classList.toggle('active', state.view === 'enhanced');

    if (state.view !== 'enhanced') {
      $('export-note').textContent = 'Export memakai klip ORIGINAL. Jalankan enhance dulu untuk hasil halus.';
    } else {
      var total = state.originalClips.length;
      var done = 0;
      for (var i = 0; i < total; i++) if (enhancedFor(i)) done++;
      $('export-note').textContent = done === total
        ? 'Export memakai klip HASIL ENHANCE (semua ' + total + ' klip ikut).'
        : 'Export ikut semua ' + total + ' klip; ' + (total - done) +
          ' di antaranya masih versi original karena belum diproses.';
    }
  }

  function syncTransport() {
    var t = state.action ? state.action.time : 0;
    var d = state.duration || 0;
    if (!state.scrubbing) {
      $('timeline').value = d > 0 ? String(Math.round(t / d * 1000)) : '0';
    }
    $('time-display').textContent = t.toFixed(2) + 's / ' + d.toFixed(2) + 's';
  }

  function setPlaying(playing) {
    state.playing = playing;
    $('btn-play').innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
    $('btn-play').title = playing ? 'Pause (Space)' : 'Play (Space)';
  }

  function setView(view) {
    if (view === 'enhanced' && !state.enhancedClips) return;
    if (state.view === view) return;
    state.view = view;
    rebindAction(true);
    refreshButtons();
    renderStats();
  }

  function buildPresetButtons() {
    var grid = $('preset-grid');
    Object.keys(Fluidizer.PRESETS).forEach(function (key) {
      var p = Fluidizer.PRESETS[key];
      var btn = document.createElement('button');
      btn.className = 'preset';
      btn.dataset.preset = key;
      btn.innerHTML = '<span class="p-name">' + p.label + '</span>' +
                      '<span class="p-meta">' + p.fps + ' fps</span>';
      btn.addEventListener('click', function () { applyPreset(key); });
      grid.appendChild(btn);
    });
  }

  function applyPreset(key) {
    var p = Fluidizer.PRESETS[key];
    if (!p) return;
    state.presetName = key;
    $('opt-fps').value = String(p.fps);
    $('opt-smooth').value = String(Math.round(p.smoothing * 100));
    $('opt-follow').value = String(Math.round(p.followThrough * 100));
    $('opt-contact').value = String(Math.round(p.contactLock * 100));
    $('opt-reduce').value = String(Math.round(p.reduction * 100));
    syncSliderLabels();
    markActivePreset();
  }

  function markActivePreset() {
    var buttons = document.querySelectorAll('.preset');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].dataset.preset === state.presetName);
    }
  }

  function syncSliderLabels() {
    $('val-fps').textContent = $('opt-fps').value + ' fps';
    $('val-smooth').textContent = $('opt-smooth').value + '%';
    $('val-follow').textContent = $('opt-follow').value + '%';
    $('val-contact').textContent = $('opt-contact').value + '%';
    $('val-reduce').textContent = $('opt-reduce').value + '%';
  }

  function bindEvents() {
    // --- sumber
    var dz = $('dropzone');
    dz.addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) loadFile(e.target.files[0]);
      e.target.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    // jangan sampai file yang meleset dari dropzone dibuka oleh browser
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('btn-demo').addEventListener('click', buildDemo);

    $('clip-filter').addEventListener('input', function (e) {
      state.clipFilter = e.target.value;
      renderClipList();
    });

    // --- parameter
    ['opt-fps', 'opt-smooth', 'opt-follow', 'opt-contact', 'opt-reduce'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        syncSliderLabels();
        state.presetName = null; // geser manual = custom
        markActivePreset();
      });
    });

    $('opt-trail').addEventListener('change', rebuildTrails);

    $('btn-run').addEventListener('click', runEnhance);
    $('btn-reset').addEventListener('click', resetEnhance);
    $('btn-export-glb').addEventListener('click', exportGLB);
    $('btn-export-json').addEventListener('click', exportJSON);

    // --- A/B
    $('btn-view-original').addEventListener('click', function () { setView('original'); });
    $('btn-view-enhanced').addEventListener('click', function () { setView('enhanced'); });

    // --- transport
    $('btn-play').addEventListener('click', function () { setPlaying(!state.playing); });
    $('btn-stop').addEventListener('click', function () {
      if (state.mixer) state.mixer.setTime(0);
      syncTransport();
    });

    var timeline = $('timeline');
    timeline.addEventListener('pointerdown', function () { state.scrubbing = true; });
    timeline.addEventListener('input', function () {
      state.scrubbing = true;
      if (!state.mixer || !state.duration) return;
      var t = parseInt(timeline.value, 10) / 1000 * state.duration;
      state.mixer.setTime(Math.min(t, state.duration - 1e-4));
      $('time-display').textContent = t.toFixed(2) + 's / ' + state.duration.toFixed(2) + 's';
    });
    ['pointerup', 'pointercancel', 'change'].forEach(function (evt) {
      timeline.addEventListener(evt, function () { state.scrubbing = false; });
    });

    $('speed-select').addEventListener('change', function (e) {
      state.speed = parseFloat(e.target.value);
    });

    // --- keyboard
    window.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying(!state.playing);
      } else if (e.key === 'c' || e.key === 'C') {
        setView(state.view === 'enhanced' ? 'original' : 'enhanced');
      } else if (e.key === '[') {
        stepClip(-1);
      } else if (e.key === ']') {
        stepClip(1);
      }
    });
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  window.addEventListener('load', function () {
    if (typeof THREE === 'undefined') {
      document.body.innerHTML =
        '<div style="padding:2rem;font-family:sans-serif;color:#f1f5f9;background:#0b1120;height:100vh">' +
        '<h2>three.js gagal dimuat</h2><p>Halaman ini mengambil three.js dari CDN. ' +
        'Periksa koneksi internet lalu muat ulang.</p></div>';
      return;
    }
    buildPresetButtons();
    applyPreset('balanced');
    bindEvents();
    initScene();
    setPlaying(true);
    buildDemo();
  });
})();
