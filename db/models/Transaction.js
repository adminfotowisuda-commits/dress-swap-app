/**
 * Transaction Model — payment & credit history.
 * Replaces the `db.transactions` array in database.json.
 */
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    invoice_number: { type: String, required: true, unique: true, index: true },
    email:          { type: String, required: true, lowercase: true, trim: true, index: true },
    package_id:     { type: String, default: '' },
    amount:         { type: Number, default: 0 },       // IDR price (e.g. 10000)
    credits:        { type: Number, default: 0 },       // credits given (e.g. 10)
    type:           { type: String, enum: ['top-up', 'refund', 'deduction', 'usage'], default: 'top-up' },
    description:    { type: String, default: '' },
    status:         { type: String, enum: ['pending', 'success', 'refund', 'failed'], default: 'pending' },
    created_at:     { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
