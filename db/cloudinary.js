/**
 * Cloudinary Configuration
 * ------------------------------------------------------------------
 * Uploads generated images to Cloudinary and returns secure URLs.
 * Falls back gracefully if credentials are not configured.
 */
const cloudinary = require('cloudinary').v2;
const fs         = require('fs');

const CLOUDINARY_CONFIGURED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (CLOUDINARY_CONFIGURED) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure:     true
    });
    console.log('[cloudinary] Configured — uploads enabled');
} else {
    console.warn('[cloudinary] NOT configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env');
}

/**
 * Upload a local file buffer or path to Cloudinary.
 * @param {string|Buffer} source — file path on disk, or a Buffer
 * @param {string} folder — Cloudinary folder name (e.g. 'generations')
 * @param {string} publicId — optional public_id for the upload
 * @returns {Promise<{url: string, public_id: string}|null>}
 */
async function uploadToCloudinary(source, folder, publicId) {
    if (!CLOUDINARY_CONFIGURED) {
        console.warn('[cloudinary] Skipped upload — not configured');
        return null;
    }
    try {
        // Convert Buffer to base64 data URI if needed (Cloudinary SDK expects string)
        let uploadSource = source;
        if (Buffer.isBuffer(source)) {
            const base64 = source.toString('base64');
            uploadSource = 'data:image/jpeg;base64,' + base64;
        }
        const result = await cloudinary.uploader.upload(uploadSource, {
            folder: `fotowisuda/${folder}`,
            public_id: publicId || undefined,
            overwrite: true,
            resource_type: 'image',
            quality: 'auto:good',
            fetch_format: 'auto'
        });
        console.log(`[cloudinary] Uploaded → ${result.secure_url}`);
        return {
            url: result.secure_url,
            public_id: result.public_id
        };
    } catch (err) {
        console.error('[cloudinary] Upload FAILED:', err.message);
        return null;
    }
}

module.exports = { uploadToCloudinary, CLOUDINARY_CONFIGURED };
