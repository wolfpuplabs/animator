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
    ghost: { root: null, mixer: null, action: null, material: null },
    skinReport: null,
    presetName: 'balanced',
    clipFilter: ''
  };

  var $ = function (id) { return document.getElementById(id); };
  // Sengaja TIDAK dinamai `t`: fungsi di berkas ini banyak memakai `t`
  // sebagai variabel waktu, dan hoisting `var t` akan menutupi helper ini
  // untuk seluruh fungsi — persis yang sempat membuat demo gagal dimuat.
  var tr = function (key, params) { return I18n.t(key, params); };

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
    window.addEventListener('orientationchange', onResize);
    if (window.visualViewport) {
      // Toolbar browser yang muncul-hilang saat scroll mengubah ini tanpa
      // memicu resize biasa.
      window.visualViewport.addEventListener('resize', onResize);
    }
    onResize();
    tick();
  }

  /**
   * Kunci tinggi app ke area yang benar-benar terlihat.
   *
   * Satuan viewport CSS tidak bisa diandalkan di browser ponsel dan
   * tablet: sebagian melaporkan tinggi seolah-olah toolbar tidak ada,
   * sehingga bar kontrol di bawah terdorong keluar layar dan tidak bisa
   * di-scroll karena overflow disembunyikan. visualViewport melaporkan
   * yang sebenarnya terlihat.
   *
   * Saat pengguna melakukan pinch-zoom, visualViewport ikut mengecil —
   * itu bukan perubahan tata letak, jadi diabaikan.
   */
  function syncAppHeight() {
    var vv = window.visualViewport;
    var height = window.innerHeight;
    if (vv && (!vv.scale || vv.scale <= 1.01)) {
      height = Math.min(height, vv.height);
    }
    if (height > 0) {
      document.documentElement.style.setProperty('--app-height', height + 'px');
    }
  }

  function onResize() {
    syncAppHeight();
    var host = $('canvas-host');
    var w = host.clientWidth || 1;
    var h = host.clientHeight || 1;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();

    /*
     * Argumen ketiga HARUS dibiarkan default (true).
     *
     * Dengan false, three hanya menyetel atribut width/height kanvas ke
     * ukuran buffer gambar — yaitu ukuran CSS dikali device pixel ratio —
     * dan tidak menyetel gaya CSS-nya. Di layar dengan dpr 2, elemen
     * kanvasnya jadi dua kali lebih besar dari wadahnya: model yang
     * berada di tengah kanvas muncul di pojok kanan bawah area yang
     * terlihat, ukurannya membesar, dan bar kontrol terdorong keluar.
     */
    state.renderer.setSize(w, h);
  }

  function tick() {
    requestAnimationFrame(tick);
    var delta = state.clock.getDelta();

    if (state.mixer && state.action && state.playing && !state.scrubbing) {
      state.mixer.update(delta * state.speed);
      syncTransport();
    }

    // Bayangan selalu mengikuti waktu model utama, termasuk saat di-scrub
    // atau dijeda — kalau dibiarkan jalan sendiri keduanya akan melenceng
    // dan perbandingannya jadi tidak berarti.
    if (state.ghost.mixer && state.action) {
      state.ghost.mixer.setTime(state.action.time);
    }

    state.controls.update();
    state.renderer.render(state.scene, state.camera);
  }

  var BOUND_TIME_SAMPLES = 16;
  var BOUND_VERTEX_BUDGET = 512;

  /**
   * Kumpulkan mesh yang perlu diukur, sekalian pilih vertex contoh untuk
   * yang ber-skeleton. Vertex-nya disubsample karena mengukur seluruh
   * vertex di setiap titik waktu terlalu mahal untuk model besar.
   */
  function collectBoundsTargets(object) {
    var skinned = [], plain = [];
    object.traverse(function (child) {
      if (!child.geometry) return;
      var attrs = child.geometry.attributes;
      if (child.isSkinnedMesh && attrs && attrs.skinIndex && typeof child.boneTransform === 'function') {
        var count = attrs.position.count;
        var stride = Math.max(1, Math.ceil(count / BOUND_VERTEX_BUDGET));
        var indices = [];
        for (var i = 0; i < count; i += stride) indices.push(i);
        if (count > 0 && indices[indices.length - 1] !== count - 1) indices.push(count - 1);
        skinned.push({ mesh: child, indices: indices, subsampled: stride > 1 });
      } else if (child.isMesh) {
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        plain.push(child);
      }
    });
    return { skinned: skinned, plain: plain };
  }

  /**
   * Kotak batas sepanjang ANIMASI, bukan cuma pose diam.
   *
   * Dua hal yang gampang salah di sini:
   *
   * 1. Memakai pose awal saja bikin kamera terlalu dekat — model yang
   *    melompat atau berjalan langsung keluar frame begitu diputar.
   * 2. Box3.setFromObject memakai bounding box geometri di BIND POSE lalu
   *    mengalikannya dengan matriks dunia mesh. Untuk skinned mesh itu
   *    tidak melihat transformasi tulang sama sekali, jadi ukurannya bisa
   *    meleset berkali lipat — akibatnya model muncul raksasa dan melenceng
   *    dari tengah. Karena itu vertex-nya dihitung lewat boneTransform,
   *    yaitu posisi setelah skinning.
   */
  function measureBounds(object, clip) {
    var animated = new THREE.Box3();
    var rest = new THREE.Box3();
    var targets = collectBoundsTargets(object);
    var v = new THREE.Vector3();
    var probe = new THREE.Box3();
    var subsampled = false;

    function expandAtCurrentPose(box) {
      object.updateMatrixWorld(true);
      targets.skinned.forEach(function (entry) {
        entry.mesh.skeleton.update();
        if (entry.subsampled) subsampled = true;
        for (var i = 0; i < entry.indices.length; i++) {
          entry.mesh.boneTransform(entry.indices[i], v);
          v.applyMatrix4(entry.mesh.matrixWorld);
          box.expandByPoint(v);
        }
      });
      targets.plain.forEach(function (mesh) {
        if (!mesh.geometry.boundingBox) return;
        probe.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        box.union(probe);
      });
    }

    function pad(box) {
      // Vertex disubsample, jadi titik terjauh bisa terlewat.
      if (!box.isEmpty() && subsampled) {
        var size = box.getSize(new THREE.Vector3());
        box.expandByVector(size.multiplyScalar(0.02));
      }
      if (box.isEmpty()) box.setFromObject(object);
      return box;
    }

    if (!clip || !(clip.duration > 0)) {
      expandAtCurrentPose(animated);
      pad(animated);
      rest.copy(animated);
      return { animated: animated, rest: rest };
    }

    var mixer = new THREE.AnimationMixer(object);
    var action = mixer.clipAction(clip);
    action.play();

    for (var i = 0; i < BOUND_TIME_SAMPLES; i++) {
      mixer.setTime(clip.duration * i / (BOUND_TIME_SAMPLES - 1));
      expandAtCurrentPose(animated);
      if (i === 0) expandAtCurrentPose(rest);
    }

    action.stop();
    mixer.setTime(0);
    object.updateMatrixWorld(true);

    pad(animated);
    pad(rest);
    return { animated: animated, rest: rest };
  }

  function animatedBounds(object, clip) {
    return measureBounds(object, clip).animated;
  }

  // Sejauh mana kamera boleh mundur demi menampung seluruh lintasan
  // gerak, relatif terhadap ukuran model itu sendiri. Tanpa batas ini,
  // animasi dengan perpindahan jauh akan menyusutkan modelnya jadi titik.
  var MAX_TRAVEL_ZOOM_OUT = 2.5;

  /**
   * Bidik pose awal, tapi ukur jarak dari seluruh lintasan gerak.
   *
   * Membidik pusat kotak sepanjang animasi terasa benar di atas kertas,
   * tapi di frame pertama model justru berada di salah satu ujung
   * geraknya — jadi saat pertama muncul ia terlihat melenceng dari tengah.
   * Yang dibidik sekarang adalah pusat pose di frame 0, sementara jaraknya
   * tetap dihitung agar seluruh lintasan muat, supaya model tidak keluar
   * frame begitu diputar.
   */
  function frameCamera(object, clip) {
    var bounds = measureBounds(object, clip);
    var box = bounds.animated;
    if (box.isEmpty()) return;

    var restBox = bounds.rest.isEmpty() ? box : bounds.rest;
    var target = restBox.getCenter(new THREE.Vector3());
    var restSize = restBox.getSize(new THREE.Vector3());
    var maxDim = Math.max(restSize.x, restSize.y, restSize.z) || 1;

    // Jari-jari pose awal, lalu jari-jari seluruh lintasan diukur dari
    // titik bidik yang sama.
    var restRadius = restSize.length() / 2 || maxDim / 2;
    var travelRadius = restRadius;
    var corner = new THREE.Vector3();
    for (var i = 0; i < 8; i++) {
      corner.set(
        (i & 1) ? box.max.x : box.min.x,
        (i & 2) ? box.max.y : box.min.y,
        (i & 4) ? box.max.z : box.min.z
      );
      travelRadius = Math.max(travelRadius, corner.distanceTo(target));
    }

    var radius = Math.min(travelRadius, restRadius * MAX_TRAVEL_ZOOM_OUT);
    var dir = new THREE.Vector3(0.48, 0.35, 1).normalize();

    // Jarak awal dari FOV vertikal DAN horizontal. Memakai yang vertikal
    // saja membuat model lebar — rentang sayap, misalnya — meluber keluar
    // di viewport yang sempit.
    var halfV = Math.tan(state.camera.fov * Math.PI / 360);
    var aspect = state.camera.aspect || 1;
    var halfH = halfV * aspect;
    var dist = Math.max(radius / halfV, radius / halfH) * 1.15;

    function place(distance) {
      state.camera.position.copy(target).addScaledVector(dir, distance);
      state.camera.near = Math.max(maxDim / 500, 0.01);
      state.camera.far = distance * 12 + radius * 4;
      state.camera.updateProjectionMatrix();
      state.camera.updateMatrixWorld(true);
    }

    /*
     * Rumus di atas mengandaikan model muat dalam bola berjari-jari
     * `radius` di sekitar titik bidik. Untuk bentuk yang panjang atau
     * yang jauh dari titik asalnya, andaian itu bisa meleset dan model
     * berakhir setengah keluar layar.
     *
     * Jadi hasilnya diperiksa, bukan dipercaya: delapan sudut kotak pose
     * awal diproyeksikan ke layar, lalu jaraknya dikoreksi sampai
     * semuanya masuk dengan margin yang wajar.
     */
    var corners = [];
    for (var c = 0; c < 8; c++) {
      corners.push(new THREE.Vector3(
        (c & 1) ? restBox.max.x : restBox.min.x,
        (c & 2) ? restBox.max.y : restBox.min.y,
        (c & 4) ? restBox.max.z : restBox.min.z
      ));
    }

    // Seberapa jauh sudut terjauh model boleh mencapai tepi frame, dalam
    // koordinat layar ternormalisasi (1 = tepat di tepi). 0,58 menyisakan
    // margin yang cukup supaya model tidak menyenggol tepi saat bergerak.
    var TARGET_FILL = 0.58;
    var probe = new THREE.Vector3();

    place(dist);
    for (var pass = 0; pass < 4; pass++) {
      var extent = 0;
      for (var k = 0; k < corners.length; k++) {
        probe.copy(corners[k]).project(state.camera);
        extent = Math.max(extent, Math.abs(probe.x), Math.abs(probe.y));
      }
      if (!(extent > 0) || !isFinite(extent)) break;
      if (Math.abs(extent - TARGET_FILL) < 0.03) break;
      dist *= extent / TARGET_FILL;
      place(dist);
    }

    state.controls.target.copy(target);
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
    setModel(group, [clip], tr('demo.name'));
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
    // Bayangan memegang rujukan ke geometri model lama, jadi harus dilepas
    // sebelum model itu dibuang.
    clearGhost();
    $('opt-ghost').checked = false;
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
    state.skinReport = null;
    state.clipFilter = '';
    $('clip-filter').value = '';
    state.view = 'original';
    state.mixer = new THREE.AnimationMixer(root);

    frameCamera(root, state.originalClips[0]);
    renderClipList();
    rebindAction(false);
    refreshButtons();
    updateSkinControls();
    renderSkinReport();
    clearStats();
    toast(tr('toast.loaded', { name: label }));
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
    buildGhost();
  }

  var FILTER_THRESHOLD = 8; // di bawah ini daftar sudah cukup pendek untuk dipindai mata

  function clipLabel(clip, index) {
    return clip.name || tr('clip.unnamed', { n: index + 1 });
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
      var keyWord = tr('clip.key');
      var meta = clip.duration.toFixed(2) + 's · ' +
        (enhanced
          ? originalKeys.toLocaleString() + ' → ' + ThreeAdapter.countKeys(enhanced).toLocaleString() + ' ' + keyWord
          : originalKeys.toLocaleString() + ' ' + keyWord);

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
      badge.title = enhanced ? tr('clip.enhanced') : tr('clip.pending');

      row.appendChild(body);
      row.appendChild(badge);
      row.title = clipLabel(clip, i) + ' — ' + (enhanced ? tr('clip.enhanced') : tr('clip.pending'));
      row.addEventListener('click', function () { selectClip(i); });
      list.appendChild(row);
    });

    $('clip-empty').style.display = shown === 0 ? '' : 'none';

    var enhancedCount = 0;
    for (var k = 0; k < clips.length; k++) if (enhancedFor(k)) enhancedCount++;
    $('clip-count').textContent = tr('clip.count', { n: clips.length }) +
      (enhancedCount ? ' · ' + tr('clip.done', { n: enhancedCount }) : '');

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

    showOverlay(tr('overlay.loading'), file.name);
    state.fileName = file.name.replace(/\.[^/.]+$/, '') || 'model';

    loader.load(url, function (gltf) {
      URL.revokeObjectURL(url);
      hideOverlay();
      if (!gltf.animations || !gltf.animations.length) {
        setModel(gltf.scene, [], file.name);
        toast(tr('toast.noanim'), true);
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
      toast(tr('toast.loadfail'), true);
    });
  }

  /* ================================================================== *
   * Enhance
   * ================================================================== */

  function readSkinOptions() {
    return {
      smoothing: parseInt($('opt-envelope').value, 10) / 100,
      iterations: parseInt($('opt-skin-iter').value, 10),
      minWeight: 0.01,
      fixOrphans: true
    };
  }

  /**
   * Perbaikan skinning bekerja pada mesh, bukan pada kurva animasi, jadi
   * dijalankan sekali untuk seluruh model — bukan per klip.
   */
  function applySkinRepair() {
    if (!state.root || !$('opt-skin').checked) return null;
    if (!ThreeAdapter.hasSkinning(state.root)) return null;
    try {
      var result = ThreeAdapter.repairSkinning(state.root, readSkinOptions());
      return result.meshes ? result : null;
    } catch (err) {
      console.error('Perbaikan skinning gagal:', err);
      toast(tr('toast.skinfail', { err: err.message }), true);
      return null;
    }
  }

  function revertSkinRepair() {
    if (state.root) ThreeAdapter.restoreSkinning(state.root);
    state.skinReport = null;
    renderSkinReport();
  }

  function renderSkinReport() {
    var rows = ['row-skin-verts', 'row-skin-fix', 'row-skin-orphan', 'row-skin-env'];
    var report = state.skinReport;
    $('skin-report-divider').style.display = report ? '' : 'none';
    rows.forEach(function (id) { $(id).style.display = report ? '' : 'none'; });
    if (!report) return;

    var totals = report.totals;
    $('st-skin-verts').textContent = totals.vertices.toLocaleString() +
      (totals.meshes > 1 ? ' ' + tr('stats.mesh', { n: totals.meshes }) : '');
    $('st-skin-fix').textContent = totals.verticesChanged.toLocaleString();
    $('st-skin-orphan').textContent = totals.influencesPruned.toLocaleString();
    $('st-skin-env').textContent = totals.weldGroups
      ? tr('stats.points', { n: totals.weldGroups.toLocaleString() })
      : tr('stats.none');
  }

  function updateSkinControls() {
    var on = $('opt-skin').checked;
    $('skin-params').style.display = on ? '' : 'none';
    $('skin-iter-wrap').style.display = on ? '' : 'none';

    var available = state.root && ThreeAdapter.hasSkinning(state.root);
    $('opt-skin').disabled = !available;
    $('skin-status').textContent = available ? '' : tr('skin.noskeleton');
  }

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
    showOverlay(tr('overlay.synth'), tr('overlay.prepare'));

    // Dikerjakan sekali di depan: ini operasi mesh, tidak ada hubungannya
    // dengan jumlah klip.
    if ($('opt-skin').checked) {
      $('overlay-sub').textContent = tr('overlay.skin');
      state.skinReport = applySkinRepair();
      renderSkinReport();
    }

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
      $('overlay-sub').textContent = tr('overlay.clip',
        { i: i + 1, n: targets.length, name: clipLabel(clip, index) });
      try {
        results[i] = ThreeAdapter.enhanceClip(clip, options);
      } catch (err) {
        console.error('Gagal memproses klip', clip.name, err);
        hideOverlay();
        toast(tr('toast.clipfail', { name: clipLabel(clip, index), err: err.message }), true);
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

      refreshButtons();
      rebindAction(true);
      renderStats();
      renderClipList();
      hideOverlay();
      toast(tr('toast.done', { n: targets.length, ms: elapsed.toFixed(0) }));
    }

    setTimeout(step, 30);
  }

  function resetEnhance() {
    clearGhost();
    revertSkinRepair();
    $('opt-ghost').checked = false;
    state.enhancedClips = null;
    state.clipStats = [];
    state.view = 'original';
    rebindAction(true);
    refreshButtons();
    renderClipList();
    clearStats();
    toast(tr('toast.reset'));
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
      if (hasAnyEnhanced()) $('st-jitter').textContent = tr('stats.pending');
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
    $('st-tracks').textContent = stats.tracksProcessed +
      (stats.tracksCopied ? ' ' + tr('stats.copied', { n: stats.tracksCopied }) : '');
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
    updateLegend();
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
   * Bayangan original
   * ================================================================== *
   * Cara paling langsung melihat apa yang berubah: putar animasi original
   * sebagai siluet tembus pandang di tempat yang sama. Di mana keduanya
   * berpisah, di situlah hasil enhance bekerja.
   */

  function clearGhost() {
    var g = state.ghost;
    if (g.mixer) g.mixer.stopAllAction();
    if (g.root) state.scene.remove(g.root);
    // PENTING: clone berbagi geometri dengan model asli, jadi jangan
    // sentuh geometry-nya. Hanya material bayangan yang memang kita buat
    // sendiri yang boleh dibuang.
    if (g.material) g.material.dispose();
    g.root = null; g.mixer = null; g.action = null; g.material = null;
  }

  function buildGhost() {
    clearGhost();

    if (!$('opt-ghost').checked || !state.root) return;
    var original = state.originalClips[state.clipIndex];
    if (!original || !enhancedFor(state.clipIndex)) return;

    if (!THREE.SkeletonUtils || typeof THREE.SkeletonUtils.clone !== 'function') {
      toast(tr('toast.ghostfail'), true);
      $('opt-ghost').checked = false;
      return;
    }

    var clone = THREE.SkeletonUtils.clone(state.root);
    var material = new THREE.MeshBasicMaterial({
      color: 0xfb7185,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    clone.traverse(function (child) {
      if (child.isMesh || child.isSkinnedMesh) {
        child.material = material;
        child.castShadow = false;
        child.receiveShadow = false;
        child.renderOrder = 2;
      }
    });

    state.scene.add(clone);
    state.ghost.root = clone;
    state.ghost.material = material;
    state.ghost.mixer = new THREE.AnimationMixer(clone);
    state.ghost.action = state.ghost.mixer.clipAction(original);
    state.ghost.action.setLoop(THREE.LoopRepeat, Infinity);
    state.ghost.action.play();

    updateGhostVisibility();
  }

  /**
   * Dalam mode Original, model utama sudah memainkan klip yang sama persis
   * dengan bayangan — menumpuknya hanya menghasilkan siluet ganda yang
   * membingungkan, jadi bayangan disembunyikan.
   */
  function updateGhostVisibility() {
    if (state.ghost.root) state.ghost.root.visible = (state.view === 'enhanced');
    updateLegend();
  }

  function updateLegend() {
    var trailOn = $('opt-trail').checked && !!enhancedFor(state.clipIndex);
    var ghostOn = !!state.ghost.root && state.ghost.root.visible;
    $('legend-trail-original').style.display = trailOn ? '' : 'none';
    $('legend-trail-enhanced').style.display = trailOn ? '' : 'none';
    $('legend-ghost').style.display = ghostOn ? '' : 'none';
    $('legend').classList.toggle('visible', trailOn || ghostOn);
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

    showOverlay(tr('overlay.glb'), tr('overlay.glbsub', { n: clips.length }));

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
        toast(tr('toast.glbsaved', { n: clips.length }));
      } else {
        // Sebagian build mengabaikan opsi binary; jangan bungkus objek JSON
        // ke dalam Blob biner — itu menghasilkan file rusak.
        download(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }),
                 state.fileName + suffix + '.gltf');
        toast(tr('toast.gltfsaved'));
      }
    };

    var onError = function (err) {
      hideOverlay();
      console.error('GLTFExporter:', err);
      toast(tr('toast.glbfail', { err: (err && err.message ? err.message : err) }), true);
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
    toast(tr('toast.jsonsaved', { name: clip.name || 'clip' }));
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

    var canGhost = !!enhancedFor(state.clipIndex);
    var ghostBox = $('opt-ghost');
    ghostBox.disabled = !canGhost;
    $('row-ghost').title = canGhost ? tr('ghost.ready') : tr('ghost.locked');
    if (!canGhost && ghostBox.checked) {
      ghostBox.checked = false;
      clearGhost();
    }

    $('btn-view-original').classList.toggle('active', state.view === 'original');
    $('btn-view-enhanced').classList.toggle('active', state.view === 'enhanced');

    if (state.view !== 'enhanced') {
      $('export-note').textContent = tr('export.original');
    } else {
      var total = state.originalClips.length;
      var done = 0;
      for (var i = 0; i < total; i++) if (enhancedFor(i)) done++;
      $('export-note').textContent = done === total
        ? tr('export.all', { n: total })
        : tr('export.partial', { n: total, k: total - done });
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
    $('btn-play').title = playing ? tr('tr.pause') : tr('tr.play');
  }

  function setView(view) {
    if (view === 'enhanced' && !state.enhancedClips) return;
    if (state.view === view) return;
    state.view = view;
    rebindAction(true);
    refreshButtons();
    renderStats();
    updateGhostVisibility();
  }

  function buildPresetButtons() {
    var grid = $('preset-grid');
    Object.keys(Fluidizer.PRESETS).forEach(function (key) {
      var p = Fluidizer.PRESETS[key];
      var btn = document.createElement('button');
      btn.className = 'preset';
      btn.dataset.preset = key;
      btn.innerHTML = '<span class="p-name" data-i18n="preset.' + key + '">' + p.label + '</span>' +
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

  /**
   * Ganti bahasa. Selain teks statis yang ditangani I18n.apply, bagian
   * yang dibangun JavaScript harus digambar ulang — daftar klip, laporan
   * statistik, catatan export, dan judul tombol tidak akan ikut berubah
   * sendiri.
   */
  function applyLanguage(lang) {
    I18n.setLang(lang);
    renderClipList();
    renderStats();
    renderSkinReport();
    refreshButtons();
    updateSkinControls();
    updateLegend();
    setPlaying(state.playing);
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
    $('btn-lang').addEventListener('click', function () { applyLanguage(I18n.other()); });

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
    $('opt-ghost').addEventListener('change', buildGhost);
    $('opt-skin').addEventListener('change', updateSkinControls);
    $('opt-envelope').addEventListener('input', function (e) {
      $('val-envelope').textContent = e.target.value + '%';
    });
    $('opt-skin-iter').addEventListener('input', function (e) {
      $('val-skin-iter').textContent = e.target.value;
    });

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
    // Kolom yang benar-benar menerima ketikan. Menolak SEMUA <input> itu
    // terlalu luas: setelah mencentang satu checkbox, fokus tetap di sana
    // dan seluruh pintasan mati sampai pengguna mengklik ke tempat lain.
    var TEXT_INPUT_TYPES = ['text', 'search', 'number', 'email', 'password', 'url', 'tel'];

    function isTypingTarget(el) {
      if (!el) return false;
      var tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return tag === 'INPUT' && TEXT_INPUT_TYPES.indexOf((el.type || '').toLowerCase()) !== -1;
    }

    window.addEventListener('keydown', function (e) {
      if (isTypingTarget(e.target)) return;
      var tag = (e.target && e.target.tagName) || '';
      if (e.code === 'Space') {
        // Space adalah cara standar mengaktifkan tombol/checkbox yang
        // sedang fokus — jangan rebut.
        if (tag === 'BUTTON' || tag === 'INPUT') return;
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
        '<div style="padding:2rem;font-family:sans-serif;color:#f1f5f9;background:#0b1120;height:100dvh">' +
        '<h2>' + tr('err.three') + '</h2><p>' + tr('err.threebody') + '</p></div>';
      return;
    }
    buildPresetButtons();
    applyPreset('balanced');
    bindEvents();
    syncAppHeight();
    // Bahasa disetel sebelum apa pun digambar, supaya tidak ada teks yang
    // sempat muncul dalam bahasa yang salah lalu berkedip berubah.
    I18n.setLang(I18n.detect());
    updateSkinControls();
    initScene();
    setPlaying(true);
    buildDemo();
  });
})();
