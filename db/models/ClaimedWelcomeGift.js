/**
 * ClaimedWelcomeGift Model — permanent anti-abuse tracker.
 * Survives account deletion to prevent re-registration gift farming.
 */
const mongoose = require('mongoose');

const claimedWelcomeGiftSchema = new mongoose.Schema({
    email:      { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    claimed_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ClaimedWelcomeGift', claimedWelcomeGiftSchema);
