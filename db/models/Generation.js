/**
 * Generation Model — stores image generation records.
 * Replaces both the `db.generations` array AND local image files.
 * The `image_url` field now points to a Cloudinary secure URL.
 */
const mongoose = require('mongoose');

const generationSchema = new mongoose.Schema({
    generation_id:   { type: String, required: true, unique: true, index: true },
    email:           { type: String, default: '', lowercase: true, trim: true, index: true },
    owner_email:     { type: String, default: '', lowercase: true, trim: true },
    type:            { type: String, enum: ['bgswap', 'dresswap', 'filter-factory', 'filter-swap', 'admin-swap'], default: 'filter-factory' },
    status:          { type: String, enum: ['processing', 'COMPLETE', 'FAILED', 'PENDING'], default: 'processing' },
    prompt:          { type: String, default: '' },
    negative_prompt: { type: String, default: '' },
    filterTitle:     { type: String, default: '' },
    selected_tag:    { type: String, default: 'Studio' },
    lighting:        { type: String, default: '' },
    width:           { type: Number, default: 1024 },
    height:          { type: Number, default: 1024 },

    // Cloudinary URLs (replaces local file paths)
    image_url:             { type: String, default: '' },   // main generated image
    cover_image_url:       { type: String, default: '' },   // thumbnail/cover
    reference_image_1_url: { type: String, default: '' },
    reference_image_2_url: { type: String, default: '' },

    // Legacy local paths (for migration reference, can be removed later)
    cover_image_path:       { type: String, default: '' },
    reference_image_1_path: { type: String, default: '' },
    reference_image_2_path: { type: String, default: '' },

    created_at: { type: Date, default: Date.now }
});

// Index for fast user queries
generationSchema.index({ email: 1, created_at: -1 });
generationSchema.index({ owner_email: 1, created_at: -1 });
generationSchema.index({ type: 1, created_at: -1 });

module.exports = mongoose.model('Generation', generationSchema);
