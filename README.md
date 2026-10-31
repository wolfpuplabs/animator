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
| Hasil mocap harus dikonversi dulu | Perkakas mocap mengekspor FBX | Muat .FBX langsung |
| Tidak punya perkakas mocap | — | Tangkap dari video di peramban |

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

### Tangkap dari video

Video bisa dijadikan animasi langsung di peramban. Deteksi pose berjalan
lokal lewat WebAssembly (MediaPipe Pose Landmarker) — videonya tidak
dikirim ke mana pun.

```
video → deteksi pose → rig beranimasi → engine MFS 5 → GLB
```

**Hasilnya kasar, dan itu melekat pada metodenya.** Deteksi pose memberi
POSISI sendi, bukan rotasi tulang. Rotasi di sini disimpulkan dengan
mengarahkan tiap tulang ke sendi anaknya, dan putaran sumbu panjangnya
ditebak dari sumbu bahu atau pinggul. Siku yang terpelintir dan
pergelangan yang berputar tidak akan terekam benar. Ini alat previz.

Perbandingan jujur dengan mocap sungguhan:

| | RGB MoCap | Deteksi di peramban |
|---|---|---|
| Keluaran | Mesh SMPL-X penuh + jari | 33 titik sendi |
| Rotasi tulang | Ya | Disimpulkan dari posisi |
| Jalan di | Windows + GPU, ~45 GB | Peramban mana saja |
| Cocok untuk | Produksi | Previz, referensi |

Yang keluar dari deteksi justru goyang dan berderau — persis yang engine
di sini dibuat untuk bereskan, jadi keduanya nyambung secara alami.

Beberapa catatan praktis: satu orang saja di frame, seluruh badan
terlihat, dan hindari potongan kamera.

#### Titik sendi dibereskan sebelum jadi rotasi

`js/poserefine.js` duduk di antara deteksi dan pembuatan rotasi.
Urutannya bukan selera: rotasi disimpulkan dengan mengarahkan tulang ke
sendi anaknya, jadi kesalahan posisi sendi masuk langsung jadi kesalahan
rotasi — dan kesalahan di pangkal rantai ikut memutar seluruh anggota
badan di bawahnya. Membereskan setelah jadi rotasi berarti membereskan
kesalahan yang sudah menyebar.

Dua tahap:

**Isi celah.** Sendi yang hilang sebentar diinterpolasi dari frame
terbaca terdekat di kedua sisinya, bukan ditahan. Batasnya waktu, bukan
jumlah frame — 0,4 detik — karena sepuluh frame berarti hal yang sangat
berbeda pada 12 fps dan pada 30 fps. Celah lebih panjang dari itu
dibiarkan: menjembataninya berhenti jadi penafsiran dan mulai jadi
karangan.

**Haluskan.** Pencocokan kuadratik berbobot (Savitzky-Golay), bobotnya
keyakinan deteksi, lebar jendela 0,29 detik. Kuadratik, bukan rata-rata
bergerak, supaya puncak gerakan tidak terpangkas: pada 24 fps jendela
ini masih menyimpan 97% amplitudo gerakan 2 Hz dan 87% gerakan 3 Hz —
kira-kira secepat lambaian tangan. Hasilnya dikurung ke rentang
sampelnya supaya ringing kuadratik tidak lolos di sendi yang berhenti
mendadak.

Diukur pada video salat 240 frame, dibandingkan tanpa pembenahan:

| | mentah | dibereskan |
|---|---|---|
| sentakan rata-rata | 2,39°/frame | **1,76°/frame** |
| frame menyentak >20° | 52 | **18** |
| sendi ditahan | 428 | 407 |
| tulang yang membaik | — | 14 dari 15 |

Tidak ada tulang yang jadi lebih menyentak.

#### Tahap ketiga yang dibuang, dan kenapa itu penting

Pernah ada tahap ketiga: memaksa panjang tiap tulang ke median seluruh
frame. Alasannya kuat — tulang orang tidak memanjang-memendek, jadi
setiap selisih panjang adalah murni kesalahan — dan koreksinya dibebankan
ke z karena kedalaman yang paling buruk ditebak.

Diukur terhadap kebenaran acuan buatan, tahap itu tampak yang paling
berguna dari ketiganya: error posisi sendi turun dari 12,1 mm jadi
10,7 mm. Diukur pada keluaran MediaPipe sungguhan, dia **menaikkan**
sentakan dari 1,78° jadi 4,42° per frame dan melipattigakan jumlah frame
yang menyentak. Tidak ada setelan yang menyelamatkannya; dibatasi sampai
2 persen panjang tulang pun masih lebih buruk daripada tidak dipakai.
Dibuang.

Sebabnya ada di model derau, bukan di aljabarnya. Test buatan memberi
tiap sendi derau kecil yang berdiri sendiri-sendiri. Kesalahan MediaPipe
tidak begitu — dia **terstruktur**: anggota badan yang terjepit
menghadap kamera diringkusnya jadi sepertiga panjangnya, utuh dan
konsisten dengan dirinya sendiri. Kendala panjang tulang menyerang
persis jenis kesalahan yang tidak dibuat MediaPipe, sambil mengarang
jenis yang dibuatnya.

Pelajarannya bukan soal tulang, tapi soal cara mengukur: benchmark
buatan tahu arah kebenarannya, tapi cuma data sungguhan yang tahu
bentuk kesalahannya. Karena itu 70 frame keluaran detektor yang nyata
ikut disimpan di `tests/fixtures/` sebagai penjaga tetap — lihat
`tests/fixtures/README.md`. Sebaran panjang tulang sendiri tetap
**diukur dan dilaporkan** di tooltip status, cuma tidak dikoreksi:
angkanya diagnosis yang bagus soal seberapa payah detektornya di satu
video — di bawah 1% pada klip mudah, sekitar 10% saat sujud.

#### Kalau sosoknya keluar tapi diam

Tiga sebab yang gampang tertukar.

**Skinning tidak menyala.** Ini bug yang sempat ada dan paling
menyesatkan dari semuanya. Waktu itu three masih r128, yang cuma
menerapkan skinning kalau `material.skinning` true (`WebGLRenderer`:
`object.isSkinnedMesh && material.skinning`), dan defaultnya false.
Sejak r130 skinning berjalan otomatis, jadi kelas bug ini hilang
bersama pemutakhiran three — tapi ceritanya disimpan karena pola
gagalnya layak dikenali. `GLTFLoader` menyalakannya
sendiri, jadi model yang diunggah beranimasi normal — material yang
dibuat tangan di `posepipeline.js` tidak. Akibatnya tulang berputar,
klipnya penuh, GLB-nya benar dan ikut beranimasi di Blender, tapi mesh
di layar membeku di bind pose. Semua asersi yang ada waktu itu tetap
lulus; yang menangkapnya cuma membandingkan piksel yang benar-benar
dirender pada dua waktu klip berbeda. Diukur pada video sungguhan:
tanpa `material.skinning` beda pikselnya 0,69 / 0,00 / 0,00; dengan,
5,31 / 6,14 / 7,34.

Dua sebab lain, yang dulu sama-sama memberi pesan menyesatkan:

**Videonya tidak bisa didekode peramban.** Berkas dengan codec yang tidak
didukung — HEVC di `.mov` dari iPhone/iPad adalah kasus paling umum —
tetap memicu `loadeddata` dan melaporkan durasi yang benar, tapi
`videoWidth`-nya nol. Deteksi lalu jalan di atas frame kosong dan
melaporkan "tidak ada orang terdeteksi", padahal isinya tidak pernah
sampai ke detektor. Sekarang ukuran gambarnya diperiksa lebih dulu dan
pesannya menyebut format. Jalan keluarnya: ekspor ulang jadi MP4 (H.264)
atau WebM.

**Orangnya memang nyaris tidak bergerak.** Klipnya sah — panjangnya
benar, keyframe-nya penuh — tapi rotasinya konstan, jadi yang muncul
patung. Itu tidak bisa dibedakan dari kegagalan hanya dengan melihat,
jadi `stats.motionRange` mengukur simpangan rotasi terbesar di seluruh
tulang; di bawah 8° aplikasi mengatakannya terus terang alih-alih
menyerahkan sosok diam tanpa penjelasan.

### Avatar contoh bawaan

Contoh bawaannya avatar manusia ber-rig, dibangun dari kode — bukan
dimuat dari berkas. Alasannya dua: tidak ada aset yang lisensinya harus
ikut dipikirkan, dan `standalone.html` tetap satu berkas.

Yang penting bukan tampilannya, tapi bahwa dia **rig sungguhan**: 21
tulang, 15 di antaranya bernama kanonik sehingga langsung dikenali
retarget, dan bobot skin-nya membaur di sambungan supaya sikut dan lutut
menekuk, bukan terlipat seperti sedotan. Jadi tangkapan video bisa
dijatuhkan ke atasnya tanpa menyiapkan model apa pun lebih dulu.

Tulang hiasan — `Neck`, `Head`, `LeftShoulder`, `RightShoulder`,
`LeftToe`, `RightToe` — sengaja TIDAK dikenali retarget. Deteksi pose
tidak memberi data yang bisa dipercaya untuk bagian itu, jadi lebih baik
dibiarkan di pose rest daripada digerakkan oleh tebakan.

Penampang tulangnya elips (`rx`/`rz`), bukan lingkaran. Satu angka
radius untuk semuanya membuat sosoknya jadi rangkaian pipa; torso
manusia lebar dan pipih, telapak tangan lebih pipih lagi.

Klipnya tetap **sengaja patah** — 8 fps, berjitter, dengan dua frame
yang quaternion-nya dibalik tandanya. Itu memang gunanya contoh bawaan:
memberi engine sesuatu untuk dibereskan, bukan memamerkan animasi yang
sudah bagus.

### Memindahkan tangkapan ke model sendiri

Video yang dijatuhkan TIDAK menggantikan model yang sedang dimuat:
gerakannya dipindahkan ke rig model itu, dan klip tangkapan ditambahkan
di samping klip bawaannya. Ini berlaku untuk model yang diunggah maupun
untuk avatar contoh bawaan — yang terakhir itu cara tercepat mencobanya.
Sosok batang tinggal cadangan untuk saat rig-nya tidak bisa dicocokkan.

Yang membuat ini mungkin: `posemocap.js` tidak menyimpan orientasi tulang
apa adanya, melainkan SIMPANGANNYA DARI POSE REST. Orientasi mentah
terikat pada proporsi dan sumbu rig asalnya; simpangan dari rest
("putar lengan 40° dari posisi diamnya") berlaku di rig mana pun yang
pose rest-nya sebanding.

```
D_sumber = orientasi dunia relatif rest, diakumulasi dari track lokal
W_target = D_sumber · R_rest_target
lokal    = W_induk⁻¹ · W_target
```

Pose rest target dibaca dari `skeleton.boneInverses`, bukan dari pose
tulang saat itu — kalau tidak, klip yang kebetulan sedang diputar ikut
terbaca sebagai pose rest dan seluruh hasilnya miring.

Nama tulang dicocokkan otomatis. Nama dipecah jadi token (termasuk batas
camelCase), token penanda perkakas dibuang (`mixamorig`, `Bip01`, `J_Bip`,
`DEF`, `ORG`), penanda sisi dipisahkan (`L`/`R`/`Left`/`Right`), lalu
sisanya dicocokkan ke 15 tulang dasar. Jadi `mixamorig:LeftArm`,
`J_Bip_L_UpperArm`, `upper_arm.L`, dan `Bip01_L_UpperArm` semuanya
mengarah ke tulang yang sama. Tulang jari seperti `LeftHandIndex1`
sengaja TIDAK dicocokkan: salah cocok jauh lebih merusak daripada tidak
cocok — jari yang terbaca sebagai telapak tangan akan memuntir seluruh
lengan.

Perpindahan pinggul diskalakan dengan rasio panjang tungkai target
terhadap sumber, supaya karakter kecil tidak melayang dan yang besar
tidak terseret.

Dua batas yang perlu diketahui. Pertama, hasilnya mewarisi semua
keterbatasan deteksi pose di atas — twist tetap tebakan. Kedua, rig yang
pose rest-nya jauh berbeda (A-pose ekstrem, atau sumbu hadap berbeda)
akan meleset, karena yang dipindahkan simpangan dari rest, bukan pose
absolut.

### Alur dari motion capture

Berkas FBX bisa dimuat langsung, jadi hasil perkakas motion capture bisa
masuk ke sini tanpa dikonversi lebih dulu. Contohnya
[RGB MoCap](https://github.com/toyxyz/toyxyz_RGBMocap), yang mengubah
video jadi animasi humanoid dan mengekspornya sebagai FBX:

```
video → RGB MoCap (Windows, GPU) → FBX → MFS 5 → GLB
```

Keduanya saling melengkapi, bukan tumpang tindih. RGB MoCap mengerjakan
rekonstruksi 3D dari video dan retargeting ke karakter. Yang tersisa pada
hasil mocap justru yang ditangani di sini: getaran per-frame, kurva yang
di-bake rapat tanpa bentuk, gerakan yang kaku tanpa follow-through, dan
bobot skin yang perlu dirapikan setelah retargeting.

Satu catatan arah: **RGB MoCap tidak berjalan di dalam halaman ini.** Ia
aplikasi desktop Windows dengan PyTorch CUDA dan butuh sekitar 45 GB;
yang dijembatani di sini adalah berkasnya, bukan proses AI-nya. Export
dari sini keluar sebagai GLB atau JSON — three.js tidak punya eksporter
FBX, jadi untuk kembali ke FBX perlu konversi di Blender.

Dukungan FBX mengikuti pemuat three.js: FBX biner versi 7 dan ASCII versi
7 ke atas. FBX 6.x lama tidak terbaca. Tekstur yang disimpan sebagai
berkas terpisah di sebelah FBX juga tidak ikut, karena berkasnya dibaca
lewat object URL tanpa berkas tetangga.

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
js/poserefine.js            bereskan titik sendi sebelum jadi rotasi (tanpa dependensi)
js/posemocap.js             titik sendi → rotasi tulang (tanpa dependensi)
js/posepipeline.js          rig three.js dari keluaran posemocap
js/retarget.js              pindahkan tangkapan ke rig model lain
js/avatar.js                avatar manusia ber-rig untuk contoh bawaan
js/posedetect.js            jembatan ke MediaPipe Pose
js/three-adapter.js         jembatan THREE.AnimationClip ↔ engine
js/app.js                   viewer, kontrol, export
standalone.html             hasil rakitan satu berkas (jangan diedit langsung)
tools/build-standalone.js   perakitnya
tests/fluidizer.test.js     unit test engine animasi
tests/skinfix.test.js       unit test perbaikan skin
tests/posemocap.test.js     unit test retargeting pose
tests/posepipeline.test.js  penjaga rig hasil tangkapan (termasuk material.skinning)
tests/poserefine.test.js    ukur pembenahan: acuan buatan + frame detektor sungguhan
tests/fixtures/             70 frame keluaran MediaPipe nyata, penjaga tetap
tests/retarget.test.js      penjaga pencocokan nama tulang & matematika retarget
tests/avatar.test.js        penjaga rangka, bobot skin, dan cacat klip contoh
tests/i18n.test.js          penjaga paritas kamus dua bahasa
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

Test browser menyalin halaman ke direktori sementara, menyalin three.js
dari `node_modules`, dan mengarahkan import map ke salinan itu — jadi
tidak bergantung pada jaringan. Halamannya disajikan lewat HTTP lokal,
bukan `file://`: modul ES tunduk pada CORS dan berkas lokal beroperasi di
origin `null`, sehingga setiap `import` diblokir di sana. Kalau sudah
punya Chromium sendiri, set `CHROMIUM_PATH`. `MFS_SERVE_DEBUG=1`
menyebutkan berkas yang 404 — tanpa itu yang terlihat cuma "Failed to
load resource" tanpa nama.

`tests/poserefine.test.js` berdiri di atas dua kaki yang tidak bisa
saling menggantikan, dan itu bukan kelebihan ketelitian. Kaki pertama
kebenaran acuan buatan: gerakan dengan panjang tulang yang persis tetap,
dirusak seperti deteksi satu kamera merusaknya, lalu hasil pembenahan
dibandingkan ke acuannya — satu-satunya cara mengetahui **arah**
errornya. Kaki kedua 70 frame keluaran MediaPipe sungguhan di
`tests/fixtures/`, tanpa acuan apa pun, diukur dengan sentakan
antar-frame — satu-satunya cara mengetahui **bentuk** kesalahannya.

Keduanya diperlukan karena sebuah tahap yang menang bersih di kaki
pertama terbukti merusak kaki kedua, dan dibuang karena itu. Ceritanya
di [Tahap ketiga yang dibuang](#tahap-ketiga-yang-dibuang-dan-kenapa-itu-penting)
dan di `tests/fixtures/README.md`. Siapa pun yang menambah tahap baru di
`poserefine.js` harus mengukurnya di kaki kedua, bukan cuma di kaki
pertama.

Asersi per-tulang di sana juga disengaja: rata-rata bisa menipu, karena
satu tulang boleh saja meledak sementara empat belas lainnya membaik dan
jumlahnya masih terlihat turun. Tahap yang dibuang ketahuan tepat di
situ.

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

`tests/posemocap.test.js` menguji retargeting-nya dengan orang sintetis,
termasuk dua round-trip: arah tiap tulang hasil forward kinematics harus
cocok dengan arah sendi masukan, dan posisi pangkal tiap tulang harus
cocok dengan landmark-nya. Yang kedua itu penting — versi pertama modul
ini memasang lengan di tengah dada dan round-trip arah tetap lolos.

`tests/browser/video.test.js` membuat video ujinya sendiri di dalam
halaman, dengan MediaRecorder dari satu foto yang digerakkan, jadi tidak
ada berkas video yang ikut repo. Foto dan berkas model MediaPipe (5,7 MB)
di-cache di `tests/browser/.cache` dan diunduh sekali saat dibutuhkan;
kalau tidak tersedia, test-nya melewat dengan keterangan, bukan gagal.
Deteksi pose dijalankan lewat HTTP, bukan `file://`: di sana blob URL
video diblokir dan `import()` dari script klasik tidak bisa me-resolve
modul.

`tests/browser/scale.test.js` memuat model setinggi 0,05 / 2 / 160 / 5000
unit dan memeriksa dari piksel bahwa semuanya terlihat, di tengah, dan
berproporsi wajar. Tanpa penskalaan skena, dua ukuran terbesar menghasilkan
**0,000% piksel terang** — tak terlihat sama sekali. Berkas Mixamo tidak
bisa disertakan karena lisensinya, jadi berkas uji dibuat sendiri dan
pengkabelan FBX diperiksa lewat rutenya: berkas .fbx rusak harus memberi
pesan khusus FBX, bukan pesan glTF.

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
- **Skena menyesuaikan ukuran model.** Kabut, grid, lantai, dan kamera
  bayangan dihitung dari kotak batas model, bukan dari nilai tetap.
  Berkas dunia nyata datang dalam satuan apa saja — FBX mocap umumnya
  sentimeter, jadi karakter 1,6 meter masuk sebagai 160 unit. Dengan
  kabut tetap 18–55 unit, model sejauh itu dirender persis warna latar
  dan viewport tampak kosong padahal framing-nya benar.
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
- **Codec video bergantung peramban, bukan aplikasi ini.** Deteksi
  membaca video lewat elemen `<video>`, jadi apa pun yang tidak bisa
  didekode peramban juga tidak bisa ditangkap di sini. HEVC/H.265 jalan
  di Safari tapi sering tidak di Chrome desktop.
- **Deteksi pose menebak rotasi tulang.** Yang diberikan deteksi adalah
  posisi sendi; twist di sepanjang tulang tidak terukur sama sekali dan
  hanya ditebak dari sumbu bahu atau pinggul. Satu orang per video, dan
  potongan kamera akan merusak kontinuitasnya. `js/poserefine.js`
  menurunkan sentakannya 26 persen pada video sungguhan, tapi itu
  menghaluskan apa yang terukur — ia tidak bisa memunculkan twist yang
  memang tidak pernah diukur. Untuk menembus langit-langit itu, lihat
  [Kalau butuh mocap yang betulan bagus](#kalau-butuh-mocap-yang-betulan-bagus).
- **Sendi yang tertutup lebih dari 0,4 detik dibekukan.** Celah lebih
  pendek dijembatani; yang lebih panjang ditahan di rotasi terakhirnya,
  karena menebak lebih jauh dari itu mengarang gerakan yang tidak
  pernah ada. Anggota badan yang hilang lama akan terlihat beku lalu
  menyentak saat terbaca kembali.
- **Model statis tidak bisa dianimasikan.** GLB tanpa skeleton —
  `"skins": []` di glTF-nya, lazim untuk hasil scan atau konversi OBJ —
  bisa dilihat tapi tidak bisa jadi sasaran retarget. Tidak ada tulang
  untuk digerakkan.
- **Perbaikan skin bekerja pada topologi, bukan pada makna anatomi.**
  Penghalusan envelope tidak tahu mana siku dan mana lutut; ia hanya
  melandaikan medan bobot. Untuk rig yang envelope-nya memang sengaja
  tajam, turunkan atau matikan penghalusannya.
- **Pemrosesan di main thread.** Klip dikerjakan satu per satu lewat
  `setTimeout` supaya UI tidak membeku, tapi rig sangat besar dengan frame
  rate tinggi tetap akan terasa jeda. Web Worker adalah langkah berikutnya
  yang masuk akal.
- Dimuat dari CDN: three.js 0.186.1, dipatok versinya, lewat import map
  sebagai modul ES. Peramban tanpa dukungan import map (Safari di bawah
  16.4, Chrome di bawah 89) tidak akan jalan.

## Kalau butuh mocap yang betulan bagus

Deteksi pose di peramban punya langit-langit yang tidak bisa dinaikkan
dengan menghaluskan: dia memberi **posisi sendi**, dan rotasi tulang
harus disimpulkan dari situ. Twist di sepanjang tulang tidak terukur
sama sekali. Tidak ada filter yang bisa memunculkan informasi yang
memang tidak pernah diukur.

Yang menembus langit-langit itu adalah model yang memprediksi
**rotasi langsung dari video**. Yang paling matang saat ini
[MoCapAnything V2](https://github.com/phongdaot/MocapAnything) (MIT):
video → rotasi siap-BVH, satu jaringan ujung-ke-ujung, dan dia sudah
sadar-skeleton — jadi retargeting ke rig sembarang ikut terbangun di
dalamnya, bukan ditempel belakangan.

**Tidak bisa dimasukkan ke MFS 5, dan itu bukan soal kemauan.** Dia
PyTorch dengan transformer difusi dan fitur DINOv2 per frame: butuh GPU,
bobot dari HuggingFace dalam ukuran gigabyte, dan Blender untuk render
mesh opsionalnya. Tidak ada jalur ONNX atau WebGPU di repo-nya. MFS 5
seluruhnya berjalan di peramban dan `standalone.html` tetap satu
berkas — dua hal yang tidak mungkin dipertahankan sambil menjalankan
model difusi.

Jadi pembagian kerjanya begini, dan ini cara memakai keduanya hari ini:

```
MoCapAnything (di luar peramban)        MFS 5 (di peramban)
───────────────────────────────         ──────────────────────────
video → rotasi sendi → BVH/GLB    →     impor GLB → retarget ke
                                        model sendiri → bersihkan
HF Space gratis (ZeroGPU),              jitter → ekspor GLB
atau lokal dengan GPU
```

Jalurnya sudah jalan sekarang, tanpa kode tambahan: ambil GLB dari
[demo HuggingFace-nya](https://huggingface.co/spaces/kehong/MoCapAnythingV2)
— gratis dan tidak perlu setup apa pun — lalu buka di MFS 5 seperti
model lain. Retarget dan engine di sini bekerja di atas klip yang sudah
ada di dalam GLB, tidak peduli dari mana datangnya.

Yang MFS 5 belum punya dan akan jadi penghubung yang lebih rapi: impor
**BVH**, format keluaran utama MoCapAnything. `THREE.BVHLoader` ada di
`examples/jsm/loaders/`, jadi ongkosnya kecil. Belum dikerjakan.

Yang **diambil** dari MoCapAnything tanpa menjalankannya adalah
gagasannya, dan itu sudah masuk: temporal trunk-nya mengurus koherensi
antar frame, dan `js/poserefine.js` mengerjakan hal yang sama dengan
cara klasik. Satu gagasannya sudah dicoba dan **ditolak oleh
pengukuran** — kendala panjang tulang; ceritanya di
[Tahap ketiga yang dibuang](#tahap-ketiga-yang-dibuang-dan-kenapa-itu-penting).
Dua yang belum dicoba dan masih masuk akal: batas sudut sendi (siku dan
lutut cuma menekuk satu arah) dan dekomposisi twist. Keduanya butuh
prior yang dipelajari dari data, bukan aturan tangan — jadi kalau
dikerjakan, harus diukur pada `tests/fixtures/pose-prostration.json`
dulu, bukan pada benchmark buatan.

## Model statis tidak bisa dianimasikan

Kalau sebuah GLB mau dipakai sebagai contoh yang **digerakkan** oleh
tangkapan video, dia harus punya skeleton. Banyak model bagus di
Sketchfab dan sejenisnya tidak punya: hasil scan atau konversi OBJ
datang sebagai mesh mati. Tandanya di glTF-nya `"skins": []` dan
`"animations": []`, dan node-nya cuma satu grup berisi `Object_0`,
`Object_1`, dan seterusnya tanpa tulang.

Model begitu tetap bisa dimuat dan dilihat di MFS 5, tapi retarget akan
menolaknya — tidak ada tulang untuk digerakkan — dan opsi skinning akan
terkunci. Memberinya rangka berarti auto-rigging plus bobot skin; itu
pekerjaan tersendiri dan bukan sesuatu yang bisa disimpulkan dari
mesh-nya saja.

Untuk contoh bawaan yang bisa langsung dicoba, avatar di `js/avatar.js`
dibangun dari kode justru supaya tidak ada aset yang lisensinya harus
dipikirkan dan `standalone.html` tetap satu berkas — GLB 3 MB yang
di-base64 menambah sekitar 4 MB ke berkas yang sekarang 252 KB.
