/**
 * Settings Model — stores global system configuration key-value pairs.
 * Used for dynamic prompts (Gemini system instructions) and other
 * admin-configurable settings that should survive server restarts.
 */
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    key:        { type: String, required: true, unique: true, index: true },
    value:      { type: String, default: '' },
    updated_at: { type: Date, default: Date.now }
});

// Auto-update `updated_at` on save
settingsSchema.pre('save', function () {
    this.updated_at = new Date();
});

module.exports = mongoose.model('Settings', settingsSchema);
