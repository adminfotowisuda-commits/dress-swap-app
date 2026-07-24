/**
 * Testimonial Model — stores user testimonials/reviews.
 */
const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema({
    user_email:  { type: String, required: true, lowercase: true, trim: true, index: true },
    user_name:   { type: String, default: 'Anonymous' },
    user_avatar: { type: String, default: '' },
    rating:      { type: Number, required: true, min: 1, max: 5 },
    message:     { type: String, required: true },
    image_url:   { type: String, default: '' },
    created_at:  { type: Date, default: Date.now, index: true }
});

// Compound index for efficient queries
testimonialSchema.index({ created_at: -1 });

module.exports = mongoose.model('Testimonial', testimonialSchema);
