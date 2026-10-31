# Fixture

## `pose-prostration.json`

Keluaran MediaPipe Pose Landmarker yang **sungguhan**, 70 frame pada
24 fps, dari video seseorang salat — potongan 3 detik paling sulitnya,
saat sujud.

Ada karena satu kesalahan yang mahal. `js/poserefine.js` dulu punya
tahap ketiga yang memaksa panjang tiap tulang ke median seluruh frame.
Diukur terhadap kebenaran acuan buatan di `tests/poserefine.test.js`,
tahap itu tampak yang paling berguna dari ketiganya: error posisi sendi
turun dari 12,1 mm jadi 10,7 mm. Diukur pada 70 frame ini, dia
**menaikkan** sentakan antar-frame dari 1,78° jadi 4,42° per frame dan
melipattigakan jumlah frame yang menyentak di atas 20°. Tidak ada satu
pun setelan yang menyelamatkannya; bahkan dibatasi sampai 2 persen
panjang tulang dia masih lebih buruk daripada tidak dipakai. Tahapnya
dibuang.

Sebabnya ada di model derau, bukan di aljabarnya. Test buatan memberi
tiap sendi derau kecil yang berdiri sendiri-sendiri. Kesalahan MediaPipe
tidak begitu: dia **terstruktur**. Anggota badan yang terjepit menghadap
kamera diringkusnya jadi sepertiga panjangnya, utuh, konsisten dengan
dirinya sendiri — dan kendala panjang tulang menyerang persis jenis
kesalahan yang tidak dibuat MediaPipe, sambil mengarang jenis yang
dibuatnya.

Jadi fixture ini bukan pelengkap test buatan, melainkan pasangannya yang
tidak bisa digantikan: yang buatan tahu arah kebenarannya, yang ini tahu
bentuk kesalahannya.

Formatnya dipadatkan supaya 70 frame cukup 42 KB:

```
{ fps, frames: [ { t, l: [ [x,y,z,visibility] | 0, ... ] } ] }
```

`0` berarti landmark yang tidak dipakai rig (mata, mulut, jempol,
tumit) dan tidak ikut disimpan. Koordinatnya dibulatkan ke 4 angka
desimal, keyakinannya ke 3 — jauh di bawah ketelitian detektornya
sendiri.

Tidak ada gambar, cuma koordinat sendi.
