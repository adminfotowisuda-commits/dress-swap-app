# Product Requirement Document (PRD) - Fitur "DRESS SWAP"
**Aplikasi:** fotowisuda.ai
**Status:** Progres R&D (Localhost)
**Tujuan:** Memungkinkan pengguna mengganti pakaian/kebaya objek dengan mempertahankan wajah dan latar belakang asli 100%.

---

## 1. Alur Logika Pemrosesan (Pipeline)
1. **Input User:** Mengunggah 2 gambar via UI Frontend.
   - **Image Reference 1:** Foto objek utama (Wajah + Latar Belakang Studio/Lingkungan).
   - **Image Reference 2:** Foto referensi baju kebaya / dress yang ingin ditiru.
2. **Analisis Multimodal (Gemini 3.5 Flash):** Kedua gambar dikompresi dan dikirim ke API Gemini untuk dianalisis secara silang berdasarkan instruksi sistem (System Prompt). Gemini mengeluarkan output berupa instruksi prompt teks JSON.
3. **Generasi Gambar (Leonardo.ai):** Prompt hasil olahan Gemini dikirim ke endpoint `/api/rest/v2/generations` milik Leonardo.ai bersama dengan ID upload gambar dari localhost (keduanya diset ke `strength: MID`).
4. **Output:** Hasil gambar dari Leonardo ditarik ke localhost, ditampilkan di antarmuka UI, dan dicatat riwayatnya ke `db.json`.

---

## 2. Spesifikasi Antarmuka UI (Frontend)
- **Akses Menu:** Sidebar permanen baru berlabel `👗 Dress Swap` pada rute `/dress-swap`.
- **Komponen Form:**
  - Area Dropzone 1: Image Reference 1 (Subject & Background Blueprint).
  - Area Dropzone 2: Image Reference 2 (Fashion Blueprint).
  - Dropdown Pilihan Dimensi (Aspect Ratio):
    * 2:3 (1696 x 2528)
    * 4:5 (1856 x 2304)
    * 4:3 (2400 x 1792)
  - Tombol Aksi: `Generate Dress`
- **Komponen Status:** Menampilkan placeholder teks/animasi *"Image is being processed... Please wait"* saat API berjalan, lalu otomatis berubah menampilkan gambar hasil ketika sukses.

---

## 3. Konfigurasi Parameter API Leonardo.ai (Haram Diubah User)
- **Model:** `nano-banana-2`
- **Prompt Enhance:** `OFF`
- **Style:** `Dynamic` -> `"style_ids": ["111dc692-d470-4eec-b791-3475abac4c46"]`
- **Quantity:** `1`
- **Public Mode:** `false` (Private Mode ON)
- **Image Guidance:** Menggunakan kedua Image ID dari localhost dengan bobot `"strength": "MID"`.

---

## 4. Kerangka Kerja System Prompt Gemini 3.5 Flash

### CRITICAL MAPPING RULES:
#### A. EXTRACT & PRESERVE STRICTLY FROM "IMAGE REFERENCE 1" (Subject & Environment):
1. Preserve the exact environment, architectural background, furniture, and setting details down to every pixel.
2. Maintain the precise lighting technique, ambient atmosphere, color grading, and photography tone.
3. Keep the exact facial identity, features, and emotional expression of the graduation subject.
4. Retain any personal accessories present such as necklaces, graduation sashes (selempang), diploma covers, graduation caps (topi toga), academic gowns (jubah wisuda), and high heels.

#### B. EXTRACT & TRANSFER STRICTLY FROM "IMAGE REFERENCE 2" (Fashion Blueprint):
1. Copy the exact shape, cutting, silhouette, and design pattern of the dress or traditional kebaya.
2. Replicate the precise colors and gradients of the dress/kebaya.
3. Capture the intricate textures, embroidery, beadings, lace details, or fabric materials from the garment.

#### C. GLOBAL NEGATIVE RESTRICTIONS:
1. STRICTLY FORBID background crowds, bystanders, pedestrians, or extra people to avoid crowded/busy scenery.
2. ELIMINATE all overlay metadata: text, fonts, photography watermarks, logo signatures, and branding marks.

#### D. HYBRID ISLAMIC/HIJAB FALLBACK LOGIC:
1. Hijab vs Open Neckline: If "Image Reference 2" displays a dress with an open neckline or exposed skin, but the subject in "Image Reference 1" wears a hijab, you MUST adapt the dress by adding a modest, elegant mandarin/shanghai collar ("kerah shanghai") using the matching color scheme and fabric style of Image Reference 2.
2. Hijab Integration: If "Image Reference 2" features a model without a hijab, but the subject in "Image Reference 1" wears a hijab, you MUST explicitly prompt the addition of a neat, tightly wrapped formal hijab style ("hijab model cekek leher") that seamlessly coordinates with the color and texture of the copied dress from Image Reference 2.