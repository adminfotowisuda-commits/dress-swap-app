/**
 * MongoDB Atlas Connection
 * ------------------------------------------------------------------
 * Connects to the fotowisuda cluster. Exported as a Promise so the
 * server can await it before binding routes that need the database.
 */
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI ||
    'mongodb+srv://adminfotowisuda_db_user:NJ3j6Z8BF7oFSIU9@cluster0.qvj3zgy.mongodb.net/fotowisuda?retryWrites=true&w=majority';

let _connected = false;

async function connectDB() {
    if (_connected) return;
    try {
        await mongoose.connect(MONGODB_URI, {
            // Mongoose 7+ options are auto-detected; keep explicit for clarity
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        _connected = true;
        console.log('[mongodb] Connected to MongoDB Atlas — fotowisuda database');
    } catch (err) {
        console.error('[mongodb] Connection FAILED:', err.message);
        // Don't crash — the server can still serve static files.
        // Endpoints that need DB will return 503.
        _connected = false;
    }
}

function isConnected() {
    return _connected && mongoose.connection.readyState === 1;
}

module.exports = { connectDB, isConnected, mongoose };
