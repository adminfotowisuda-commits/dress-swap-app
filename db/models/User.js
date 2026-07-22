/**
 * User Model — stores user accounts, credits, and roles.
 * Replaces the `db.users` object in database.json.
 */
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email:           { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password:        { type: String, default: '' },
    credits_balance: { type: Number, default: 0, min: 0 },
    role:            { type: String, enum: ['user', 'admin'], default: 'user' },
    created_at:      { type: Date, default: Date.now },
    updated_at:         { type: Date, default: Date.now },
    last_activity_date: { type: Date, default: Date.now },
    transactions:    [{
        id:          { type: String },
        amount:      { type: Number },
        description: { type: String },
        date:        { type: Date, default: Date.now }
    }]
});

// Auto-update `updated_at` on save (sync hook — no next() needed)
userSchema.pre('save', function () {
    this.updated_at = new Date();
});

module.exports = mongoose.model('User', userSchema);
