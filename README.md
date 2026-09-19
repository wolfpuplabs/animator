# MFS 5 — Motion Fluidity Synthesis

Enhancer kefluidan animasi 3D untuk klip **glTF / GLB**. Semangatnya seperti
upscaler frame di game — rekonstruksi sinyal, filter yang sadar gerakan,
sintesis detail, lalu pemadatan — tapi yang dinaikkan bukan piksel,
melainkan **kurva animasi**.

Jalankan `index.html` di browser. Tidak ada build step.

Butuh satu berkas saja — untuk ditempel ke CodePen, dikirim lewat chat, atau
dibuka langsung dari disk? Pakai **`standalone.html`**: CSS dan seluruh
JavaScript sudah ter-inline di dalamnya, tinggal simpan dan buka.

> **Ini bukan neural network.** Tidak ada model terlatih, tidak ada inferensi.
> Yang bekerja adalah pipeline signal-processing deterministik di atas
> keyframe. Hasilnya bisa dijelaskan, bisa diulang persis, dan berjalan
> dalam hitungan milidetik — tapi dia tidak "mengarang" gerakan baru yang
> tidak ada di data aslinya.

---

## Untuk apa

Animasi terasa patah biasanya karena beberapa hal, dan semuanya ditangani:

| Gejala | Penyebab | Yang dilakukan |
|---|---|---|
| Gerakan tersendat seperti stop-motion | Keyframe jarang, playback menginterpolasi linear | Rekonstruksi Hermite/Squad ke frame rate target |
| Getaran halus yang bikin gelisah | Jitter dari motion capture atau hand-key | Filter bilateral temporal |
| Gerakan terasa kaku, seperti robot | Tidak ada follow-through / cushion | Dinamika orde dua |
| Rotasi tiba-tiba melintir sejauh 360° | Quaternion beda hemisphere antar-key | Penyelarasan hemisphere |
| Kaki meluncur, pose hold melayang | Smoothing diterapkan rata ke seluruh kurva | Motion mask + contact lock |
| Model berisi puluhan animasi, susah dipilah | — | Panel daftar animasi dengan pencarian |
| Susah melihat apa yang berubah | — | Bayangan original, motion trail, tombol A/B |
| Deformasi jelek di setiap frame | Bobot skin rusak, envelope bergerigi | Panel Skinning & Envelope |

---

## Pipeline

```
keyframe asli
   │
   ├─ 1. Hemisphere alignment ── buang flip/pop rotasi
   ├─ 2. Reconstruct ────────── Hermite hold-aware (posisi/skala)
   │                            Squad (rotasi) → grid rapat, C1-continuous
   ├─ 3. Denoise ───────────── filter bilateral temporal
   ├─ 4. Synthesize ────────── dinamika orde dua (follow-through)
   └─ 5. Compact ───────────── decimation keyframe berbatas error
```

**1. Hemisphere alignment.** Dua quaternion `q` dan `−q` mewakili rotasi yang
sama persis, tapi interpolasi di antaranya menempuh jalan memutar. Semua key
diselaraskan lebih dulu. Penting terutama untuk file yang akan dipakai engine
lain, yang banyak di antaranya melakukan lerp mentah.

**2. Reconstruct.** Kurva di-resample ke grid seragam sesuai frame rate target.

- Posisi/skala pakai Hermite dengan tangen Catmull-Rom non-uniform, ditambah
  *limiter monotonik*: kalau dua secant di sekitar sebuah key berlawanan arah
  atau salah satunya datar, tangennya dipaksa nol. Efeknya, **pose hold tetap
  diam** dan puncak lompatan tidak melengkung keluar.
- Rotasi pakai Squad (spherical cubic), bukan slerp berantai — slerp berantai
  memutus kecepatan sudut tiap kali melewati keyframe.

**3. Denoise.** Bilateral temporal filter: bobotnya gabungan jarak waktu *dan*
selisih nilai. Getaran kecil hilang, tapi lonjakan besar (impact, snap)
bertahan. Window menciut simetris di tepi klip, atau melingkar kalau kurvanya
memang menyambung — supaya tidak ada pop di frame 0 dan di titik loop.

**4. Synthesize.** Sistem massa-pegas-peredam orde dua memberi follow-through,
cushion, dan overshoot organik. Parameter `r = 2` dipilih supaya lag pada
gerakan berkecepatan tetap tepat **nol** — animasinya tidak mundur beberapa
frame. Overshoot murni muncul saat gerakan berbelok.

**5. Compact.** Hasil 120 fps itu indah tapi boros. Key yang bisa
direkonstruksi ulang lewat interpolasi linear dalam batas error tertentu
dibuang.

### Daftar animasi

Model dari Mixamo dan sejenisnya sering membawa puluhan klip dalam satu
berkas. Panel **Animasi** menampilkan semuanya sekaligus, lengkap dengan
durasi, jumlah keyframe, dan tanda apakah klip itu sudah diproses — jadi
tidak perlu klik satu per satu untuk tahu keadaannya. Daftar di atas 8 klip
otomatis dapat kotak pencarian. Pindah klip juga bisa lewat tombol `[` dan
`]`.

Centang **Proses semua klip sekaligus** menentukan cakupan: matikan kalau
hanya ingin menyetel satu klip tanpa menunggu puluhan lainnya. Hasil klip
yang sudah diproses sebelumnya tetap disimpan, jadi bisa dikerjakan
bertahap dengan setelan berbeda per klip. Export selalu menyertakan
**semua** klip — yang belum diproses ikut sebagai versi original, supaya
tidak ada animasi yang hilang diam-diam.

### Skinning dan envelope

Menambah frame membuat gerakan lebih halus, tapi kalau bobot skin-nya
sendiri rusak, deformasinya tetap jelek di **setiap** frame — lengan
menciut waktu diputar, vertex nyangkut di tempat, batas pengaruh tulang
bergerigi. Panel **Skinning & Envelope** mengerjakan lapisan itu:

| Tahap | Yang dikerjakan |
|---|---|
| Sanitasi | Bobot negatif, NaN, indeks tulang di luar jangkauan |
| Prune | Buang pengaruh di bawah 1% yang hanya jadi derau |
| Orphan | Vertex tanpa pengaruh ditambal ke tulang **terdekat** |
| Envelope | Penghalusan Laplacian medan bobot antar-vertex bertetangga |
| Normalisasi | Jumlah bobot per vertex dikembalikan ke 1 |

Penghalusan dikerjakan pada **grup weld**, bukan per vertex. Mesh glTF
hampir selalu terbelah di jahitan UV: satu titik di permukaan bisa jadi
tiga vertex terpisah yang tidak terhubung di buffer indeks. Kalau
penghalusan jalan di atas topologi mentah, tiap sisi jahitan dihaluskan
sendiri-sendiri dan justru meninggalkan garis jahitan yang kelihatan.

Satu hal yang perlu diketahui: **GLTFLoader sudah memanggil
`normalizeSkinWeights()` saat impor**, jadi untuk berkas glTF bagian
normalisasi praktis selalu sudah beres sebelum alat ini melihatnya. Kerja
yang benar-benar terlihat di sana adalah pemangkasan pengaruh remeh dan
penghalusan envelope. Karena itu laporan menyebut "vertex diubah", bukan
"bobot dinormalisasi" — angka yang kedua akan selalu nol dan menyesatkan.

Perbaikan selalu dihitung ulang dari data asli, jadi menggeser slider lalu
menjalankan ulang tidak menghaluskan di atas yang sudah halus. Tombol
**Kembalikan ke original** memulihkan bobot apa adanya.

### Bahasa

Antarmuka tersedia dalam bahasa Indonesia dan Inggris, dialihkan lewat
tombol di pojok kanan atas. Pilihan bahasa pertama mengikuti locale
peramban, lalu diingat di `localStorage`.

### Membandingkan original dan enhanced

Perbedaan kefluidan sering halus kalau hanya dilihat sekilas, jadi ada tiga
cara melihatnya:

- **Tombol A/B** (atau tekan `C`) — bertukar antara kedua versi tanpa
  mengubah posisi waktu, jadi pose yang dibandingkan benar-benar sama.
- **Bayangan original** — animasi original diputar sebagai siluet tembus
  pandang di tempat yang sama, tersinkron per frame. Siluet itu hanya
  terlihat di bagian yang menyembul keluar dari model utama, jadi persis
  di situlah letak perbedaannya. Jeda lalu geser timeline untuk memeriksa
  frame per frame.
- **Motion trail** — jalur gerak digambar sebagai garis: merah untuk
  original, biru untuk hasil enhance. Paling jelas untuk melihat sudut
  patah yang hilang.

Keduanya yang terakhir dinyalakan lewat centang di panel Parameter, dan
baru aktif setelah klip yang sedang dipilih diproses.

### Motion mask

Tahap 3 dan 4 tidak diterapkan rata. Kecepatan lokal kurva sumber dipakai
sebagai mask: di area yang praktis diam — kaki menapak, pose hold — smoothing
dan pegas dimatikan. Tanpa ini, kaki akan meluncur dan pose hold jadi melayang.

---

## Preset

| Preset | fps | Smoothing | Follow-through | Reduction |
|---|---|---|---|---|
| Performance | 30 | 25% | 0% | 30% |
| Balanced | 60 | 45% | 20% | 12% |
| Quality | 90 | 60% | 35% | 5% |
| Ultra Fluid | 120 | 75% | 50% | 0% |

**Catatan soal keyframe reduction.** Ini trade-off langsung terhadap
kehalusan, bukan pilihan gratis. Playback menginterpolasi linear di antara
key, jadi setiap key yang dibuang mengembalikan sedikit "sudut" ke kurva.
Pada klip uji, menaikkan reduction dari 0 ke 18% memangkas perolehan
kehalusan dari 46% menjadi 26%. Preset sengaja dijaga rendah; naikkan hanya
kalau ukuran file jadi masalah.

---

## Membaca laporan

- **Jitter** — angka utama. Diukur **setelah** keyframe reduction dan
  **setelah** follow-through, memakai interpolasi linear seperti yang
  dilakukan player saat runtime. Jadi ini benar-benar yang akan terlihat,
  bukan angka ideal di atas kertas.
- **↳ kurva mentah** — muncul kalau berbeda jauh: kualitas kurva sebelum
  dipadatkan dan sebelum overshoot ditambahkan. Kalau angka utama lebih
  rendah, selisihnya adalah harga dari reduction dan overshoot.

Metriknya adalah RMS percepatan dibagi RMS kecepatan, bebas skala. RMS,
bukan L1: kurva patah dan kurva mulus yang melewati titik yang sama punya
total variasi kecepatan yang mirip, jadi L1 hampir tidak bisa membedakannya.

Pada kurva yang sudah mulus sempurna, angkanya mendekati nol — alat ini
tidak memperbaiki apa yang tidak rusak, dan tidak merusaknya juga.

---

## Struktur

```
index.html                  markup + skrip
css/style.css               tampilan
js/fluidizer.js             engine animasi (JS murni, tanpa dependensi, bisa dipakai di node)
js/skinfix.js               perbaikan bobot skin & envelope (juga tanpa dependensi)
js/i18n.js                  kamus dan pengalih bahasa
js/three-adapter.js         jembatan THREE.AnimationClip ↔ engine
js/app.js                   viewer, kontrol, export
standalone.html             hasil rakitan satu berkas (jangan diedit langsung)
tools/build-standalone.js   perakitnya
tests/fluidizer.test.js     unit test engine animasi
tests/skinfix.test.js       unit test perbaikan skin
tests/standalone.test.js    penjaga sinkronisasi berkas rakitan
tests/browser/              test end-to-end di browser sungguhan
```

`standalone.html` dihasilkan dari sumber di atas, jadi **jangan diedit
langsung** — ubah sumbernya lalu jalankan `npm run build`. Salah satu unit
test akan gagal kalau berkas rakitan itu tertinggal dari sumbernya, supaya
versi basi tidak beredar diam-diam.

Engine sengaja tidak tahu apa-apa soal three.js, jadi bisa dipakai di
pipeline lain:

```js
const Fluidizer = require('./js/fluidizer.js');

const hasil = Fluidizer.enhance({
  duration: 2.0,
  tracks: [{ name: 'Hips.quaternion', type: 'quaternion', times, values }]
}, { preset: 'quality' });

console.log(hasil.stats.smoothnessGain); // mis. 0.51
```

Tipe track yang didukung: `vector`, `quaternion`, `number` (termasuk morph
target dengan stride > 1), `color`. Track `bool` dan `string` disalin apa
adanya karena tidak punya "kehalusan".

---

## Test

```bash
npm install          # hanya untuk test browser
npm test             # unit test engine + penjaga berkas rakitan
npm run build        # rakit ulang standalone.html
npm run test:browser # end-to-end di Chromium
npm run test:all
```

Test browser menyalin halaman ke direktori sementara dan mengarahkan tag
`<script>`-nya ke three.js dari `node_modules`, jadi tidak bergantung pada
jaringan. Kalau sudah punya Chromium sendiri, set `CHROMIUM_PATH`.

`tests/browser/rigged.test.js` membuat rig skinned sungguhan, mengekspornya
jadi GLB, memuatnya lewat file input aplikasi, meng-enhance, mengekspor
ulang, lalu memuat hasilnya kembali — memastikan skin dan hierarki bone
selamat melewati seluruh perjalanan.

`tests/browser/framing.test.js` memuat rig yang bone-nya membawa vertex
keluar dari kotak bind pose, lalu mengukur dari piksel yang benar-benar
dirender: model harus utuh, berada di tengah saat pertama muncul, dan
mengisi frame dengan proporsi wajar.

Ambangnya sengaja ketat, dan itu bukan kehati-hatian berlebihan. Dengan bug
bounding box yang lama model mengisi 96% tinggi frame alih-alih 42%; dengan
kamera yang membidik pusat lintasan, pose awal mendarat di 0,37/0,62 alih-
alih 0,50/0,50. Kedua keadaan itu lolos ambang longgar yang dipakai versi
pertama test ini.

Jaraknya tidak dipercaya dari rumus saja. Setelah kamera ditempatkan,
delapan sudut kotak pose awal diproyeksikan ke layar dan jaraknya
dikoreksi sampai semuanya masuk dengan margin yang wajar — rumus yang
mengandaikan model muat dalam satu bola bisa meleset untuk bentuk panjang
seperti rentang sayap.

`framing.test.js` dan `layout.test.js` keduanya berjalan di device pixel
ratio 1, 2, dan 3. Ini bukan tambahan hiasan: kanvas yang ukurannya salah
di dpr tinggi memindahkan model ke pojok kanan bawah dan mendorong bar
kontrol keluar layar, tanpa mengubah apa pun di dpr 1 — seluruh suite
lolos sementara perangkat sungguhan rusak.

`tests/browser/compare.test.js` membandingkan screenshot untuk memastikan
tombol A/B benar-benar mengubah pose yang dirender, bayangan original
sungguh tergambar dan tetap sinkron saat di-scrub, bukan sekadar ada
tombolnya.

`tests/browser/multiclip.test.js` memakai model berisi banyak animasi dan
memeriksa hal-hal yang gampang rusak diam-diam: statistik per-klip tidak
tertukar, memproses satu klip tidak membatalkan hasil klip lain, dan
export tidak kehilangan animasi yang belum diproses.

`tests/browser/skin.test.js` memuat rig yang bobotnya sengaja dirusak,
lalu membaca accessor `WEIGHTS_0` langsung dari berkas GLB hasil export —
bukan dari angka di layar — untuk memastikan perbaikannya benar-benar ikut
ke berkas, tidak menumpuk saat dijalankan dua kali, dan pulih persis
setelah reset.

`tests/browser/i18n.test.js` memindai seluruh antarmuka untuk sisa kata
Indonesia setelah beralih ke Inggris. Pemindaiannya tidak peduli huruf
besar-kecil: `innerText` mengembalikan teks setelah `text-transform`, jadi
judul seksi yang di-CSS jadi huruf besar akan lolos dari pemindai yang
case-sensitive.

`tests/browser/layout.test.js` memuat halaman di delapan ukuran layar dan
memastikan transport bar tidak pernah terdorong keluar layar dan kanvas
tidak pernah mengecil jadi nol. Kondisi toolbar browser tidak bisa ditiru
di headless — `dvh` dan `vh` bernilai sama di sana — jadi pemakaian `dvh`
diperiksa langsung di berkas CSS-nya.

`tests/browser/standalone.test.js` menjalankan `standalone.html` sendiri,
bukan cuma memeriksa isinya — berkas itulah yang paling mungkin dipakai
orang apa adanya.

---

## Batasan yang diketahui

- **`.gltf` dengan file terpisah tidak bisa dimuat.** Berkas dibaca lewat
  object URL, jadi referensi ke `.bin` dan tekstur di sebelahnya tidak
  ter-resolve. Pakai `.glb`.
- **Ukuran kanvas disetel eksplisit, bukan diserahkan ke atribut.**
  `renderer.setSize(w, h)` harus dibiarkan memperbarui gaya CSS kanvas.
  Dengan argumen ketiga `false`, three hanya menyetel atribut
  width/height ke ukuran buffer gambar — di layar dpr 2 elemen kanvasnya
  jadi dua kali lebih besar dari wadahnya. Ada aturan CSS sebagai
  pengaman kedua.
- **Tinggi app digerakkan JavaScript.** `--app-height` diisi dari
  `visualViewport`, karena sebagian browser ponsel dan tablet melaporkan
  satuan viewport CSS lebih besar dari area yang benar-benar terlihat.
  Nilainya jatuh ke `100dvh` lalu `100vh` kalau skrip gagal jalan.
- **Framing membidik pose awal, bukan pusat lintasan.** Kamera diarahkan
  ke pusat pose di frame 0 supaya model terlihat di tengah saat pertama
  muncul, sementara jaraknya dihitung agar seluruh lintasan gerak tetap
  muat. Untuk animasi dengan perpindahan sangat jauh, mundurnya kamera
  dibatasi 2,5× ukuran model — lewat dari itu modelnya sendiri jadi
  terlalu kecil untuk dinilai, dan sebagian lintasan dibiarkan keluar
  frame.
- **Framing kamera memakai vertex contoh.** Untuk skinned mesh, posisi
  vertex dihitung lewat `boneTransform` di 16 titik waktu — `Box3.setFromObject`
  tidak bisa dipakai karena hanya melihat bind pose dan bisa meleset
  berkali lipat. Vertexnya disubsample (maksimum 512 per mesh) agar tetap
  cepat, jadi titik terjauh bisa terlewat sedikit; kotaknya dilonggarkan 2%
  untuk menutupi itu.
- **Alat ini tidak mengarang gerakan.** Kalau gerakan aslinya secara
  fundamental salah — timing meleset, pose tidak terbaca — ini tidak akan
  memperbaikinya. Yang dikerjakan adalah kefluidan, bukan penyutradaraan.
- **Tinggi app memakai `dvh`.** Browser lama yang belum mengenalnya jatuh
  ke `100vh`, dan di sana bagian bawah halaman bisa tertutup toolbar
  browser pada ponsel/tablet.
- **Perbaikan skin bekerja pada topologi, bukan pada makna anatomi.**
  Penghalusan envelope tidak tahu mana siku dan mana lutut; ia hanya
  melandaikan medan bobot. Untuk rig yang envelope-nya memang sengaja
  tajam, turunkan atau matikan penghalusannya.
- **Pemrosesan di main thread.** Klip dikerjakan satu per satu lewat
  `setTimeout` supaya UI tidak membeku, tapi rig sangat besar dengan frame
  rate tinggi tetap akan terasa jeda. Web Worker adalah langkah berikutnya
  yang masuk akal.
- Dimuat dari CDN: three.js r128 (dipatok, karena build `examples/js`
  non-module tidak ada lagi di versi baru).
