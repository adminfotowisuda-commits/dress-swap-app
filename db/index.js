/**
 * Database Layer — unified MongoDB + Cloudinary exports.
 * ------------------------------------------------------------------
 * All server endpoints import from here instead of using
 * readCreditsDB / writeCreditsDB / fs.readdirSync.
 */
const { connectDB, isConnected, mongoose } = require('./connection');
const { uploadToCloudinary, CLOUDINARY_CONFIGURED } = require('./cloudinary');
const User               = require('./models/User');
const Transaction        = require('./models/Transaction');
const Generation         = require('./models/Generation');
const ClaimedWelcomeGift = require('./models/ClaimedWelcomeGift');

// Re-export everything
module.exports = {
    connectDB,
    isConnected,
    mongoose,
    User,
    Transaction,
    Generation,
    ClaimedWelcomeGift,
    uploadToCloudinary,
    CLOUDINARY_CONFIGURED
};
