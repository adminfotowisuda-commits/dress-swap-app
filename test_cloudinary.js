const cloudinary = require('cloudinary').v2;

// 1. Configure Cloudinary (menggunakan kunci asli)
cloudinary.config({
  cloud_name: 'fkmekr6f',
  api_key: '286347114335854',
  api_secret: 'Zc9-8JPR8RFw-QrQUOtEHo2cq7M'
});

async function run() {
  try {
    console.log("Mulai mengunggah gambar...");

    // 2. Upload an image
    const uploadResult = await cloudinary.uploader.upload("https://res.cloudinary.com/demo/image/upload/sample.jpg", {
      public_id: "sample_upload_test"
    });

    console.log("Upload berhasil!");
    console.log("Secure URL:", uploadResult.secure_url);
    console.log("Public ID:", uploadResult.public_id);

    // 3. Get image details
    console.log("\n--- Detail Gambar ---");
    console.log("Width:", uploadResult.width);
    console.log("Height:", uploadResult.height);
    console.log("Format:", uploadResult.format);
    console.log("File Size (bytes):", uploadResult.bytes);

    // 4. Transform the image
    const transformedUrl = cloudinary.url(uploadResult.public_id, {
      fetch_format: 'auto',
      quality: 'auto'
    });

    console.log("\nDone! Click link below to see optimized version of the image. Check the size and the format.");
    console.log(transformedUrl);

  } catch (error) {
    console.error("Error:", error);
  }
}

run();
