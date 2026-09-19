/*
 * i18n.js — pengalih bahasa Indonesia / Inggris.
 *
 * Teks bawaan di index.html tetap berbahasa Indonesia supaya halaman
 * masih terbaca kalau skrip gagal dimuat; kamus di bawah yang mengganti
 * isinya saat bahasa diubah.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.I18n = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'mfs.lang';

  var DICT = {
    id: {
      'hint': 'Space = play/pause · C = bandingkan A/B · [ ] = ganti animasi',
      'lang.switch': 'English',
      'lang.title': 'Ganti bahasa',

      'sec.source': 'Sumber Animasi',
      'drop.label': 'Taruh file .GLB / .GLTF',
      'drop.sub': 'atau klik untuk pilih file',
      'btn.demo': '🎮 Muat Demo (animasi sengaja patah)',

      'sec.clips': 'Animasi',
      'clip.filter': 'Cari animasi…',
      'clip.empty': 'Tidak ada yang cocok.',
      'clip.all': 'Proses semua klip sekaligus',
      'clip.count': '{n} klip',
      'clip.count.one': '1 klip',
      'clip.done': '{n} diproses',
      'clip.key': 'key',
      'clip.unnamed': 'Clip {n}',
      'clip.enhanced': 'Sudah di-enhance',
      'clip.pending': 'Belum diproses',

      'sec.quality': 'Mode Kualitas',
      'preset.performance': 'Performance',
      'preset.balanced': 'Balanced',
      'preset.quality': 'Quality',
      'preset.ultra': 'Ultra Fluid',

      'sec.params': 'Parameter',
      'opt.fps': 'Target frame rate',
      'note.fps': 'Kerapatan sample hasil rekonstruksi kurva.',
      'opt.smooth': 'Smoothing',
      'note.smooth': 'Filter bilateral: buang jitter, pertahankan snap.',
      'opt.follow': 'Follow-through',
      'note.follow': 'Overshoot & cushion organik lewat dinamika orde dua.',
      'opt.contact': 'Contact lock',
      'note.contact': 'Jaga pose hold & kontak kaki supaya tidak meluncur.',
      'opt.reduce': 'Keyframe reduction',
      'note.reduce': 'Menukar kehalusan dengan ukuran file. Naikkan hanya kalau file terlalu besar.',
      'opt.loop': 'Klip looping (pre-roll pegas)',
      'opt.trail': 'Tampilkan motion trail',
      'opt.ghost': 'Bayangan original (tumpuk)',
      'ghost.ready': 'Tumpuk animasi original sebagai siluet tembus pandang',
      'ghost.locked': 'Jalankan enhance pada klip ini dulu',

      'sec.skin': 'Skinning & Envelope',
      'opt.skin': 'Perbaiki bobot skin',
      'note.skin': 'Bekerja pada mesh, bukan pada frame: buang pengaruh remeh, haluskan batas envelope, normalisasi ulang. Berkas glTF sudah dinormalisasi saat impor, jadi kerja yang terlihat di sini adalah pemangkasan dan envelope.',
      'opt.envelope': 'Haluskan envelope',
      'note.envelope': 'Melandaikan batas pengaruh antar-tulang yang bergerigi.',
      'opt.skiniter': 'Iterasi',
      'skin.noskeleton': 'model tanpa skeleton',

      'btn.run': '⚡ Enhance Animation',
      'btn.reset': 'Kembalikan ke original',

      'sec.export': 'Export',
      'btn.glb': '💾 Export .GLB',
      'btn.json': '📄 Export klip aktif (.JSON)',
      'export.original': 'Export memakai klip ORIGINAL. Jalankan enhance dulu untuk hasil halus.',
      'export.all': 'Export memakai klip HASIL ENHANCE (semua {n} klip ikut).',
      'export.partial': 'Export ikut semua {n} klip; {k} di antaranya masih versi original karena belum diproses.',

      'view.original': 'Original',
      'view.enhanced': 'Enhanced',

      'stats.title': 'Laporan Sintesis',
      'stats.jitter': 'Jitter',
      'stats.recon': '↳ kurva mentah',
      'stats.fps': 'Sample rate',
      'stats.keys': 'Keyframe',
      'stats.tracks': 'Track diproses',
      'stats.flips': 'Rotasi flip diperbaiki',
      'stats.weight': 'Bobot kurva',
      'stats.time': 'Waktu proses',
      'stats.skinverts': 'Vertex diperiksa',
      'stats.skinchanged': 'Vertex diubah',
      'stats.skinpruned': 'Pengaruh remeh dibuang',
      'stats.skinenv': 'Envelope dihaluskan',
      'stats.pending': 'belum diproses',
      'stats.copied': '(+{n} disalin)',
      'stats.mesh': '({n} mesh)',
      'stats.points': '{n} titik',
      'stats.none': 'tidak',

      'legend.trailOriginal': 'Jalur original',
      'legend.trailEnhanced': 'Jalur enhanced',
      'legend.ghost': 'Bayangan = original',

      'overlay.loading': 'Memuat model 3D…',
      'overlay.synth': 'Mensintesis gerakan…',
      'overlay.prepare': 'Menyiapkan',
      'overlay.skin': 'Memperbaiki bobot skin…',
      'overlay.clip': 'Klip {i}/{n} — {name}',
      'overlay.glb': 'Menyiapkan GLB…',
      'overlay.glbsub': '{n} klip animasi',
      'overlay.glbsub.one': '1 klip animasi',

      'tr.play': 'Play (Space)',
      'tr.pause': 'Pause (Space)',
      'tr.stop': 'Kembali ke awal',
      'tr.speed': 'Kecepatan playback',

      'toast.loaded': 'Dimuat: {name}',
      'toast.noanim': 'Model dimuat, tapi tidak ada klip animasi di dalamnya.',
      'toast.loadfail': 'Gagal membaca file. Untuk .gltf dengan file terpisah, pakai .glb.',
      'toast.done': '{n} klip selesai dalam {ms} ms — tekan C untuk bandingkan A/B.',
      'toast.done.one': '1 klip selesai dalam {ms} ms — tekan C untuk bandingkan A/B.',
      'toast.reset': 'Kembali ke animasi original.',
      'toast.clipfail': 'Gagal memproses klip "{name}": {err}',
      'toast.skinfail': 'Perbaikan skinning gagal: {err}',
      'toast.glbsaved': 'GLB tersimpan ({n} klip).',
      'toast.glbsaved.one': 'GLB tersimpan (1 klip).',
      'toast.gltfsaved': 'Eksporter mengembalikan glTF JSON, disimpan sebagai .gltf.',
      'toast.glbfail': 'Gagal mengekspor GLB: {err}',
      'toast.jsonsaved': 'Klip "{name}" tersimpan sebagai JSON.',
      'toast.ghostfail': 'Bayangan butuh SkeletonUtils, yang gagal dimuat dari CDN.',
      'demo.name': 'Demo Hopper (8 fps stepped)',
      'err.three': 'three.js gagal dimuat',
      'err.threebody': 'Halaman ini mengambil three.js dari CDN. Periksa koneksi internet lalu muat ulang.'
    },

    en: {
      'hint': 'Space = play/pause · C = A/B compare · [ ] = switch clip',
      'lang.switch': 'Indonesia',
      'lang.title': 'Switch language',

      'sec.source': 'Animation Source',
      'drop.label': 'Drop a .GLB / .GLTF file',
      'drop.sub': 'or click to browse',
      'btn.demo': '🎮 Load demo (deliberately choppy)',

      'sec.clips': 'Animations',
      'clip.filter': 'Search animations…',
      'clip.empty': 'Nothing matches.',
      'clip.all': 'Process all clips at once',
      'clip.count': '{n} clips',
      'clip.count.one': '1 clip',
      'clip.done': '{n} processed',
      'clip.key': 'keys',
      'clip.unnamed': 'Clip {n}',
      'clip.enhanced': 'Enhanced',
      'clip.pending': 'Not processed yet',

      'sec.quality': 'Quality Mode',
      'preset.performance': 'Performance',
      'preset.balanced': 'Balanced',
      'preset.quality': 'Quality',
      'preset.ultra': 'Ultra Fluid',

      'sec.params': 'Parameters',
      'opt.fps': 'Target frame rate',
      'note.fps': 'Sample density of the reconstructed curve.',
      'opt.smooth': 'Smoothing',
      'note.smooth': 'Bilateral filter: removes jitter, keeps snap.',
      'opt.follow': 'Follow-through',
      'note.follow': 'Organic overshoot & cushion via second-order dynamics.',
      'opt.contact': 'Contact lock',
      'note.contact': 'Keeps holds and foot contacts from sliding.',
      'opt.reduce': 'Keyframe reduction',
      'note.reduce': 'Trades smoothness for file size. Raise it only if the file gets too big.',
      'opt.loop': 'Looping clip (spring pre-roll)',
      'opt.trail': 'Show motion trail',
      'opt.ghost': 'Original ghost (overlay)',
      'ghost.ready': 'Overlay the original animation as a translucent silhouette',
      'ghost.locked': 'Enhance this clip first',

      'sec.skin': 'Skinning & Envelope',
      'opt.skin': 'Repair skin weights',
      'note.skin': 'Works on the mesh, not the frames: drops negligible influences, smooths envelope boundaries, renormalizes. glTF files are already normalized on import, so what you see here is the pruning and the envelope work.',
      'opt.envelope': 'Smooth envelope',
      'note.envelope': 'Softens jagged influence boundaries between bones.',
      'opt.skiniter': 'Iterations',
      'skin.noskeleton': 'model has no skeleton',

      'btn.run': '⚡ Enhance Animation',
      'btn.reset': 'Back to original',

      'sec.export': 'Export',
      'btn.glb': '💾 Export .GLB',
      'btn.json': '📄 Export active clip (.JSON)',
      'export.original': 'Export uses the ORIGINAL clips. Run enhance first for smooth output.',
      'export.all': 'Export uses the ENHANCED clips (all {n} included).',
      'export.partial': 'Export includes all {n} clips; {k} of them are still the original because they have not been processed.',

      'view.original': 'Original',
      'view.enhanced': 'Enhanced',

      'stats.title': 'Synthesis Report',
      'stats.jitter': 'Jitter',
      'stats.recon': '↳ raw curve',
      'stats.fps': 'Sample rate',
      'stats.keys': 'Keyframes',
      'stats.tracks': 'Tracks processed',
      'stats.flips': 'Rotation flips fixed',
      'stats.weight': 'Curve weight',
      'stats.time': 'Processing time',
      'stats.skinverts': 'Vertices inspected',
      'stats.skinchanged': 'Vertices changed',
      'stats.skinpruned': 'Negligible influences dropped',
      'stats.skinenv': 'Envelope smoothed',
      'stats.pending': 'not processed',
      'stats.copied': '(+{n} copied)',
      'stats.mesh': '({n} meshes)',
      'stats.points': '{n} points',
      'stats.none': 'no',

      'legend.trailOriginal': 'Original path',
      'legend.trailEnhanced': 'Enhanced path',
      'legend.ghost': 'Ghost = original',

      'overlay.loading': 'Loading 3D model…',
      'overlay.synth': 'Synthesizing motion…',
      'overlay.prepare': 'Preparing',
      'overlay.skin': 'Repairing skin weights…',
      'overlay.clip': 'Clip {i}/{n} — {name}',
      'overlay.glb': 'Preparing GLB…',
      'overlay.glbsub': '{n} animation clips',
      'overlay.glbsub.one': '1 animation clip',

      'tr.play': 'Play (Space)',
      'tr.pause': 'Pause (Space)',
      'tr.stop': 'Back to start',
      'tr.speed': 'Playback speed',

      'toast.loaded': 'Loaded: {name}',
      'toast.noanim': 'Model loaded, but it contains no animation clips.',
      'toast.loadfail': 'Could not read the file. For .gltf with separate files, use .glb instead.',
      'toast.done': '{n} clips done in {ms} ms — press C to compare A/B.',
      'toast.done.one': '1 clip done in {ms} ms — press C to compare A/B.',
      'toast.reset': 'Back to the original animation.',
      'toast.clipfail': 'Failed to process clip "{name}": {err}',
      'toast.skinfail': 'Skin repair failed: {err}',
      'toast.glbsaved': 'GLB saved ({n} clips).',
      'toast.glbsaved.one': 'GLB saved (1 clip).',
      'toast.gltfsaved': 'The exporter returned glTF JSON, saved as .gltf.',
      'toast.glbfail': 'GLB export failed: {err}',
      'toast.jsonsaved': 'Clip "{name}" saved as JSON.',
      'toast.ghostfail': 'The ghost needs SkeletonUtils, which failed to load from the CDN.',
      'demo.name': 'Demo Hopper (8 fps stepped)',
      'err.three': 'three.js failed to load',
      'err.threebody': 'This page pulls three.js from a CDN. Check your connection and reload.'
    }
  };

  var current = 'id';

  function detect() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (err) { stored = null; }
    if (stored && DICT[stored]) return stored;
    var nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '';
    return /^id\b/i.test(nav) ? 'id' : 'en';
  }

  /**
   * Bentuk tunggal dipilih lewat kunci bersufiks `.one` kalau ada.
   * Bahasa Inggris menandai jamak, bahasa Indonesia tidak — tanpa ini
   * antarmuka Inggris menulis "1 clips done".
   */
  function t(key, params) {
    var table = DICT[current] || DICT.id;
    if (params && Number(params.n) === 1 && table[key + '.one'] !== undefined) {
      key = key + '.one';
    }
    var text = table[key];
    if (text === undefined) text = (DICT.id[key] !== undefined ? DICT.id[key] : key);
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return params[name] !== undefined ? params[name] : match;
    });
  }

  /** Terapkan kamus ke seluruh elemen ber-atribut data-i18n. */
  function apply(scope) {
    var host = scope || (typeof document !== 'undefined' ? document : null);
    if (!host) return;

    host.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    host.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    host.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    host.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = current;
    }
  }

  function setLang(lang) {
    if (!DICT[lang]) return current;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (err) { /* mode privat */ }
    apply();
    return current;
  }

  function getLang() { return current; }
  function other() { return current === 'id' ? 'en' : 'id'; }
  function keys(lang) { return Object.keys(DICT[lang] || {}); }

  return {
    t: t, apply: apply, setLang: setLang, getLang: getLang,
    other: other, detect: detect, keys: keys, DICT: DICT
  };
});
