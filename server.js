require('dotenv').config();
console.log('[env] MONGODB_URI exists:', !!process.env.MONGODB_URI);
console.log('[env] CLOUDINARY configured:', !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET));

/**
 * server.js — Express backend for fotowisuda.ai
 * ------------------------------------------------------------------
 * Proxies requests to the Leonardo.ai API so the API key never leaves
 * the server.  Handles reference-image uploads via presigned URLs,
 * creates generations, and polls Leonardo until each job resolves.
 *
 * v2.0 — Added Admin Gallery support:
 *   • Saves reference images locally to /public/uploads/references/
 *   • Downloads & thumbnails generated images via sharp → /public/uploads/thumbnails/
 *   • Maintains a lightweight JSON ledger at database.json
 *   • Exposes GET /api/gallery and DELETE /api/gallery/:id
 *
 * Endpoints:
 *   GET  /                              Serve the dashboard (code.html)
 *   GET  /my-creations                  Serve the My Creations page
 *   POST /api/generate                  Start a generation (multipart)
 *   GET  /api/status/:generationId       Poll generation progress
 *   GET  /api/gallery                   List all stored generation records
 *   DELETE /api/gallery/:id             Delete a record + its local files
 *
 * Prerequisites:
 *   Node.js 18+   (uses built-in global fetch)
 *   LEONARDO_API_KEY in .env
 */

// ------------------------------------------------------------------
// Dependencies
// ------------------------------------------------------------------
const express  = require('express');
const cors     = require('cors');
const cookieParser = require('cookie-parser');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const sharp    = require('sharp');
const { GoogleGenAI } = require('@google/genai');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

// ═══ CRASH PREVENTION — keep the server alive no matter what ═══
process.on('uncaughtException', (err) => {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error('║  [FATAL] UNCAUGHT EXCEPTION — would have crashed!   ║');
    console.error('╚══════════════════════════════════════════════════════╝');
    console.error('[FATAL] Message:', err.message);
    console.error('[FATAL] Stack:', err.stack);
    console.error('');
    // DO NOT process.exit() — keep the server alive
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error('║  [FATAL] UNHANDLED REJECTION — would have crashed!   ║');
    console.error('╚══════════════════════════════════════════════════════╝');
    console.error('[FATAL] Reason:', reason);
    if (reason && reason.stack) console.error('[FATAL] Stack:', reason.stack);
    console.error('');
});

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const PORT              = process.env.PORT || 3000;
const LEONARDO_API_KEY  = process.env.LEONARDO_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const LEONARDO_BASE_V2  = 'https://cloud.leonardo.ai/api/rest/v2';  // generation creation
const LEONARDO_BASE_V1  = 'https://cloud.leonardo.ai/api/rest/v1';  // upload + status

// Gemini client — lazy-initialized so the server still starts if the key is missing
let geminiClient = null;
function getGeminiClient() {
    if (!geminiClient && GEMINI_API_KEY) {
        geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log('  [gemini] GoogleGenAI client initialized');
    }
    return geminiClient;
}


// Local storage paths (relative to project root)
const UPLOADS_DIR       = path.join(__dirname, 'public', 'uploads');
const THUMBNAILS_DIR    = path.join(UPLOADS_DIR, 'thumbnails');
const REFERENCES_DIR    = path.join(UPLOADS_DIR, 'references');
// ═══ UNIFIED DATABASE — ONE FILE TO RULE THEM ALL ══════════════════
// database.json  → { users, transactions, packages, generations }
//   users         → { "email": { password, credits_balance, … } }
//   transactions  → [ { invoice_number, email, amount, … } ]
//   packages      → [ { package_id, name, price, credits_given } ]
//   generations   → [ { generation_id, status, … } ]
// Git-ignored — RUNTIME data, NEVER deployed.
// ═══════════════════════════════════════════════════════════════════
const DATABASE_PATH     = path.join(__dirname, 'database.json');
const CREDITS_DB_PATH   = DATABASE_PATH;  // unified — same file

// DOKU configuration — read from environment
const DOKU_CLIENT_ID            = process.env.DOKU_CLIENT_ID || '';
const DOKU_API_KEY              = process.env.DOKU_API_KEY || '';
const DOKU_SECRET_KEY           = process.env.DOKU_SECRET_KEY || process.env.DOKU_ACTIVE_SECRET_KEY || '';
const DOKU_MERCHANT_PRIVATE_KEY_PATH = process.env.DOKU_MERCHANT_PRIVATE_KEY_PATH || './keys/merchant-private.pem';
const DOKU_PUBLIC_KEY_PATH      = process.env.DOKU_PUBLIC_KEY_PATH || './keys/doku-public.pem';
const GOOGLE_CLIENT_ID          = process.env.GOOGLE_CLIENT_ID || '326328933073-ol034jhan4nit06stvc9thltff36313d.apps.googleusercontent.com';
const googleAuthClient          = new OAuth2Client(GOOGLE_CLIENT_ID);

const DOKU_BASE_URL             = process.env.DOKU_BASE_URL || 'https://api.doku.com';
const DOKU_B2B_TOKEN_PATH       = process.env.DOKU_B2B_TOKEN_PATH || '/authorization/v1/access-token/b2b';
const DOKU_CREATE_VA_PATH       = process.env.DOKU_CREATE_VA_PATH || '/doku-virtual-account/v2/payment-code';
const DOKU_CHECKOUT_PATH        = process.env.DOKU_CHECKOUT_PATH || '/checkout/v1/payment';

// Credit cost mapping — per-generation pricing
const CREDIT_COSTS = {
    '/api/background-swap':         60,
    '/api/dress-swap/generate':     60,
    '/api/admin-gallery-filter/swap': 45,
    '/api/filter-gallery/swap':     45
};

// Human-readable action names for credit usage history
const CREDIT_ACTION_NAMES = {
    '/api/background-swap':         'Background Swap',
    '/api/dress-swap/generate':     'Dress Swap',
    '/api/admin-gallery-filter/swap': 'Filter Gallery Swap',
    '/api/filter-gallery/swap':     'Filter Gallery Swap'
};

// Admin data directories — absolute local file saving for admin panel
const ADMIN_IMAGE_GEN_DIR   = path.join(__dirname, 'admin_data_image_generate');
const ADMIN_IMAGE_REF_DIR   = path.join(__dirname, 'admin_data_image_reference');
const ADMIN_PROMPT_DIR      = path.join(__dirname, 'admin_data_prompt');
const ADMIN_EMAIL           = 'admin.fotowisuda@gmail.com';
const ADMIN_SESSION_SECRET  = crypto.randomBytes(32).toString('hex'); // rotates on every server restart

// ═══ Admin Session Helpers ═══
function createAdminToken(email) {
    return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(email).digest('hex');
}

function verifyAdminCookie(req) {
    const token = req.cookies?.admin_session;
    if (!token) return false;
    const expected = createAdminToken(ADMIN_EMAIL);
    // Use timing-safe comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch (_) {
        return false;
    }
}

// Middleware: protects admin HTML page routes — redirects to /admin-login on failure
function requireAdminPage(req, res, next) {
    if (verifyAdminCookie(req)) return next();
    return res.redirect('/admin-login');
}

// Middleware: protects admin API routes — returns 401/403 JSON on failure
function requireAdminApi(req, res, next) {
    if (verifyAdminCookie(req)) return next();
    return res.status(401).json({ error: 'Unauthorized — admin session required.' });
}

// User data directories — absolute local file saving for public user panel
const USER_IMAGE_GEN_DIR    = path.join(__dirname, 'user_data_image_generate');
const USER_IMAGE_REF_DIR    = path.join(__dirname, 'user_data_image_reference');
const USER_PROMPT_DIR       = path.join(__dirname, 'user_data_prompt');

// Friendly warning rather than a hard crash so the frontend still loads
if (!LEONARDO_API_KEY) {
    console.warn('┌─────────────────────────────────────────────────────────────┐');
    console.warn('│  WARNING: LEONARDO_API_KEY is not set.                     │');
    console.warn('│  Copy .env.example to .env and paste your Leonardo key.    │');
    console.warn('│  The dashboard will load, but API calls will fail.         │');
    console.warn('└─────────────────────────────────────────────────────────────┘');
}

// ------------------------------------------------------------------
// Ensure asset directories + database.json exist on startup
// ------------------------------------------------------------------
function ensureDirectories() {
    [UPLOADS_DIR, THUMBNAILS_DIR, REFERENCES_DIR,
     ADMIN_IMAGE_GEN_DIR, ADMIN_IMAGE_REF_DIR, ADMIN_PROMPT_DIR,
     USER_IMAGE_GEN_DIR, USER_IMAGE_REF_DIR, USER_PROMPT_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`  [init] Created directory: ${dir}`);
        }
    });
}

function ensureDatabase() {
    if (!fs.existsSync(DATABASE_PATH)) {
        const defaultPackages = [
            { package_id: 'pkg_starter_29k',  name: 'Starter',  price: 29000,  credits_given: 135 },
            { package_id: 'pkg_populer_49k',  name: 'Populer',  price: 49000,  credits_given: 248 },
            { package_id: 'pkg_creator_149k', name: 'Creator',  price: 149000, credits_given: 826 },
            { package_id: 'pkg_studio_299k',  name: 'Studio',   price: 299000, credits_given: 1832 }
        ];
        const unified = { users: {}, transactions: [], packages: defaultPackages, generations: [] };
        fs.writeFileSync(DATABASE_PATH, JSON.stringify(unified, null, 2), 'utf8');
        console.log('  [init] Created database.json (unified: users + credits + generations)');
    } else {
        // Auto-migrate: if database.json exists as old array format, wrap it
        try {
            const raw = fs.readFileSync(DATABASE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const defaultPackages = [
                    { package_id: 'pkg_starter_29k',  name: 'Starter',  price: 29000,  credits_given: 135 },
                    { package_id: 'pkg_populer_49k',  name: 'Populer',  price: 49000,  credits_given: 248 },
                    { package_id: 'pkg_creator_149k', name: 'Creator',  price: 149000, credits_given: 826 },
                    { package_id: 'pkg_studio_299k',  name: 'Studio',   price: 299000, credits_given: 1832 }
                ];
                const unified = { users: {}, transactions: [], packages: defaultPackages, generations: parsed };
                fs.writeFileSync(DATABASE_PATH, JSON.stringify(unified, null, 2), 'utf8');
                console.log('  [init] Migrated database.json from array → unified object');
            } else if (!parsed.generations) {
                // Object without generations key — add it
                parsed.generations = parsed.generations || [];
                parsed.users = parsed.users || {};
                parsed.transactions = parsed.transactions || [];
                parsed.packages = parsed.packages || [];
                fs.writeFileSync(DATABASE_PATH, JSON.stringify(parsed, null, 2), 'utf8');
                console.log('  [init] Normalized database.json to unified format');
            }
        } catch (_) { /* leave as-is */ }
    }
}

/**
 * On server boot, scan database.json for records stuck in "processing"
 * status for more than 5 minutes and flip them to "failed" so the
 * frontend doesn't render infinite loading spinners for zombie jobs
 * that will never complete (crashed server, lost in-memory state, etc.).
 */
async function cleanupStaleProcessingRecords() {
    if (!db.isConnected()) return;

    const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    let cleaned = 0;

    // --- Stale processing records (>5 min old) ---
    const staleResult = await db.Generation.updateMany(
        { status: 'processing', created_at: { $lt: cutoff } },
        { $set: { status: 'failed', error: 'Auto-recovered: job was stuck in processing (server restart or crash)' } }
    );
    cleaned += staleResult.modifiedCount || 0;

    // --- Zombie bgswapc_ records (decommissioned endpoint) ---
    const zombieResult = await db.Generation.updateMany(
        { generation_id: { $regex: /^bgswapc_/ }, status: { $in: ['processing', 'complete'] } },
        { $set: { status: 'failed', error: 'Auto-recovered: Background Change by Claude has been decommissioned' } }
    );
    cleaned += zombieResult.modifiedCount || 0;

    if (cleaned > 0) {
        console.log(`  [cleanup] Flipped ${cleaned} stale/zombie record(s) → failed`);
    } else {
        console.log('  [cleanup] No stale processing records found');
    }
}

// ------------------------------------------------------------------
// JSON database helpers — lightweight ledger of generation records
// ------------------------------------------------------------------

/**
 * Read all generation records from database.json.
 * Handles both old array format and new unified object format.
 * @returns {Array<object>}
 */
/**
 * Generation helpers — MongoDB (replaces database.json file read/write)
 */

async function readDatabase() {
    if (!db.isConnected()) return [];
    return await db.Generation.find().sort({ created_at: -1 }).lean();
}

async function writeDatabase(records) {
    // No-op in MongoDB — individual operations handle persistence
}

async function appendToDatabase(record) {
    if (!db.isConnected()) return;
    await db.Generation.create(record);
    console.log(`  [mongodb] Record appended — ${record.generation_id}`);
}

async function upsertDatabaseRecord(record) {
    if (!db.isConnected()) return;
    await db.Generation.findOneAndUpdate(
        { generation_id: record.generation_id },
        { $set: record },
        { upsert: true, returnDocument: 'after' }
    );
    console.log(`  [mongodb] Record upserted — ${record.generation_id}`);
}

function insertProcessingPlaceholder(genId, type, prompt, width, height, ownerEmail) {
    // New filter-factory records start as DRAFTS (isActive: false).
    // Admins must manually toggle them ON after testing in the sandbox.
    // Other types (bgswap, dress-swap, filter-swap) are user creations
    // and don't use the isActive flag.
    const isFilterFactory = (type === 'filter-factory');
    upsertDatabaseRecord({
        generation_id: genId,
        type: type || 'unknown',
        prompt: (prompt || ''),  // FULL prompt — never truncate; AI needs the complete instruction
        status: 'processing',
        width: width,
        height: height,
        image_url: '',
        cover_image_url: '',
        email: ownerEmail || '',
        owner_email: ownerEmail || '',
        created_at: new Date(),
        ...(isFilterFactory ? { isActive: false } : {})
    });
}

async function removeFromDatabase(generationId) {
    if (!db.isConnected()) return false;
    const result = await db.Generation.findOneAndDelete({ generation_id: generationId });
    if (result) {
        console.log(`  [mongodb] Record deleted — ${generationId}`);
        return true;
    }
    return false;
}

/**
 * Sanitize an email address into a safe filename prefix.
 * "siti@gmail.com" → "siti_gmail_com"
 * Falls back to "guest_user" for empty/falsy input.
 * @param {string} email
 * @returns {string}
 */
function sanitizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return email.trim().toLowerCase()
        .replace(/@/g, '_at_')
        .replace(/\./g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 64) || '';
}

// ------------------------------------------------------------------
// Express setup
// ------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());

// ═══ Charset middleware — ensure UTF-8 encoding on all HTML responses ═══
// Prevents corrupted text like "Menganalisa…" from being rendered as mojibake
// when the browser falls back to a non-UTF-8 default encoding.
app.use((_req, res, next) => {
    const origSend = res.send.bind(res);
    res.send = function (body) {
        const ct = res.get('Content-Type') || '';
        if ((ct.includes('text/html') || ct === '') && !ct.includes('charset')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        return origSend(body);
    };
    next();
});

// Serve the frontend + static assets from the project root
// HTML files get no-cache headers so JS fixes reach users immediately
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
            res.set('Surrogate-Control', 'no-store');
        }
    }
}));
// Also serve /public/uploads explicitly so thumbnails + refs are reachable
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
// Serve localized Before-After demo images for the comparison sliders
app.use('/Image_display_background_change', express.static(path.join(__dirname, 'Image_display_background_change')));
app.use('/Image_display_dress_replicate', express.static(path.join(__dirname, 'Image_display_dress_replicate')));
// Serve user-generated images from the local file‑system store
app.use('/user_data_image_generate', express.static(USER_IMAGE_GEN_DIR));

// Main dashboard
app.get('/', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'code.html')));

// Background Change
app.get('/swap-bg', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'swap_bg.html')));


// Dress Replicate
app.get('/dress-swap', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'dress_swap.html')));

// Filter Image Factory
app.get('/generate', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'generate.html')));

// My Creations — user creations hub
app.get('/my-creations', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'my_creations_empty.html')));

// My Creations — underscore variant + .html extension
app.get(['/my_creations', '/my_creations.html'], (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'my_creations_empty.html')));

// Helper: prevent browser from caching HTML pages (so JS fixes reach users immediately)
function sendHtmlNoCache(res, filePath) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.sendFile(filePath);
}

// Filter Gallery (Public)
app.get('/filter-gallery', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery.html')));
app.get('/pricing', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'pricing.html')));
app.get('/profile', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'profile.html')));
app.get('/filter_gallery', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery.html')));

// Admin Login page (public — no guard)
app.get('/admin-login', (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin-login.html')));

// Admin Logout (GET) — clears cookie and redirects to login page
app.get('/admin-logout', (_req, res) => {
    res.clearCookie('admin_session', { path: '/' });
    res.redirect('/admin-login');
});

// Admin Logout (POST) — API endpoint for programmatic logout from the dashboard
app.post('/api/auth/admin-logout', (_req, res) => {
    res.clearCookie('admin_session', { path: '/' });
    console.log('[ADMIN AUTH] Admin logged out — session cleared');
    res.json({ success: true, message: 'Logged out successfully.' });
});

// Filter Gallery Admin (PROTECTED)
app.get('/admin-gallery-filter', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_gallery_filter.html')));
app.get('/filter-gallery-admin', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery_admin.html')));
app.get('/filter_gallery_admin', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery_admin.html')));

// Filter Gallery Factory (PROTECTED)
app.get('/filter-gallery-factory', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery_factory.html')));
app.get('/filter_gallery_factory', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'filter_gallery_factory.html')));

// Admin Creations (PROTECTED)
app.get('/admin-creations', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_creations.html')));
app.get('/admin_creations', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_creations.html')));

// Admin Portal — central hub landing page (PROTECTED)
app.get('/admin', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin.html')));
app.get('/admin-filters', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_filters.html')));

// ------------------------------------------------------------------
// Multer — accept up to 2 reference images in memory
// ------------------------------------------------------------------
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },               // 10 MB per file
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith('image/')) return cb(null, true);
        cb(new Error('Only image files are allowed (PNG, JPEG, WebP, etc.).'));
    }
});

// ------------------------------------------------------------------
// Database helpers — MongoDB Atlas (replaces database.json)
// ------------------------------------------------------------------

// ═══ Compatibility: MongoDB-backed wrappers for legacy DB function calls ═══
// These maintain the same API shape as the old database.json functions so
// existing endpoints continue to work without full rewrites.
async function readCreditsDB() {
    if (!db.isConnected()) return { users: {}, transactions: [], packages: DEFAULT_PACKAGES, credit_usages: [] };
    const users = {};
    const allUsers = await db.User.find().lean();
    for (const u of allUsers) users[u.email] = u;
    const transactions = await db.Transaction.find().sort({ created_at: -1 }).lean();
    return { users, transactions, packages: DEFAULT_PACKAGES, credit_usages: [] };
}

async function writeCreditsDB(_data) {
    // No-op in MongoDB — individual operations handle persistence
}

const DEFAULT_PACKAGES = [
    { package_id: 'pkg_starter_29k',  name: 'Starter',  price: 29000,  credits_given: 135 },
    { package_id: 'pkg_populer_49k',  name: 'Populer',  price: 49000,  credits_given: 248 },
    { package_id: 'pkg_creator_149k', name: 'Creator',  price: 149000, credits_given: 826 },
    { package_id: 'pkg_studio_299k',  name: 'Studio',   price: 299000, credits_given: 1832 }
];

function getCreditPackages() {
    return DEFAULT_PACKAGES;
}

async function getUserCredits(email) {
    if (!db.isConnected()) return null;
    const key = email.trim().toLowerCase();
    return await db.User.findOne({ email: key }).lean();
}

async function ensureUserExists(email) {
    if (!db.isConnected()) return null;
    const key = email.trim().toLowerCase();
    if (!key) return null;

    // Check if user already exists BEFORE attempting upsert
    const existing = await db.User.findOne({ email: key });
    if (existing) return existing;

    // Only create if truly new — $setOnInsert prevents overwrites
    try {
        const user = await db.User.findOneAndUpdate(
            { email: key },
            { $setOnInsert: { email: key, credits_balance: 0, created_at: new Date(), updated_at: new Date(), last_activity_date: new Date() } },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
        // If created_at is within the last second, it was just created
        const isNew = user.created_at && (Date.now() - new Date(user.created_at).getTime() < 2000);
        if (isNew) console.log(`  [mongodb] New user created: ${key}`);
        return user;
    } catch (err) {
        // Race condition: another request created the user between our findOne and findOneAndUpdate
        if (err.code === 11000) {
            return await db.User.findOne({ email: key });
        }
        throw err;
    }
}

async function addCredits(email, amount, invoiceNumber) {
    if (!db.isConnected()) return null;
    const key = email.trim().toLowerCase();
    await ensureUserExists(key);

    // Increment user credit balance
    const user = await db.User.findOneAndUpdate(
        { email: key },
        { $inc: { credits_balance: amount }, $set: { updated_at: new Date(), last_activity_date: new Date() } },
        { returnDocument: 'after' }
    );

    // Upsert transaction
    await db.Transaction.findOneAndUpdate(
        { invoice_number: invoiceNumber },
        { $set: { status: 'success', created_at: new Date() } },
        { upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`  [mongodb] +${amount} credits → ${key} (balance: ${user.credits_balance}, invoice: ${invoiceNumber})`);
    return user;
}

async function deductCredits(email, amount, description) {
    if (!db.isConnected()) return { success: false, error: 'Database unavailable', balance: 0 };
    const key = email.trim().toLowerCase();

    // Atomic update: $inc + $push prevents race conditions and records history
    const user = await db.User.findOneAndUpdate(
        { email: key, credits_balance: { $gte: amount } },
        {
            $inc: { credits_balance: -amount },
            $set: { updated_at: new Date(), last_activity_date: new Date() },
            $push: {
                transactions: {
                    id: Date.now().toString(),
                    amount: -amount,
                    description: description || 'Credit Usage',
                    date: new Date()
                }
            }
        },
        { returnDocument: 'after' }
    );

    if (!user) {
        const exists = await db.User.findOne({ email: key });
        if (!exists) return { success: false, error: 'User not found', balance: 0 };
        return { success: false, error: 'Insufficient credits', balance: exists.credits_balance };
    }

    // Also create a Transaction document so GET /api/user/transactions finds it.
    // The embedded User.transactions array records history inside the User doc;
    // the separate Transaction collection powers the frontend credit history modal.
    try {
        await db.Transaction.create({
            invoice_number: 'usage_' + Date.now(),
            email: key,
            amount: -amount,
            credits: -amount,
            type: 'usage',
            description: description || 'Credit Usage',
            status: 'success',
            created_at: new Date()
        });
    } catch (txnErr) {
        console.error(`  [mongodb] Failed to create Transaction doc for deduction:`, txnErr.message);
    }

    console.log(`  [mongodb] -${amount} credits → ${key} (balance: ${user.credits_balance})`);
    return { success: true, balance: user.credits_balance };
}

async function refundCredits(email, amount) {
    if (!db.isConnected()) return;
    const key = email.trim().toLowerCase();
    await db.User.findOneAndUpdate(
        { email: key },
        { $inc: { credits_balance: amount }, $set: { updated_at: new Date() } }
    );
    await db.Transaction.create({
        invoice_number: 'refund_' + Date.now(),
        email: key,
        amount: amount,
        credits: amount,
        type: 'refund',
        status: 'success'
    });
    console.log(`  [mongodb] REFUND +${amount} credits → ${key}`);
}

// ═══ Credit Expiration Logic ═══
// If a user has no activity for >30 days, their credit balance resets to 0.
// Called from the balance endpoint, auth handler, and the deduction middleware.
async function checkAndExpireCredits(email) {
    if (!db.isConnected()) return { expired: false, balance: null };
    const key = email.trim().toLowerCase();
    const user = await db.User.findOne({ email: key });
    if (!user) return { expired: false, balance: null };

    // Users with no last_activity_date yet (pre-migration) get it set now
    if (!user.last_activity_date) {
        await db.User.findOneAndUpdate(
            { email: key },
            { $set: { last_activity_date: new Date() } }
        );
        return { expired: false, balance: user.credits_balance };
    }

    const msSinceActivity = Date.now() - new Date(user.last_activity_date).getTime();
    const daysSinceActivity = Math.floor(msSinceActivity / (1000 * 60 * 60 * 24));

    if (daysSinceActivity > 30 && user.credits_balance > 0) {
        const expiredAmount = user.credits_balance;
        await db.User.findOneAndUpdate(
            { email: key },
            { $set: { credits_balance: 0, last_activity_date: new Date() } }
        );
        // Record the expiration as a transaction for audit trail
        await db.Transaction.create({
            invoice_number: 'expire_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            email: key,
            amount: 0,
            credits: -expiredAmount,
            type: 'expiry',
            description: 'Kredit hangus — tidak ada aktivitas selama 1 bulan',
            status: 'success',
            created_at: new Date()
        });
        console.log(`  [expiry] ${expiredAmount} credits expired for ${key} (last activity: ${user.last_activity_date})`);
        return { expired: true, balance: 0 };
    }

    return { expired: false, balance: user.credits_balance };
}

// ------------------------------------------------------------------
// DOKU API Helpers — SNAP BI signature + B2B token flow
// ------------------------------------------------------------------

let _cachedDokuToken = null;
let _dokuTokenExpiry = 0;

function loadDokuPrivateKey() {
    try {
        // Support inline PEM key in .env (starts with -----BEGIN)
        if (DOKU_MERCHANT_PRIVATE_KEY_PATH && DOKU_MERCHANT_PRIVATE_KEY_PATH.startsWith('-----BEGIN')) {
            return DOKU_MERCHANT_PRIVATE_KEY_PATH.trim();
        }
        // Primary: keys/merchant-private.pem relative to app root
        const primaryPath = path.join(__dirname, 'keys', 'merchant-private.pem');
        console.log(`  [doku] Looking for private key at: ${primaryPath}`);
        if (fs.existsSync(primaryPath)) {
            const key = fs.readFileSync(primaryPath, 'utf8').trim();
            console.log(`  [doku] Private key loaded from ${primaryPath} (${key.length} chars)`);
            return key;
        }
        // Fallback: configured path or ./private.key
        const keyPath = path.resolve(DOKU_MERCHANT_PRIVATE_KEY_PATH);
        console.log(`  [doku] Looking for private key at: ${keyPath}`);
        if (fs.existsSync(keyPath)) {
            const key = fs.readFileSync(keyPath, 'utf8').trim();
            console.log(`  [doku] Private key loaded from ${keyPath} (${key.length} chars)`);
            return key;
        }
        const altPrivateKey = path.join(__dirname, 'private.key');
        console.log(`  [doku] Looking for private key at: ${altPrivateKey}`);
        if (fs.existsSync(altPrivateKey)) {
            const key = fs.readFileSync(altPrivateKey, 'utf8').trim();
            console.log(`  [doku] Private key loaded from ${altPrivateKey} (${key.length} chars)`);
            return key;
        }
        console.error('  [doku] No private key file found! Checked paths:', primaryPath, keyPath, altPrivateKey);
        return null;
    } catch (err) {
        console.error('  [doku] Failed to load private key:', err.message);
        return null;
    }
}

function loadDokuPublicKey() {
    try {
        // Support inline PEM key in .env (starts with -----BEGIN)
        if (DOKU_PUBLIC_KEY_PATH && DOKU_PUBLIC_KEY_PATH.startsWith('-----BEGIN')) {
            return DOKU_PUBLIC_KEY_PATH;
        }
        const keyPath = path.resolve(DOKU_PUBLIC_KEY_PATH);
        if (!fs.existsSync(keyPath)) return null;
        return fs.readFileSync(keyPath, 'utf8');
    } catch (_) { return null; }
}

/**
 * Create a DOKU SNAP BI signature.
 * - algorithm = 'rsa'  → SHA256withRSA using Merchant Private Key
 * - algorithm = 'hmac' → HMAC-SHA512 using Active Secret Key (SNAP BI Direct)
 * - algorithm = 'hmac-sha256' → HMAC-SHA256 using Active Secret Key (DOKU Checkout)
 */
function createDokuSignature(stringToSign, algorithm) {
    if (algorithm === 'rsa') {
        const privateKey = loadDokuPrivateKey();
        if (!privateKey) throw new Error('DOKU_MERCHANT_PRIVATE_KEY not found');
        const sign = crypto.createSign('SHA256');
        sign.update(stringToSign);
        sign.end();
        return sign.sign(privateKey, 'base64');
    }
    if (algorithm === 'hmac') {
        const hmac = crypto.createHmac('sha512', DOKU_SECRET_KEY);
        hmac.update(stringToSign);
        return hmac.digest('base64');
    }
    if (algorithm === 'hmac-sha256') {
        const hmac = crypto.createHmac('sha256', DOKU_SECRET_KEY);
        hmac.update(stringToSign);
        return hmac.digest('base64');
    }
    throw new Error('Unknown signature algorithm: ' + algorithm);
}

/**
 * Verify a DOKU webhook signature using the DOKU Public Key.
 */
function verifyDokuSignature(headers, rawBody) {
    try {
        const publicKey = loadDokuPublicKey();
        if (!publicKey) {
            console.error('  [doku] Cannot verify webhook — DOKU Public Key missing');
            return false;
        }
        const signature = headers['x-signature'] || headers['signature'] || '';
        const timestamp = headers['x-timestamp'] || '';
        const stringToSign = timestamp + ':' + rawBody;
        const verify = crypto.createVerify('SHA256');
        verify.update(stringToSign);
        verify.end();
        return verify.verify(publicKey, signature, 'base64');
    } catch (err) {
        console.error('  [doku] Signature verification error:', err.message);
        return false;
    }
}

/**
 * Request a B2B Access Token from DOKU (SNAP BI).
 * Caches the token until expiry.
 */
async function requestDokuB2BToken() {
    if (_cachedDokuToken && Date.now() < _dokuTokenExpiry) {
        return _cachedDokuToken;
    }

    if (!DOKU_CLIENT_ID) {
        throw new Error('DOKU_CLIENT_ID not configured. Set it in .env');
    }

    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const stringToSign = DOKU_CLIENT_ID + '|' + timestamp;
    const signature = createDokuSignature(stringToSign, 'rsa');

    console.log(`  [doku] Requesting B2B token…`);
    console.log(`  [doku] B2B URL: ${DOKU_BASE_URL}${DOKU_B2B_TOKEN_PATH}`);
    console.log(`  [doku] B2B stringToSign: "${stringToSign}"`);
    console.log(`  [doku] B2B signature (first 40 chars): ${signature ? signature.slice(0, 40) : 'NULL'}`);
    console.log(`  [doku] B2B headers — X-CLIENT-KEY: ${DOKU_CLIENT_ID}, X-TIMESTAMP: ${timestamp}`);

    const resp = await fetch(`${DOKU_BASE_URL}${DOKU_B2B_TOKEN_PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CLIENT-KEY': DOKU_CLIENT_ID,
            'X-TIMESTAMP': timestamp,
            'X-SIGNATURE': signature
        },
        body: JSON.stringify({ grantType: 'client_credentials' })
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`DOKU B2B token request failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    _cachedDokuToken = data.accessToken;
    // Cache for 55 minutes (tokens typically last 60 min)
    _dokuTokenExpiry = Date.now() + (55 * 60 * 1000);
    console.log(`  [doku] B2B token obtained — expires in ~55 min`);
    return _cachedDokuToken;
}

/**
 * Create a DOKU Hosted Checkout session restricted to QRIS only.
 * Uses DOKU Checkout API (POST /checkout/v1/payment) — HMAC-SHA256 signed.
 * Returns the checkout payment URL for frontend redirect.
 */
async function createDokuCheckout(orderData) {
    const { email, package_id, invoice_number, amount } = orderData;
    const customerName = (email.split('@')[0] || 'customer').replace(/[^a-zA-Z0-9 ]/g, ' ').trim() || 'Customer';

    const endpointPath = DOKU_CHECKOUT_PATH; // /checkout/v1/payment
    const requestId = 'CHK-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // ── Checkout payload — restrict payment_method_types to QRIS only ──
    const requestBody = JSON.stringify({
        order: {
            invoice_number: invoice_number,
            amount: Math.round(Number(amount)),
            callback_url: 'https://fotowisuda.ai/api/payments/doku-callback',
            line_items: [{ name: 'Credit Top-Up', price: amount, quantity: 1 }]
        },
        payment: {
            payment_due_date: 60
        },
        customer: {
            name: customerName,
            email: email,
            phone: '081234567890'
        }
    });

    // ── HMAC-SHA256 signature (DOKU Checkout spec) ──
    const checkoutTimestamp = new Date().toISOString();
    const digestBase64 = crypto.createHash('sha256').update(requestBody).digest('base64');
    const stringToSign =
        'Client-Id:' + DOKU_CLIENT_ID + '\n' +
        'Request-Id:' + requestId + '\n' +
        'Request-Timestamp:' + checkoutTimestamp + '\n' +
        'Request-Target:' + endpointPath + '\n' +
        'Digest:' + digestBase64;
    const hmac = crypto.createHmac('sha256', DOKU_SECRET_KEY);
    hmac.update(stringToSign);
    const signatureValue = 'HMACSHA256=' + hmac.digest('base64');

    const headers = {
        'Content-Type': 'application/json',
        'Client-Id': DOKU_CLIENT_ID,
        'Request-Id': requestId,
        'Request-Timestamp': checkoutTimestamp,
        'Signature': signatureValue
    };

    console.log(`  [doku-checkout] Creating QRIS checkout for ${email} (${invoice_number})…`);
    console.log(`  [doku-checkout] Request body:`, requestBody);
    console.log(`  [doku-checkout] stringToSign:\n${stringToSign}`);

    const resp = await fetch(`${DOKU_BASE_URL}${endpointPath}`, {
        method: 'POST',
        headers: headers,
        body: requestBody
    });

    if (!resp.ok) {
        let errorBody = '';
        try { errorBody = await resp.text(); } catch (_) { errorBody = '(unable to read response body)'; }
        console.error(`  [doku-checkout] DOKU returned ${resp.status}: ${errorBody.slice(0, 500)}`);

        let dokuMsg = `DOKU API error (${resp.status})`;
        try {
            const parsed = JSON.parse(errorBody);
            if (parsed.error)   dokuMsg = parsed.error;
            if (parsed.message) dokuMsg = parsed.message;
        } catch (_) { /* not JSON */ }

        const err = new Error(dokuMsg);
        err.statusCode = resp.status;
        err.dokuRaw = errorBody.slice(0, 1000);
        throw err;
    }

    const data = await resp.json();
    console.log(`  [doku-checkout] Checkout response: ${JSON.stringify(data)}`);

    // ── Extract payment URL from DOKU Checkout response ──
    const paymentUrl = data.response?.payment?.url
                    || data.payment?.url
                    || data.paymentUrl
                    || data.redirectUrl
                    || null;

    console.log(`  [doku-checkout] Checkout — invoice: ${invoice_number} | url: ${paymentUrl || 'N/A'}`);
    return {
        invoice_number: invoice_number,
        payment_url: paymentUrl,
        raw: data
    };
}

// ------------------------------------------------------------------
// In-memory generation store (active polling jobs)
// ------------------------------------------------------------------
/**
 * Map<localGenerationId, {
 *   leonardoGenId  : string,        // Leonardo's internal generation ID
 *   status         : 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED',
 *   imageUrl       : string | null, // populated on COMPLETE
 *   error          : string | null, // populated on FAILED
 *   prompt         : string,
 *   width          : number,
 *   height         : number,
 *   createdAt      : number         // Date.now()
 * }>
 */
const activeGenerations = new Map();

// Cleanup entries older than 30 minutes every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, data] of activeGenerations) {
        if (data.createdAt < cutoff) activeGenerations.delete(id);
    }
}, 5 * 60 * 1000);

// ------------------------------------------------------------------
// Leonardo API helpers
// ------------------------------------------------------------------

/**
 * Build the standard Authorization header used on every Leonardo call.
 */
function authHeaders() {
    return {
        'Authorization': `Bearer ${LEONARDO_API_KEY}`,
        'Content-Type': 'application/json'
    };
}

/**
 * Upload a single image buffer to Leonardo via the presigned-S3-POST flow.
 *
 * Step 1 — POST /api/rest/v1/init-image  → { uploadInitImage: { url, fields, id } }
 * Step 2 — POST multipart/form-data (fields + file) to the S3 URL
 *
 * Returns the Leonardo image ID string.
 */
async function uploadImageToLeonardo(fileBuffer, originalName, mimeType) {
    // Derive the file extension from the MIME type
    const extMap = {
        'image/png':  'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif':  'gif',
        'image/bmp':  'bmp',
        'image/tiff': 'tiff'
    };
    const ext = extMap[mimeType]
             || (originalName.split('.').pop() || 'png').toLowerCase();

    // ================================================================
    // Step 1 — Request a presigned S3 POST from Leonardo v1
    // ================================================================
    console.log(`  [upload] Requesting presigned URL for "${originalName}" (${mimeType}, ${ext})…`);

    const initBody = JSON.stringify({ extension: ext });
    const initUrl  = `${LEONARDO_BASE_V1}/init-image`;

    const initResp = await fetch(initUrl, {
        method: 'POST',
        headers: authHeaders(),
        body: initBody
    });

    if (!initResp.ok) {
        const text = await initResp.text();
        console.error(`  [upload] init-image failed — URL: ${initUrl}`);
        console.error(`  [upload] Payload: ${initBody}`);
        console.error(`  [upload] Response (${initResp.status}): ${text}`);
        throw new Error(`Leonardo init-image failed (${initResp.status}): ${text}`);
    }

    const initData = await initResp.json();
    console.log(`  [upload] init-image response: ${JSON.stringify(initData)}`);

    // --- Parse the v1 response shape ---------------------------------
    const uploadInfo = initData.uploadInitImage || initData;

    const s3Url    = uploadInfo.url;
    const imageId  = uploadInfo.id;
    let   fields   = {};

    if (uploadInfo.fields) {
        try {
            fields = typeof uploadInfo.fields === 'string'
                ? JSON.parse(uploadInfo.fields)
                : uploadInfo.fields;
        } catch (_e) {
            throw new Error(`init-image fields is not valid JSON: ${uploadInfo.fields}`);
        }
    }

    if (!s3Url) {
        throw new Error(`init-image response missing url: ${JSON.stringify(uploadInfo)}`);
    }
    if (!imageId) {
        throw new Error(`init-image response missing id: ${JSON.stringify(uploadInfo)}`);
    }

    console.log(`  [upload] S3 URL ready — imageId = ${imageId}, ${Object.keys(fields).length} form fields`);

    // ================================================================
    // Step 2 — POST multipart/form-data to the S3 presigned URL
    // ================================================================
    const boundary = '----S3Upload' + Math.random().toString(36).slice(2);
    const parts = [];

    function addField(name, value) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'utf8'
        ));
    }

    for (const [key, value] of Object.entries(fields)) {
        addField(key, value);
    }

    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${originalName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf8'
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    const body = Buffer.concat(parts);

    const postResp = await fetch(s3Url, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body
    });

    if (!postResp.ok) {
        const text = await postResp.text();
        throw new Error(`S3 presigned POST failed (${postResp.status}): ${text}`);
    }

    console.log(`  [upload] S3 POST succeeded — imageId = ${imageId}`);
    return imageId;
}

/**
 * Save a reference image buffer to local disk.
 * Returns the relative path (for database.json) or null on failure.
 */
async function saveReferenceImageLocally(fileBuffer, localGenId, slotNumber, _mimeType) {
    const filename = `ref_${localGenId}_${slotNumber}.jpg`;
    const absPath = path.join(REFERENCES_DIR, filename);
    const relPath = `uploads/references/${filename}`;

    try {
        const jpegBuffer = await convertToJpeg(fileBuffer);
        fs.writeFileSync(absPath, jpegBuffer);
        console.log(`  [local] Saved reference image: ${relPath} (${(jpegBuffer.length / 1024).toFixed(1)} KB)`);
        return relPath;
    } catch (err) {
        console.error(`  [local] Failed to save reference image ${slotNumber}:`, err.message);
        return null;
    }
}

/**
 * Convert an image buffer to JPEG at quality 92 using sharp.
 * Accepts any input format sharp supports (PNG, WebP, GIF, BMP, TIFF, JPEG).
 * Returns a new Buffer — the original buffer is unmodified.
 */
async function convertToJpeg(buffer) {
    return await sharp(buffer)
        .jpeg({ quality: 92 })
        .toBuffer();
}

/**
 * Download a generated image from Leonardo's CDN, compress it into a
 * cover-sized thumbnail via sharp, and save it to /public/uploads/thumbnails/.
 *
 * @param {string} imageUrl  — the Leonardo CDN URL of the generated image
 * @param {string} localGenId — the local generation ID for naming
 * @returns {string|null}     — the relative path to the thumbnail, or null on failure
 */
async function downloadAndThumbnail(imageUrl, localGenId) {
    const thumbFilename = `${localGenId}_thumb.webp`;
    const absPath = path.join(THUMBNAILS_DIR, thumbFilename);
    const relPath = `uploads/thumbnails/${thumbFilename}`;

    try {
        console.log(`  [thumbnail] Downloading generated image from Leonardo CDN…`);
        const resp = await fetch(imageUrl);
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} downloading generated image`);
        }

        const imageBuffer = Buffer.from(await resp.arrayBuffer());
        console.log(`  [thumbnail] Downloaded ${(imageBuffer.length / 1024).toFixed(1)} KB`);

        // Resize + compress to a cover-friendly thumbnail via sharp
        // Target: 640px wide, maintain aspect ratio, WebP at quality 80
        await sharp(imageBuffer)
            .resize({ width: 640, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(absPath);

        const stats = fs.statSync(absPath);
        console.log(`  [thumbnail] Saved thumbnail: ${relPath} (${(stats.size / 1024).toFixed(1)} KB)`);

        return relPath;
    } catch (err) {
        console.error(`  [thumbnail] Failed to create thumbnail:`, err.message);
        return null;
    }
}

/**
 * Build the background-swap generation payload.
 * Uses the Gemini-generated prompts + both S3 image IDs at MID strength.
 */
function buildBackgroundSwapPayload(positivePrompt, negativePrompt, width, height, imageIds) {
    const payload = {
        model: 'nano-banana-2',
        public: false,
        parameters: {
            height,
            width,
            prompt_enhance: 'OFF',
            quantity: 1,
            style_ids: ['111dc692-d470-4eec-b791-3475abac4c46'],
            prompt: positivePrompt
        }
    };

    // Attach negative prompt if provided
    if (negativePrompt && negativePrompt.trim()) {
        payload.parameters.negative_prompt = negativePrompt.trim();
    }

    // Image Reference 1 (Graduate) at HIGH strength for strict character retention
    // Image Reference 2 (Background) at MID strength as style/aesthetic canvas
    if (imageIds.length > 0) {
        payload.parameters.guidances = {
            image_reference: imageIds.map((id, index) => ({
                image: { id, type: 'UPLOADED' },
                strength: index === 0 ? 'HIGH' : 'MID'
            }))
        };
    }

    return payload;
}

/**
 * Build the generation payload for standard text-to-image generation.
 *
 * Used by POST /api/generate — constructs a Leonardo v2 payload with the
 * user's prompt, target dimensions, and any uploaded reference images
 * attached as image_reference guidances at MID strength.
 *
 * @param {string}   prompt   — the user's text prompt (already trimmed)
 * @param {number}   width    — target image width in pixels
 * @param {number}   height   — target image height in pixels
 * @param {string[]} imageIds — Leonardo upload IDs for reference images
 * @returns {object} payload ready for POST /api/rest/v2/generations
 */
function buildGenerationPayload(prompt, width, height, imageIds) {
    const payload = {
        model: 'nano-banana-2',
        public: false,
        parameters: {
            height,
            width,
            prompt_enhance: 'OFF',
            quantity: 1,
            style_ids: ['111dc692-d470-4eec-b791-3475abac4c46'],
            prompt
        }
    };

    // Attach reference images as guidances if any were uploaded
    if (imageIds && imageIds.length > 0) {
        payload.parameters.guidances = {
            image_reference: imageIds.map(id => ({
                image: { id, type: 'UPLOADED' },
                strength: 'MID'
            }))
        };
    }

    return payload;
}

// ------------------------------------------------------------------
// Gemini API helper — Prompt Engineering for Background Swap
// ------------------------------------------------------------------

/**
 * Send BOTH reference images to Gemini and ask it to generate a structured
 * positive + negative prompt for Leonardo.ai's Image Guidance system.
 *
 * Image Reference 1 = The Graduate Subject (character retention priority)
 * Image Reference 2 = The Target Background Canvas (environment reference)
 *
 * The system instruction is LOCKED per the PRD — it must not be changed
 * without updating the prompt-engineering contract.
 *
 * @param {Buffer} imageBuffer1  — raw bytes of Image Reference 1 (Graduate Subject)
 * @param {string} mimeType1     — MIME type of Image Reference 1
 * @param {Buffer} imageBuffer2  — raw bytes of Image Reference 2 (Target Background)
 * @param {string} mimeType2     — MIME type of Image Reference 2
 * @returns {{ positive_prompt: string, negative_prompt: string }}
 */
async function generatePromptsWithGemini(imageBuffer1, mimeType1, imageBuffer2, mimeType2, localGenId) {
    const client = getGeminiClient();
    if (!client) {
        throw new Error('GEMINI_API_KEY is not configured. Set it in .env to use the Background Change.');
    }

    // --- Fast image compression via sharp — reduces base64 payload for Gemini ---
    async function compressImageForGemini(buffer) {
        const compressed = await sharp(buffer)
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
        return compressed;
    }

    const compressedBuffer1 = await compressImageForGemini(imageBuffer1);
    const compressedBuffer2 = await compressImageForGemini(imageBuffer2);

    console.log(`  [gemini] Image compression: Ref1 ${(imageBuffer1.length / 1024).toFixed(0)} KB → ${(compressedBuffer1.length / 1024).toFixed(0)} KB, Ref2 ${(imageBuffer2.length / 1024).toFixed(0)} KB → ${(compressedBuffer2.length / 1024).toFixed(0)} KB`);

    const base64Image1 = compressedBuffer1.toString('base64');
    const base64Image2 = compressedBuffer2.toString('base64');

    // Both images are now JPEG after compression — use consistent MIME type for Gemini
    const geminiMimeType1 = 'image/jpeg';
    const geminiMimeType2 = 'image/jpeg';

    const systemInstruction = `You are an expert AI prompt engineer specialized in advanced image composition pipelines for Leonardo.ai. You will be provided with two images: "Image Reference 1" (The Graduate Subject) and "Image Reference 2" (The Target Background Canvas).

Your absolute rule is to generate a precise Stable Diffusion text prompt to seamlessly blend the subject from Image Reference 1 into the background environment of Image Reference 2. You must strictly adhere to the following 20 analytical instructions:

1. Describe the structural form, architecture, and physical composition of the background in "Image Reference 2" with meticulous detail.
2. Analyze the atmospheric lighting, key lights, shadows, and illumination style setup of "Image Reference 2".
3. Analyze the precise color grading, color palette, and color temperature of "Image Reference 2".
4. Instruct the AI to completely remove and vanish all pre-existing human subjects, figures, or unwanted objects inside "Image Reference 2".
5. Instruct the AI to fully erase and bypass any vendor logos or watermarks present in "Image Reference 2".
6. STRICTLY FORBID adopting, copying, or referencing any clothing styles or garments from the subjects inside "Image Reference 2".
7. STRICTLY FORBID adopting or referencing any graduation gown/robe attributes from "Image Reference 2".
8. STRICTLY FORBID adopting or referencing any toga hat/cap attributes from "Image Reference 2".
9. STRICTLY FORBID adopting or referencing any necklace or collar jewelry attributes from "Image Reference 2".
10. Ensure the reference for the traditional "kebaya" clothing style is taken 100% identically from "Image Reference 1".
11. Ensure the reference for the necklace details and jewelry is taken exactly from "Image Reference 1" (if present).
12. Ensure the reference for the toga hat/cap details is taken exactly from "Image Reference 1" (if present).
13. Ensure the reference for the graduation gown/robe details is taken exactly from "Image Reference 1" (if present).
14. Ensure the reference for the diploma folder/cover details is taken exactly from "Image Reference 1" (if present).
15. Ensure the text details on the diploma folder/cover are rendered clearly and legibly, derived from "Image Reference 1" (if present).
16. Ensure the reference for the graduation sash (selempang) details is taken exactly from "Image Reference 1" (if present).
17. Ensure the text details on the graduation sash (selempang) are rendered sharply and legibly, derived from "Image Reference 1" (if present).
18. Ensure the exact facial expression, features, makeup, and full face details are extracted flawlessly from "Image Reference 1".
19. Explicitly orchestrate image integration inside the final positive prompt by referencing "image 1" and "image 2" to guide Leonardo's guidance engine. Use precise structural directives such as: 'Generate the exact character, facial features, and traditional kebaya outfit strictly from image 1, seamlessly blended into the studio background environment and lighting style from image 2.'
20. Analyze the scale of the background framing in "Image Reference 2" and classify it precisely using one of these photography terms: "long shot", "medium long shot", "medium shot", or "medium closeup". Incorporate this framing term into the positive prompt.

21. Detect the physical interaction and spatial positioning of any human subjects originally inside "Image Reference 2":
    - IF the subject in Image Reference 2 is standing on steps or stairs, explicitly instruct the AI that the subject from Image Reference 1 must be realistically posed standing on those exact steps/stairs with correct footing and perspective.
    - IF the subject in Image Reference 2 is in a sitting/seated pose on a chair, sofa, or bench, explicitly instruct the AI that the subject from Image Reference 1 must be seamlessly generated in a sitting position matching that exact seating furniture.
    - IF the subject in Image Reference 2 is standing on a flat floor, ensure the final prompt reflects a standard full-body standing posture.

22. STRICTLY FORBID generating or adding any extra people, bystanders, crowds, or pedestrians walking around in the frame (prevent background photobombs). Ensure the final image is completely clean, private, and isolated, containing ONLY the single graduation subject derived from "Image Reference 1". Explicitly enforce this by pushing terms like "extra people, background crowd, passersby, photobomb" heavily into the negative prompt.

23. Handle missing footwear information recursively: If "Image Reference 1" does not display or contain any visual information about the subject's footwear (due to being a half-body or medium shot), and the overall composition requires rendering the feet/legs for a full-body generation, you MUST explicitly instruct the AI to equip the subject with elegant, formal graduation high heels ("heels wisuda") that harmoniously match the traditional kebaya color scheme and outfit.

24. Perform semantic text segregation on "Image Reference 2" to filter out metadata text while preserving environmental text:
    - IF a text or logo is identified as a photographer's watermark, copyright signature, vendor branding, or floating corner logo, you MUST completely ban it by explicitly listing "watermark, photographer signature, vendor logo, overlay text" in the negative prompt.
    - IF a text is part of the actual physical environment or architecture in Image Reference 2 (such as a university name on a campus building wall, an iconic landmark sign, or a graduation banner design), you MUST preserve it and describe it naturally in the positive prompt as an environmental element to ensure the AI renders it correctly.

CRITICAL: Keep both the positive and negative prompts concise. Do not exceed 80 words per prompt. Focus only on the most impactful description keywords. Return STRICTLY a valid JSON object containing keys: 'positive_prompt' and 'negative_prompt' adhering to the configured responseSchema. Do not wrap the JSON inside markdown.`;

    console.log(`  [gemini] Sending dual-image input to Gemini (Ref1 compressed: ${(compressedBuffer1.length / 1024).toFixed(1)} KB, Ref2 compressed: ${(compressedBuffer2.length / 1024).toFixed(1)} KB)…`);
    console.log(`  [gemini] Base64-encoded payload sizes — Ref1: ${(base64Image1.length / 1024).toFixed(1)} KB, Ref2: ${(base64Image2.length / 1024).toFixed(1)} KB`);

    // --- Exponential backoff retry for 503 UNAVAILABLE errors ---
    const MAX_RETRIES = 3;
    const GEMINI_REQUEST_TIMEOUT_MS = 120_000; // 2-minute per-request cap
    let response;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Update in-memory status so the frontend polling endpoint can relay retry progress
        if (localGenId && activeGenerations.has(localGenId)) {
            activeGenerations.get(localGenId).status = `RETRYING_ATTEMPT_${attempt}`;
        }

        // Per-attempt AbortController so a single hung request doesn't block retries
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

        try {
            response = await client.models.generateContent({
                model: 'gemini-3.5-flash',
                config: {
                    systemInstruction: systemInstruction,
                    thinking_level: 'low',
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            positive_prompt: { type: "STRING" },
                            negative_prompt: { type: "STRING" }
                        },
                        required: ["positive_prompt", "negative_prompt"]
                    },
                    abortSignal: controller.signal,
                },
                contents: [
                    {
                        inlineData: {
                            mimeType: geminiMimeType1,
                            data: base64Image1
                        }
                    },
                    {
                        text: 'This is "Image Reference 1" — The Graduate Subject. Analyze their face, pose, clothing, graduation attributes, and all personal details that must be preserved.'
                    },
                    {
                        inlineData: {
                            mimeType: geminiMimeType2,
                            data: base64Image2
                        }
                    },
                    {
                        text: 'This is "Image Reference 2" — The Target Background Canvas. Analyze the environment, lighting, architecture, color grading, and classify the shot framing. Then generate the Leonardo.ai prompt JSON as instructed.'
                    }
                ]
            });
            clearTimeout(timeoutId);
            break; // success — exit the retry loop
        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            const isRetryable = err.message?.includes('503') || err.message?.includes('UNAVAILABLE') || err.status === 503 || err.name === 'AbortError' || err.message?.includes('aborted');
            if (isRetryable && attempt < MAX_RETRIES) {
                const delayMs = Math.pow(2, attempt) * 1000; // Exponential: 2s, 4s, 8s, 16s, 32s, 64s, 128s
                console.log(`  [gemini] Retryable error — retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})…`);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                throw err;
            }
        }
    }

    if (!response) {
        throw lastError || new Error('Gemini API call failed after all retries.');
    }

    // Extract text from the Gemini response using the built-in getter
    const rawText = (response.text || '').trim();
    if (!rawText) {
        throw new Error('Gemini returned an empty response — no text content.');
    }

    console.log(`  [gemini] Raw response (${rawText.length} chars): ${rawText.slice(0, 200)}${rawText.length > 200 ? '…' : ''}`);

    // Parse the JSON — aggressively strip any markdown code fences
    let cleaned = rawText;
    // Remove leading ```json or ``` (with optional whitespace/newlines)
    cleaned = cleaned.replace(/^\s*```(?:json)?\s*\n?/i, '');
    // Remove trailing ``` (with optional preceding newlines/whitespace)
    cleaned = cleaned.replace(/\n?\s*```\s*$/i, '');
    // Remove any remaining inline ``` fences that may appear mid-response
    cleaned = cleaned.replace(/```/g, '');
    cleaned = cleaned.trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (parseErr) {
        console.error(`  [gemini] Failed to parse JSON: ${cleaned.slice(0, 300)}`);
        throw new Error(`Gemini did not return valid JSON. Raw: ${cleaned.slice(0, 200)}`);
    }

    if (!parsed.positive_prompt || typeof parsed.positive_prompt !== 'string') {
        throw new Error('Gemini response missing required "positive_prompt" field.');
    }

    console.log(`  [gemini] Extracted positive_prompt (${parsed.positive_prompt.length} chars)`);
    if (parsed.negative_prompt) {
        console.log(`  [gemini] Extracted negative_prompt (${parsed.negative_prompt.length} chars)`);
    }

    return {
        positive_prompt: parsed.positive_prompt,
        negative_prompt: parsed.negative_prompt || ''
    };
}


/**
 * Create a generation on Leonardo and return the Leonardo generation ID.
 */
async function createLeonardoGeneration(payload) {
    console.log(`  [generate] Creating generation (${payload.parameters.width}×${payload.parameters.height})…`);

    const resp = await fetch(`${LEONARDO_BASE_V2}/generations`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Leonardo generation creation failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    const genId = data.generate?.generationId
               || data.sdGenerationJob?.generationId
               || data.generationId
               || data.id;

    if (!genId) {
        throw new Error(`Leonardo generation response missing ID: ${JSON.stringify(data)}`);
    }

    console.log(`  [generate] Created Leonardo generation: ${genId}`);
    return genId;
}

/**
 * Fetch the current status of a Leonardo generation.
 * Returns { status, imageUrl? }
 */
async function fetchLeonardoStatus(leonardoGenId) {
    const statusUrl = `${LEONARDO_BASE_V1}/generations/${leonardoGenId}`;

    const resp = await fetch(statusUrl, {
        method: 'GET',
        headers: authHeaders()
    });

    if (!resp.ok) {
        const text = await resp.text();
        console.error(`  [status] Check failed — URL: ${statusUrl}`);
        console.error(`  [status] Response (${resp.status}): ${text}`);
        throw new Error(`Leonardo status check failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    const gen = data.generate
             || data.generations_by_pk
             || data;

    const result = {
        status: (gen.status || 'PENDING').toUpperCase()
    };

    if (result.status === 'COMPLETE' && gen.generated_images?.length > 0) {
        result.imageUrl = gen.generated_images[0].url;
    }

    if (result.status === 'FAILED') {
        result.error = gen.error || gen.failure_reason || 'Unknown server error';
    }

    return result;
}


/**
 * Background polling loop: checks Leonardo every 5 s until COMPLETE or
 * FAILED, then updates the in-memory store so the frontend sees live data.
 *
 * When COMPLETE, also:
 *   1. Downloads + thumbnails the generated image
 *   2. Writes a structured record to database.json
 */
function startBackgroundPoll(localGenId, leonardoGenId, persistedRefs) {
    const MAX_ATTEMPTS = 72;           // 72 × 5 s = 6 minutes
    let attempts = 0;

    const interval = setInterval(async () => {
        attempts++;

        try {
            const { status, imageUrl, error } = await fetchLeonardoStatus(leonardoGenId);
            const record = activeGenerations.get(localGenId);
            if (!record) { clearInterval(interval); return; }

            record.status = status;

            if (status === 'COMPLETE') {
                record.imageUrl = imageUrl || null;
                console.log(`  [poll] ${localGenId} → COMPLETE`);
                clearInterval(interval);

                // --- Post-generation: Cloudinary upload + metadata + MongoDB write ---
                if (imageUrl) {
                    // Upload the Leonardo image to Cloudinary for permanent storage
                    let cloudinaryUrl = imageUrl;  // fallback: original Leonardo URL
                    try {
                        const genResp = await fetch(imageUrl);
                        if (genResp.ok) {
                            const genBuffer = Buffer.from(await genResp.arrayBuffer());
                            const cloudinaryUpload = await db.uploadToCloudinary(genBuffer, 'generations', localGenId);
                            if (cloudinaryUpload && cloudinaryUpload.url) {
                                cloudinaryUrl = cloudinaryUpload.url;
                                console.log(`  [cloudinary] Image uploaded → ${cloudinaryUrl}`);
                            } else {
                                console.warn(`  [cloudinary] Upload returned no URL — using Leonardo CDN fallback`);
                            }
                        }
                    } catch (err) {
                        console.error(`  [cloudinary] Upload failed, using Leonardo URL:`, err.message);
                    }

                    // Title: STRICTLY use frontend-provided title, NEVER use prompt as title
                    // Priority: record._title > record.filterTitle > fallback
                    const title = record._title || record.filterTitle || 'Untitled';

                    // Tags: STRICTLY use frontend-provided tags array
                    // Priority: record._tags (from req.body.tags) > individual fields
                    let tags = [];
                    if (Array.isArray(record._tags) && record._tags.length > 0) {
                        tags = record._tags;
                    } else {
                        if (record.selected_tag) tags.push(record.selected_tag);
                        if (record.lighting) tags.push(record.lighting);
                    }

                    // Ratio / dimensions: use frontend-provided ratio if available
                    const ratioLabel = record._ratio || dimensionToRatioLabel(record.width, record.height);

                    // Determine owner_email
                    let ownerEmail = record._userEmail || null;
                    const isAdminType = record._adminSave || (!record._publicUser && (record.type === 'filter-swap' || record.type === 'filter-factory'));
                    if (isAdminType) ownerEmail = ADMIN_EMAIL;
                    if (!ownerEmail && record._safeEmailPrefix) {
                        ownerEmail = record._userEmail || record._safeEmailPrefix || null;
                    }

                    // Targeted update: only set fields that changed during polling.
                    // Preserves owner_email, email, and other fields set at placeholder creation.
                    const updateFields = {
                        status: 'COMPLETE',
                        image_url: cloudinaryUrl,
                        cover_image_url: cloudinaryUrl,
                        prompt: record.prompt || '',  // full prompt — overwrites any truncated placeholder
                        title: title,
                        filterTitle: record.filterTitle || '',
                        tags: tags,
                        selected_tag: record.selected_tag || '',
                        lighting: record.lighting || '',
                        width: record.width || 1024,
                        height: record.height || 1024,
                        dimensions: ratioLabel,
                        ratio: record._ratio || ratioLabel,
                        reference_image_1_path: persistedRefs?.ref1 || null,
                        reference_image_2_path: persistedRefs?.ref2 || null
                        // NOTE: Do NOT set reference_image_*_url here.
                        // The immediate Cloudinary upload in the endpoint handler already
                        // set these URLs. If we include them as empty strings, a failed
                        // re-upload below would overwrite the good URL with ''.
                    };

                    // Upload reference images to Cloudinary so they survive redeploys.
                    // This is a fallback — the endpoint handler already did an immediate
                    // upload, but if that was skipped (legacy records), try again here.
                    for (const [idx, refPath] of [[1, persistedRefs?.ref1], [2, persistedRefs?.ref2]]) {
                        if (!refPath) continue;
                        const absRefPath = path.join(__dirname, refPath);
                        if (fs.existsSync(absRefPath)) {
                            try {
                                const refBuffer = fs.readFileSync(absRefPath);
                                const refUpload = await db.uploadToCloudinary(refBuffer, 'references', `ref_${localGenId}_${idx}`);
                                if (refUpload && refUpload.url) {
                                    updateFields[`reference_image_${idx}_url`] = refUpload.url;
                                    console.log(`  [cloudinary] Ref image ${idx} uploaded → ${refUpload.url}`);
                                }
                            } catch (refErr) {
                                console.error(`  [cloudinary] Ref image ${idx} upload failed:`, refErr.message);
                            }
                        }
                    }
                    // Only set owner_email if we have a non-empty value (don't overwrite with empty)
                    if (ownerEmail) {
                        updateFields.owner_email = ownerEmail;
                    }

                    await db.Generation.findOneAndUpdate(
                        { generation_id: localGenId },
                        { $set: updateFields },
                        { returnDocument: 'after' }
                    );
                    console.log(`  [poll] MongoDB updated → ${localGenId} (title: "${title}", tags: [${tags.join(', ')}], ratio: ${ratioLabel})`);
                }
            } else if (status === 'FAILED') {
                record.error = error || 'Generation failed on Leonardo';
                console.log(`  [poll] ${localGenId} → FAILED: ${record.error}`);
                clearInterval(interval);
                // Update the DB placeholder so the frontend stops polling on reload
                upsertDatabaseRecord({
                    generation_id: localGenId,
                    status: 'failed',
                    error: record.error
                });
            } else {
                console.log(`  [poll] ${localGenId} → ${status} (attempt ${attempts})`);
            }
        } catch (err) {
            console.error(`  [poll] ${localGenId} error:`, err.message);
        }

        if (attempts >= MAX_ATTEMPTS) {
            clearInterval(interval);
            const record = activeGenerations.get(localGenId);
            if (record && record.status !== 'COMPLETE' && record.status !== 'FAILED') {
                record.status = 'FAILED';
                record.error = 'Generation timed out after 6 minutes';
                console.log(`  [poll] ${localGenId} → TIMED OUT`);
                // Update the DB placeholder so the frontend stops polling on reload
                upsertDatabaseRecord({
                    generation_id: localGenId,
                    status: 'failed',
                    error: record.error
                });
            }
        }
    }, 5000);
}

/**
 * Map pixel dimensions back to a standard aspect-ratio label for display.
 */
function dimensionToRatioLabel(width, height) {
    const ratio = width / height;
    if      (Math.abs(ratio - (2 / 3))  < 0.05) return '2:3';
    else if (Math.abs(ratio - (4 / 5))  < 0.05) return '4:5';
    else if (Math.abs(ratio - (4 / 3))  < 0.05) return '4:3';
    else if (Math.abs(ratio - (16 / 9)) < 0.05) return '16:9';
    else if (Math.abs(ratio - (1 / 1))  < 0.05) return '1:1';
    else return `${width}×${height}`;
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

/**
 * POST /api/generate
 * ------------------------------------------------------------------
 * Direct-to-Leonardo filter factory: takes a raw user prompt + optional
 * reference images, feeds them straight into Leonardo AI (no Gemini/Claude
 * prompt refinement), and returns immediately (async background job).
 *
 * Accepts multipart/form-data:
 *   prompt          (text, required)
 *   filterTitle     (text, required)  — custom preset name ("Judul Filter Kustom")
 *   width           (text, required)
 *   height          (text, required)
 *   selected_tag    (text, optional)  — "Studio" | "Indoor" | "Outdoor"
 *   referenceImage1 (file, optional)
 *   referenceImage2 (file, optional)
 *
 * Returns 202 { jobId } — the client should redirect to /my-creations.
 *
 * v2.1 — Gemini/Claude removed; preset prompts flow through unmodified.
 */
app.post('/api/generate', upload.fields([
    { name: 'referenceImage1', maxCount: 1 },
    { name: 'referenceImage2', maxCount: 1 }
]), async (req, res) => {
    try {
        // --- Validate API key ------------------------------------------
        if (!LEONARDO_API_KEY) {
            return res.status(500).json({
                error: 'Server not configured. Set LEONARDO_API_KEY in .env'
            });
        }

        // --- Parse fields ----------------------------------------------
        const { prompt, filterTitle, width, height, selected_tag, lighting } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'Prompt is required.' });
        }
        const w = parseInt(width, 10);
        const h = parseInt(height, 10);
        if (!w || !h || w < 64 || h < 64) {
            return res.status(400).json({ error: 'Valid width and height are required.' });
        }

        // --- Prompt is used EXACTLY as provided — no auto-injection ----
        // Tags/lighting are saved for UI filtering only, NOT for prompt mutation.
        let finalPrompt = prompt.trim();

        console.log(`\n=== New generation request ===`);
        console.log(`  Prompt: "${finalPrompt.slice(0, 80)}${finalPrompt.length > 80 ? '…' : ''}"`);
        console.log(`  Dimensions: ${w}×${h}`);
        console.log(`  Filter title: "${filterTitle || '(none)'}"`);
        console.log(`  Lighting: "${lighting || 'none'}"`);

        // --- Capture user email early (needed for placeholder + file naming) ---
        const userEmail = req.headers['x-user-email'] || req.body.email || '';

        // --- Generate local tracking ID early (needed for file naming) --
        const localGenId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Immediately persist a processing placeholder so the frontend can find it
        insertProcessingPlaceholder(localGenId, 'filter-factory', finalPrompt, w, h, userEmail);

        // Will hold relative paths to locally saved reference images
        const persistedRefs = { ref1: null, ref2: null };

        // --- Upload reference images to Leonardo AND save locally ------
        const imageIds = [];
        const fileFields = ['referenceImage1', 'referenceImage2'];

        for (let i = 0; i < fileFields.length; i++) {
            const fieldName = fileFields[i];
            const files = req.files?.[fieldName];
            if (files && files.length > 0) {
                const file = files[0];

                // 1) Save a local copy for the Admin Gallery
                const slot = i + 1;
                const localPath = await saveReferenceImageLocally(
                    file.buffer, localGenId, slot, file.mimetype
                );
                if (slot === 1) persistedRefs.ref1 = localPath;
                else            persistedRefs.ref2 = localPath;

                // 2) Upload to Leonardo for generation use
                try {
                    const id = await uploadImageToLeonardo(
                        file.buffer,
                        file.originalname,
                        file.mimetype
                    );
                    imageIds.push(id);
                } catch (err) {
                    console.error(`  Upload failed for ${fieldName}:`, err.message);
                }

                // 3) Immediately upload reference image to Cloudinary
                //    so the "Before" image survives Hostinger redeploys
                //    (local ephemeral storage is wiped on every deploy).
                try {
                    const refUpload = await db.uploadToCloudinary(file.buffer, 'references', `ref_${localGenId}_${slot}`);
                    if (refUpload && refUpload.url) {
                        await db.Generation.findOneAndUpdate(
                            { generation_id: localGenId },
                            { $set: { [`reference_image_${slot}_url`]: refUpload.url } }
                        );
                        console.log(`  [cloudinary] Ref image ${slot} uploaded → ${refUpload.url}`);
                    }
                } catch (uploadErr) {
                    console.error(`  [cloudinary] Ref image ${slot} upload failed (non-fatal):`, uploadErr.message);
                }
            }
        }

        console.log(`  Reference image IDs: [${imageIds.join(', ')}]`);

        // --- Create the Leonardo generation ----------------------------
        const payload = buildGenerationPayload(finalPrompt, w, h, imageIds);
        const leonardoGenId = await createLeonardoGeneration(payload);

        // --- Capture safe email prefix for file-prefix isolation ---
        const safeEmailPrefix = sanitizeEmail(userEmail);
        console.log(`  User email: ${userEmail} → prefix: ${safeEmailPrefix}`);

        // --- Store in active generations map ---------------------------
        activeGenerations.set(localGenId, {
            leonardoGenId,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: finalPrompt,
            filterTitle: filterTitle || '',
            selected_tag: selected_tag || 'Studio',
            lighting: lighting || '',
            type: 'filter-factory',
            width: w,
            height: h,
            createdAt: Date.now(),
            _userEmail: userEmail,
            _safeEmailPrefix: safeEmailPrefix
        });

        // --- Kick off background polling (with persistedRefs for DB) ---
        startBackgroundPoll(localGenId, leonardoGenId, persistedRefs);

        // --- Respond to the client (async — 202 Accepted) -------------
        console.log(`  → 202 Accepted — jobId: ${localGenId}\n`);
        res.status(202).json({ jobId: localGenId });

    } catch (err) {
        console.error('[/api/generate] Unexpected error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * GET /api/status/:generationId
 * ------------------------------------------------------------------
 * Returns the current status of a generation from the in-memory store.
 */
app.get('/api/status/:generationId', async (req, res) => {
    const { generationId } = req.params;
    const record = activeGenerations.get(generationId);

    if (!record) {
        // Fallback: check the database for a failed/timed-out record
        const db = await readDatabase();
        const dbRecord = db.find(r => r.generation_id === generationId);
        if (dbRecord && (dbRecord.status === 'FAILED' || dbRecord.status === 'failed'
                      || dbRecord.status === 'COMPLETE' || dbRecord.status === 'complete')) {
            const isFailed = dbRecord.status === 'FAILED' || dbRecord.status === 'failed';
            return res.json({
                status: isFailed ? 'FAILED' : 'COMPLETE',
                imageUrl: dbRecord.image_url || undefined,
                error: dbRecord.error || undefined,
                createdAt: dbRecord.created_at ? new Date(dbRecord.created_at).getTime() : undefined
            });
        }
        return res.status(404).json({
            status: 'UNKNOWN',
            error: 'Generation ID not found. It may have expired or never existed.'
        });
    }

    res.json({
        status: record.status,
        imageUrl: record.imageUrl || undefined,
        error: record.error || undefined,
        createdAt: record.createdAt || undefined
    });
});

/**
 * GET /api/active-generations
 * ------------------------------------------------------------------
 * Returns all in-progress generations from the in-memory store so the
 * frontend can resume polling + stopwatch after a page reload.
 */
app.get('/api/active-generations', (_req, res) => {
    const active = [];
    for (const [genId, record] of activeGenerations) {
        if (record.status === 'PENDING' || record.status === 'PROCESSING') {
            active.push({
                generationId: genId,
                status: record.status,
                type: record.type || 'unknown',
                prompt: (record.prompt || '').slice(0, 80),
                createdAt: record.createdAt || Date.now(),
                isAdmin: record._adminSave === true,
                isPublic: record._publicUser === true
            });
        }
    }
    res.json({ active });
});

// ------------------------------------------------------------------
// Admin Gallery API endpoints
// ------------------------------------------------------------------

/**
 * GET /api/gallery
 * ------------------------------------------------------------------
 * Returns all stored generation records from database.json, ordered
 * newest-first by created_at.
 *
 * Query params:
 *   ?limit=N   — cap results (default 50)
 *   ?offset=N  — pagination offset (default 0)
 */
app.get('/api/gallery', async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        // Query MongoDB: exclude admin-owned and user-generated types
        // Keep filter-factory records + processing placeholders
        const query = {
            owner_email: { $ne: ADMIN_EMAIL },
            type: { $nin: ['bgswap', 'dress-swap', 'filter-swap'] }
        };
        // Also include processing records regardless of owner
        const processingRecords = await db.Generation.find({ status: 'processing' }).lean();
        const mainRecords = await db.Generation.find(query)
            .sort({ created_at: -1 })
            .lean();

        // Merge + deduplicate
        const seen = new Set();
        const merged = [];
        for (const r of [...processingRecords, ...mainRecords]) {
            if (seen.has(r.generation_id)) continue;
            seen.add(r.generation_id);
            merged.push(r);
        }
        merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const total = merged.length;
        const page  = merged.slice(offset, offset + limit);

        res.json({ total, limit, offset, records: page });
    } catch (err) {
        console.error('[/api/gallery] Error:', err);
        res.status(500).json({ error: 'Failed to read gallery records' });
    }
});

/**
 * GET /api/user-creations
 * ------------------------------------------------------------------
 * Returns generation records created by public users from the three
 * generator pages: /swap-bg, /dress-swap, and /filter-gallery.
 * These records are isolated from the admin gallery and the legacy
 * public gallery — they are displayed exclusively on /my-creations.
 *
 * Query params:
 *   ?email=N   — sanitize and filter by email prefix (filesystem-based isolation).
 *                When provided, reads files from user_data_image_generate/ directly.
 *                Guest users or missing email returns empty array [].
 *   ?limit=N   — cap results (default 50, DB mode only)
 *   ?offset=N  — pagination offset (default 0, DB mode only)
 */
app.get('/api/user-creations', async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const rawEmail = req.query.email || '';
        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        // Build MongoDB query: user-generated types, exclude admin-owned records.
        // For user-specific queries, match on EITHER the 'email' field OR the
        // 'owner_email' field — records created via the filter gallery may have
        // the user email in one field but not the other depending on the code path.
        const query = {
            owner_email: { $ne: ADMIN_EMAIL },
            type: { $in: ['bgswap', 'dress-swap', 'filter-swap', 'filter-factory'] },
            status: 'COMPLETE'
        };

        if (rawEmail) {
            const key = rawEmail.trim().toLowerCase();
            if (!key || key === 'guest_user') return res.json([]);
            // Match on both email and owner_email so no records are missed
            query.$or = [
                { email: key },
                { owner_email: key }
            ];
        }

        const records = await db.Generation.find(query)
            .sort({ created_at: -1 })
            .skip(offset)
            .limit(limit)
            .lean();

        // Map to the exact shape the frontend expects:
        // raw array of { id, url, name, createdAt }
        const creations = records.map(r => ({
            id: r.generation_id,
            url: r.image_url || r.cover_image_url || '',
            name: (r.title || r.prompt || r.generation_id || '').slice(0, 60),
            createdAt: r.created_at
        }));

        console.log(`  [api/user-creations] ${rawEmail || '(all users)'} → ${creations.length} records`);
        res.json(creations);
    } catch (err) {
        console.error('[/api/user-creations] Error:', err);
        res.status(500).json({ error: 'Failed to read user creation records' });
    }
});

/**
 * GET /api/user-creations-files
 * ------------------------------------------------------------------
 * Scans the local user_data_image_generate directory and returns
 * every saved image file as a lightweight gallery record, sorted
 * newest-first by filesystem modification time.
 *
 * Query params:
 *   ?email=N   — sanitize and filter files by email prefix
 *                (e.g. "siti@gmail.com" → only files starting with "siti_gmail_com_")
 *                If omitted or "guest_user", returns empty array [].
 *
 * This endpoint is a direct filesystem view — it complements the
 * database-driven /api/user-creations endpoint.
 */
app.get('/api/user-creations-files', async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const rawEmail = req.query.email || '';
        if (!rawEmail) return res.json([]);

        const key = rawEmail.trim().toLowerCase();

        // Query MongoDB for this user's generations that have an image_url
        const records = await db.Generation.find({
            email: key,
            image_url: { $ne: '', $exists: true }
        })
            .sort({ created_at: -1 })
            .lean();

        const creations = records.map(r => ({
            id: r.generation_id,
            url: r.image_url || r.cover_image_url || '',
            name: (r.prompt || r.generation_id || '').slice(0, 60),
            createdAt: r.created_at
        }));

        console.log(`  [user-creations-files] ${key} → ${creations.length} records from MongoDB`);
        res.json(creations);
    } catch (err) {
        console.error('[/api/user-creations-files] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve creations' });
    }
});

/**
 * DELETE /api/gallery/:id
 * ------------------------------------------------------------------
 * Deletes a generation record and its associated local files
 * (cover thumbnail + reference images).
 *
 * Returns { deleted: true } on success, 404 if not found.
 */
app.delete('/api/gallery/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await removeFromDatabase(id);

        if (!deleted) {
            return res.status(404).json({
                error: 'Generation record not found.',
                generation_id: id
            });
        }

        res.json({ deleted: true, generation_id: id });
    } catch (err) {
        console.error('[/api/gallery/:id] Error:', err);
        res.status(500).json({ error: 'Failed to delete gallery record' });
    }
});

/**
 * PATCH /api/creations/:id/toggle-favorite
 * ------------------------------------------------------------------
 * Toggles the isFavorite boolean flag on a creation record.
 * Returns the new favorite state.
 */
app.patch('/api/creations/:id/toggle-favorite', async (req, res) => {
    try {
        const { id } = req.params;
        const db = await readDatabase();
        const record = db.find(r => r.generation_id === id);

        if (!record) {
            return res.status(404).json({ error: 'Creation not found.', generation_id: id });
        }

        // Normalize: old records may not have the isFavorite field yet
        const currentState = record.isFavorite === true;
        record.isFavorite = !currentState;
        writeDatabase(db);

        console.log(`  [db] Toggled favorite for ${id} → ${record.isFavorite}`);
        res.json({ success: true, generation_id: id, isFavorite: record.isFavorite });
    } catch (err) {
        console.error('[/api/creations/:id/toggle-favorite] Error:', err);
        res.status(500).json({ error: 'Failed to toggle favorite' });
    }
});

// ------------------------------------------------------------------
// Background Change API endpoints
// ------------------------------------------------------------------

/**
 * Execute the heavy background-swap pipeline asynchronously AFTER the
 * 202 Accepted response has already been sent to the frontend.
 *
 * This function is fire-and-forget — it runs entirely in the background,
 * updating the in-memory activeGenerations store as it progresses so
 * the frontend polling endpoint can relay live status to the user.
 *
 * @param {string} localGenId   — local tracking ID (already stored in activeGenerations)
 * @param {object} file1        — multer file object for Reference 1 (Graduate)
 * @param {object} file2        — multer file object for Reference 2 (Background)
 * @param {number} w            — target pixel width
 * @param {number} h            — target pixel height
 * @param {string} localPath1   — local disk path for Reference 1
 * @param {string} localPath2   — local disk path for Reference 2
 * @param {string[]} imageIds   — Leonardo upload image IDs [ref1Id, ref2Id]
 */
async function executeBackgroundSwapPipeline(localGenId, file1, file2, w, h, localPath1, localPath2, imageIds) {
    try {
        // --- Step A: Gemini prompt generation ----------------------------
        console.log(`  [bg-swap] Generating prompts via Gemini from dual-image input…`);
        activeGenerations.get(localGenId).status = 'PROMPT_GENERATION';

        const { positive_prompt, negative_prompt } = await generatePromptsWithGemini(
            file1.buffer,
            file1.mimetype,
            file2.buffer,
            file2.mimetype,
            localGenId
        );

        // --- Step B: Build Leonardo payload ------------------------------
        const payload = buildBackgroundSwapPayload(
            positive_prompt,
            negative_prompt,
            w, h,
            imageIds
        );

        console.log(`  [bg-swap] Final positive_prompt: ${positive_prompt.slice(0, 120)}${positive_prompt.length > 120 ? '…' : ''}`);
        if (negative_prompt) {
            console.log(`  [bg-swap] Final negative_prompt: ${negative_prompt.slice(0, 120)}${negative_prompt.length > 120 ? '…' : ''}`);
        }

        // --- Step C: Create Leonardo generation --------------------------
        const leonardoGenId = await createLeonardoGeneration(payload);

        // --- Step D: Update in-memory store + start polling --------------
        // Preserve email from the initial placeholder record
        const prevRecord = activeGenerations.get(localGenId);
        const userEmail = (prevRecord && prevRecord._userEmail) || '';
        const safeEmailPrefix = (prevRecord && prevRecord._safeEmailPrefix) || sanitizeEmail(userEmail);

        activeGenerations.set(localGenId, {
            leonardoGenId,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: positive_prompt,
            type: 'background-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _publicUser: true,    // route to /my-creations, never stamp admin email
            _userSave: true,      // save generated image to user_data_image_generate
            _userEmail: userEmail,
            _safeEmailPrefix: safeEmailPrefix
        });

        const persistedRefs = { ref1: localPath1, ref2: localPath2 };
        startBackgroundPoll(localGenId, leonardoGenId, persistedRefs);

        console.log(`  [bg-swap] Background pipeline launched — ${localGenId} now polling Leonardo\n`);

    } catch (err) {
        console.error(`  [bg-swap] Background pipeline FAILED for ${localGenId}:`, err.message);
        const record = activeGenerations.get(localGenId);
        if (record) {
            record.status = 'FAILED';
            record.error = err.message || 'Background pipeline failed';
        }
    }
}

/**
 * POST /api/background-swap
 * ------------------------------------------------------------------
 * Async background-job orchestration pipeline for the Background Change.
 *
 * Accepts multipart/form-data with:
 *   referenceImage1  (file, required) — The Graduate (subject)
 *   referenceImage2  (file, required) — Target Background
 *   aspectRatio      (text, required) — "2:3" | "4:5" | "4:3"
 *   width            (text, required) — pixel width
 *   height           (text, required) — pixel height
 *
 * Pipeline:
 *   1. Validate inputs & upload both images to Leonardo
 *   2. Save local copies to /public/uploads/references/
 *   3. Return 202 Accepted with jobId IMMEDIATELY (non-blocking)
 *   4. BACKGROUND: Gemini prompt generation → Leonardo generation → polling
 */
app.post('/api/background-swap', upload.fields([
    { name: 'referenceImage1', maxCount: 1 },
    { name: 'referenceImage2', maxCount: 1 }
]), validateAndDeductCredits, async (req, res) => {
    // Extend timeout to 15 minutes so exponential backoff retries (up to 8 attempts)
    // can complete without the local server cutting off the connection
    req.setTimeout(900000);

    try {
        // --- Validate API keys ---------------------------------------
        if (!LEONARDO_API_KEY) {
            return res.status(500).json({
                error: 'Server not configured. Set LEONARDO_API_KEY in .env'
            });
        }
        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                error: 'Server not configured. Set GEMINI_API_KEY in .env to use the Background Change.'
            });
        }

        // --- Parse fields --------------------------------------------
        const { aspectRatio, width, height } = req.body;
        const w = parseInt(width, 10);
        const h = parseInt(height, 10);
        if (!w || !h || w < 64 || h < 64) {
            return res.status(400).json({ error: 'Valid width and height are required.' });
        }

        // --- Validate both reference images are present ---------------
        const file1 = req.files?.referenceImage1?.[0];
        const file2 = req.files?.referenceImage2?.[0];

        if (!file1) {
            return res.status(400).json({ error: 'Image Reference 1 (The Graduate) is required.' });
        }
        if (!file2) {
            return res.status(400).json({ error: 'Image Reference 2 (Target Background) is required.' });
        }

        console.log(`\n=== Background Swap request ===`);
        console.log(`  Aspect Ratio: ${aspectRatio || 'N/A'} → ${w}×${h}`);
        console.log(`  Reference 1 (Graduate): ${file1.originalname} (${(file1.size / 1024).toFixed(1)} KB)`);
        console.log(`  Reference 2 (Background): ${file2.originalname} (${(file2.size / 1024).toFixed(1)} KB)`);

        // --- Generate local tracking ID -------------------------------
        const localGenId = `bgswap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const userEmail = req.headers['x-user-email'] || req.body.email || '';
        insertProcessingPlaceholder(localGenId, 'bgswap', 'Background Swap', w, h, userEmail);

        // --- Step 1: Save both files locally --------------------------
        const localPath1 = await saveReferenceImageLocally(file1.buffer, localGenId, 1, file1.mimetype);
        const localPath2 = await saveReferenceImageLocally(file2.buffer, localGenId, 2, file2.mimetype);

        // --- Step 2: Upload both to Leonardo (concurrently) -----------
        console.log(`  [bg-swap] Uploading both reference images to Leonardo…`);

        const [imageId1, imageId2] = await Promise.all([
            uploadImageToLeonardo(file1.buffer, file1.originalname, file1.mimetype),
            uploadImageToLeonardo(file2.buffer, file2.originalname, file2.mimetype)
        ]);

        console.log(`  [bg-swap] Leonardo image IDs — Ref1: ${imageId1}, Ref2: ${imageId2}`);
        const imageIds = [imageId1, imageId2];

        // --- Step 3: Seed in-memory store & return 202 immediately -------
        // Store initial placeholder so the frontend can begin polling right away
        const safeEmailPrefix = sanitizeEmail(userEmail);
        console.log(`  [bg-swap] User email: ${userEmail} → prefix: ${safeEmailPrefix}`);

        activeGenerations.set(localGenId, {
            leonardoGenId: null,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: '',
            type: 'background-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _userEmail: userEmail,
            _safeEmailPrefix: safeEmailPrefix
        });

        // Fire-and-forget: the heavy pipeline runs in the background while
        // the frontend is already redirecting to Creations for live polling.
        executeBackgroundSwapPipeline(
            localGenId, file1, file2, w, h, localPath1, localPath2, imageIds
        );

        console.log(`  [bg-swap] → 202 Accepted — localGenId: ${localGenId}\n`);
        res.status(202).json({ generationId: localGenId, status: 'PENDING' });

    } catch (err) {
        console.error('[/api/background-swap] Unexpected error:', err);
        // Refund credits on failure
        if (req.creditCost && req.creditEmail) {
            await refundCredits(req.creditEmail, req.creditCost);
        }
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * GET /api/background-swap/status/:generationId
 * ------------------------------------------------------------------
 * Returns the current status of a background-swap generation.
 * Reuses the same in-memory activeGenerations store.
 */
app.get('/api/background-swap/status/:generationId', (req, res) => {
    const { generationId } = req.params;
    const record = activeGenerations.get(generationId);

    if (!record) {
        return res.status(404).json({
            status: 'UNKNOWN',
            error: 'Generation ID not found. It may have expired or never existed.'
        });
    }

    res.json({
        status: record.status,
        imageUrl: record.imageUrl || undefined,
        error: record.error || undefined
    });
});

// ------------------------------------------------------------------
// Dress Replicate API endpoints
// ------------------------------------------------------------------

/**
 * Send BOTH reference images to Gemini for the Dress Swap pipeline.
 *
 * Image Reference 1 = The Base Identity & Background (environment retention priority)
 * Image Reference 2 = The Target Fashion/Dress Reference (fabric extraction priority)
 *
 * Rules A-D per the Dress Swap PRD:
 *   Rule A: Detailed fabric extraction — meticulously analyze texture, pattern,
 *           drape, material type, color, and embellishments from Image Ref 2.
 *   Rule B: Environment retention — preserve the original background, lighting,
 *           and scene composition from Image Ref 1 exactly as-is.
 *   Rule C: Identity preservation — retain the person's face, body proportions,
 *           pose, and skin tones from Image Ref 1 with zero alteration.
 *   Rule D: Strict Islamic hijab fallback — if Image Ref 1 contains a hijab
 *           (headscarf), it MUST be preserved exactly and must NOT be replaced
 *           or modified by any garment from Image Ref 2. The hijab takes
 *           precedence over the dress transfer.
 *
 * @param {Buffer} imageBuffer1  — raw bytes of Image Reference 1 (Identity & BG)
 * @param {string} mimeType1     — MIME type of Image Reference 1
 * @param {Buffer} imageBuffer2  — raw bytes of Image Reference 2 (Fashion Ref)
 * @param {string} mimeType2     — MIME type of Image Reference 2
 * @param {string} [localGenId]  — optional local generation ID for updating in-memory retry status
 * @returns {{ positive_prompt: string, negative_prompt: string }}
 */
async function generateDressSwapPromptsWithGemini(imageBuffer1, mimeType1, imageBuffer2, mimeType2, localGenId) {
    const client = getGeminiClient();
    if (!client) {
        throw new Error('GEMINI_API_KEY is not configured. Set it in .env to use the Dress Replicate.');
    }

    const base64Image1 = imageBuffer1.toString('base64');
    const base64Image2 = imageBuffer2.toString('base64');

    const systemInstruction = `You are an expert AI prompt engineer specialized in advanced outfit/dress transfer pipelines for Leonardo.ai. You will be provided with two images: "Image Reference 1" (The Base Identity & Background) and "Image Reference 2" (The Target Fashion/Dress Reference).

Your absolute rule is to generate a precise Stable Diffusion text prompt to seamlessly transfer the clothing and outfit from Image Reference 2 onto the person in Image Reference 1, while preserving the person's identity and the original background environment. You must strictly adhere to the following analytical instructions:

RULE A — DETAILED FABRIC EXTRACTION (from Image Reference 2):
1. Analyze and describe every garment visible in "Image Reference 2" with meticulous detail: fabric type, textile weave pattern, material sheen (matte/satin/glossy), opacity, and thickness.
2. Extract the exact color palette of each garment, including primary color, secondary accents, embroidery thread colors, and any gradient or ombré effects.
3. Describe the pattern design precisely: floral motifs, geometric patterns, batik parang/kawung motifs, songket brocade textures, lace perforation density, beadwork placement, and sequin distribution.
4. Analyze the structural cut and silhouette: neckline shape, sleeve length and style, bodice fit (fitted/loose/A-line), skirt length and volume, any peplum or draping elements.
5. Document all embellishments: bead clusters, rhinestone placements, embroidery stitching style, lace trim edges, ribbon ties, button details, and brooch/pin accessories.
6. Describe how the fabric drapes and folds — identify gravity-affected areas, wrinkle patterns at joints (elbows, waist), and how the material catches light.
7. Extract any text or logo details that appear on the clothing itself (brand labels, embroidery text on sashes) and preserve them verbatim.

RULE B — ENVIRONMENT RETENTION (from Image Reference 1):
8. Analyze and describe the complete background environment, architecture, and setting from "Image Reference 1" with meticulous detail.
9. Extract the precise lighting conditions: key light direction, fill light intensity, color temperature (warm/cool/neutral), shadow softness, and any rim or hair lighting.
10. Document the color grading and atmospheric effects: haze, vignette strength, contrast ratio, saturation level, and any film-grain or post-processing style.
11. STRICTLY PRESERVE the entire background from Image Reference 1 exactly as-is — no background elements from Image Reference 2 may leak into the final composition.
12. Preserve all environmental objects: furniture, plants, architectural elements, floor textures, wall colors, and any props visible in Image Reference 1.

RULE C — IDENTITY PRESERVATION (from Image Reference 1):
13. STRICTLY PRESERVE the person's exact facial features, facial structure, skin tone, makeup style, and expression from Image Reference 1 with zero alteration.
14. STRICTLY PRESERVE the person's body proportions, height, build, and pose/posture from Image Reference 1 exactly.
15. STRICTLY PRESERVE any visible skin details: beauty marks, freckles, scars, or tattoos from Image Reference 1.
16. STRICTLY PRESERVE the person's hairstyle, hair color, hair texture, and any hair accessories from Image Reference 1.
17. Analyze and strictly preserve the overall body pose and posture of the subject.
18. Analyze and describe the exact positioning, gesture, and action of the subject's right hand.
19. Analyze and describe the exact positioning, gesture, and action of the subject's left hand.
20. Analyze and lock the eye gaze direction (e.g., looking directly at the camera, looking away).
21. Analyze and maintain the exact mouth shape and facial expression (e.g., closed-mouth smile, subtle grin).
22. Analyze the specific shape, design, and color of the necklace worn by the subject (if present) and describe it to ensure it is replicated accurately.

RULE D — CONDITIONAL ISLAMIC/HIJAB LOGIC:
23. Hijab and Modesty Modifiers: If the subject in "Image Reference 1" is wearing a hijab, you MUST automatically implement a modesty modification:
    a. Add a full-coverage inner lining base layer (pakaian dalam manset) underneath the kebaya/dress. The color of this manset layer MUST perfectly match the primary color theme and fabric undertone of the new dress/kebaya from "Image Reference 2".
    b. Add a neat, tightly wrapped formal hijab style (hijab model cekek leher). The color of the hijab MUST perfectly match the primary color theme and coordinate elegantly with the new dress/kebaya from "Image Reference 2".

COMPOSITION RULES:
24. Generate the final prompt by describing the complete scene: "The exact person from Image Reference 1, with their precise face, body, and pose, now wearing the [detailed garment description from Image Reference 2], standing in the exact preserved background environment from Image Reference 1 with its original lighting and atmosphere."
25. Use the Leonardo guidance syntax: reference the person and background from "image 1" and the clothing/fabric details from "image 2" to guide Leonardo's image guidance engine.
26. Analyze the shot framing in Image Reference 1 and classify it precisely: "long shot", "medium long shot", "medium shot", or "medium closeup". Incorporate this framing term into the positive prompt.
27. STRICTLY FORBID generating additional people, mannequins, or figures in the background. Add "extra people, background crowd, mannequin, additional person, photobomb" to the negative prompt.
28. For any body parts not clearly visible in Image Reference 1 (e.g., feet, hands at certain angles), instruct the AI to generate them naturally and proportionally, matching the skin tone and lighting of Image Reference 1.
29. If Image Reference 2 shows a full-length dress/gown and Image Reference 1 only shows the upper body, instruct the AI to extrapolate the dress design naturally downward while maintaining the exact fabric properties and silhouette described from Image Reference 2.
30. TEXT/WATERMARK BLOCKING: You MUST completely ignore and block any text, words, fonts, typography, photography watermarks, logo signatures, and branding marks present anywhere in BOTH "Image Reference 1" and "Image Reference 2". This includes text floating in the corners, embedded as overlays, or written/printed on the ground, floor, road surface, or background assets. Do NOT extract, reference, or include any data/information regarding these text elements into the positive prompt. You must explicitly list "text, words, fonts, typography, watermark, signature, logo, overlay text" in the negative prompt to ensure Leonardo.ai renders a completely clean image.

OUTPUT FORMAT: Keep both the positive and negative prompts concise. Do not exceed 100 words per prompt. Focus only on the most impactful description keywords. Return STRICTLY a valid JSON object containing keys: 'positive_prompt' and 'negative_prompt' adhering to the configured responseSchema. Do not wrap the JSON inside markdown.`;

    console.log(`  [gemini:dress-swap] Sending dual-image input to Gemini (Ref1: ${(imageBuffer1.length / 1024).toFixed(1)} KB, Ref2: ${(imageBuffer2.length / 1024).toFixed(1)} KB)…`);

    // --- Exponential backoff retry for 503 UNAVAILABLE errors ---
    const MAX_RETRIES = 3;
    let response;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Update in-memory status so the frontend polling endpoint can relay retry progress
        if (localGenId && activeGenerations.has(localGenId)) {
            activeGenerations.get(localGenId).status = `RETRYING_ATTEMPT_${attempt}`;
        }

        try {
            response = await client.models.generateContent({
                model: 'gemini-3.5-flash',
                config: {
                    systemInstruction: systemInstruction,
                    temperature: 0.7,
                    topP: 0.95,
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            positive_prompt: { type: "STRING" },
                            negative_prompt: { type: "STRING" }
                        },
                        required: ["positive_prompt", "negative_prompt"]
                    },
                },
                contents: [
                    {
                        inlineData: {
                            mimeType: mimeType1,
                            data: base64Image1
                        }
                    },
                    {
                        text: 'This is "Image Reference 1" — The Base Identity & Background. Analyze the person\'s face, body, pose, background environment, lighting, and check for the presence of a hijab (headscarf).'
                    },
                    {
                        inlineData: {
                            mimeType: mimeType2,
                            data: base64Image2
                        }
                    },
                    {
                        text: 'This is "Image Reference 2" — The Target Fashion/Dress Reference. Analyze every garment detail: fabric, texture, pattern, color, silhouette, draping, and embellishments. Then generate the Leonardo.ai prompt JSON as instructed.'
                    }
                ]
            });
            break; // success — exit the retry loop
        } catch (err) {
            lastError = err;
            const is503 = err.message?.includes('503') || err.message?.includes('UNAVAILABLE') || err.status === 503;
            if (is503 && attempt < MAX_RETRIES) {
                const delayMs = Math.pow(2, attempt) * 1000; // Exponential: 2s, 4s, 8s, 16s, 32s
                console.log(`  [gemini:dress-swap] 503 UNAVAILABLE — retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})…`);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                throw err;
            }
        }
    }

    if (!response) {
        throw lastError || new Error('Gemini API call failed after all retries.');
    }

    // Extract text from the Gemini response using the built-in getter
    const rawText = (response.text || '').trim();
    if (!rawText) {
        throw new Error('Gemini returned an empty response — no text content.');
    }

    console.log(`  [gemini:dress-swap] Raw response (${rawText.length} chars): ${rawText.slice(0, 200)}${rawText.length > 200 ? '…' : ''}`);

    // Parse the JSON — aggressively strip any markdown code fences
    let cleaned = rawText;
    cleaned = cleaned.replace(/^\s*```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?\s*```\s*$/i, '');
    cleaned = cleaned.replace(/```/g, '');
    cleaned = cleaned.trim();

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (parseErr) {
        console.error(`  [gemini:dress-swap] Failed to parse JSON: ${cleaned.slice(0, 300)}`);
        throw new Error(`Gemini did not return valid JSON. Raw: ${cleaned.slice(0, 200)}`);
    }

    if (!parsed.positive_prompt || typeof parsed.positive_prompt !== 'string') {
        throw new Error('Gemini response missing required "positive_prompt" field.');
    }

    console.log(`  [gemini:dress-swap] Extracted positive_prompt (${parsed.positive_prompt.length} chars)`);
    if (parsed.negative_prompt) {
        console.log(`  [gemini:dress-swap] Extracted negative_prompt (${parsed.negative_prompt.length} chars)`);
    }

    return {
        positive_prompt: parsed.positive_prompt,
        negative_prompt: parsed.negative_prompt || ''
    };
}

/**
 * Build the Dress Swap generation payload.
 *
 * Uses the Gemini-generated prompt + both S3 image IDs at MID strength
 * (per PRD: identical weight for both guidance images).
 *
 * Hardcoded specifications:
 *   model: "nano-banana-2"
 *   public: false
 *   prompt_enhance: "OFF"
 *   quantity: 1
 *   style_ids: ["111dc692-d470-4eec-b791-3475abac4c46"]
 */
function buildDressSwapPayload(positivePrompt, negativePrompt, width, height, imageIds) {
    const payload = {
        model: 'nano-banana-2',
        public: false,
        parameters: {
            height,
            width,
            prompt_enhance: 'OFF',
            quantity: 1,
            style_ids: ['111dc692-d470-4eec-b791-3475abac4c46'],
            prompt: positivePrompt
        }
    };

    // Attach negative prompt if provided
    if (negativePrompt && negativePrompt.trim()) {
        payload.parameters.negative_prompt = negativePrompt.trim();
    }

    // Both Image Reference 1 (Identity & BG) and Image Reference 2 (Fashion Ref)
    // at identical MID strength for balanced guidance
    if (imageIds.length > 0) {
        payload.parameters.guidances = {
            image_reference: imageIds.map(id => ({
                image: { id, type: 'UPLOADED' },
                strength: 'MID'
            }))
        };
    }

    return payload;
}

/**
 * Execute the heavy Dress Swap pipeline asynchronously AFTER the
 * 202 Accepted response has already been sent to the frontend.
 *
 * This function is fire-and-forget — it runs entirely in the background,
 * updating the in-memory activeGenerations store as it progresses so
 * the frontend polling endpoint can relay live status to the user.
 *
 * @param {string} localGenId   — local tracking ID (already stored in activeGenerations)
 * @param {object} file1        — multer file object for Reference 1 (Identity & BG)
 * @param {object} file2        — multer file object for Reference 2 (Fashion Ref)
 * @param {number} w            — target pixel width
 * @param {number} h            — target pixel height
 * @param {string} localPath1   — local disk path for Reference 1
 * @param {string} localPath2   — local disk path for Reference 2
 * @param {string[]} imageIds   — Leonardo upload image IDs [ref1Id, ref2Id]
 */
async function executeDressSwapPipeline(localGenId, file1, file2, w, h, localPath1, localPath2, imageIds) {
    try {
        // --- Step A: Gemini prompt generation (Dress Swap rules A-D) -----
        console.log(`  [dress-swap] Generating prompts via Gemini with Dress Swap rules A-D…`);
        activeGenerations.get(localGenId).status = 'PROMPT_GENERATION';

        const { positive_prompt, negative_prompt } = await generateDressSwapPromptsWithGemini(
            file1.buffer,
            file1.mimetype,
            file2.buffer,
            file2.mimetype,
            localGenId
        );

        // --- Step B: Build Leonardo payload with both images at MID ------
        const payload = buildDressSwapPayload(
            positive_prompt,
            negative_prompt,
            w, h,
            imageIds
        );

        console.log(`  [dress-swap] Final positive_prompt: ${positive_prompt.slice(0, 120)}${positive_prompt.length > 120 ? '…' : ''}`);
        if (negative_prompt) {
            console.log(`  [dress-swap] Final negative_prompt: ${negative_prompt.slice(0, 120)}${negative_prompt.length > 120 ? '…' : ''}`);
        }

        // --- Step C: Create Leonardo generation --------------------------
        const leonardoGenId = await createLeonardoGeneration(payload);

        // --- Step D: Update in-memory store + start polling --------------
        // Preserve email from the initial placeholder record
        const prevRecord = activeGenerations.get(localGenId);
        const userEmail = (prevRecord && prevRecord._userEmail) || '';
        const safeEmailPrefix = (prevRecord && prevRecord._safeEmailPrefix) || sanitizeEmail(userEmail);

        activeGenerations.set(localGenId, {
            leonardoGenId,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: positive_prompt,
            type: 'dress-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _publicUser: true,    // route to /my-creations, never stamp admin email
            _userSave: true,      // save generated image to user_data_image_generate
            _userEmail: userEmail,
            _safeEmailPrefix: safeEmailPrefix
        });

        const persistedRefs = { ref1: localPath1, ref2: localPath2 };
        startBackgroundPoll(localGenId, leonardoGenId, persistedRefs);

        console.log(`  [dress-swap] Background pipeline launched — ${localGenId} now polling Leonardo\n`);

    } catch (err) {
        console.error(`  [dress-swap] Background pipeline FAILED for ${localGenId}:`, err.message);
        const record = activeGenerations.get(localGenId);
        if (record) {
            record.status = 'FAILED';
            record.error = err.message || 'Background pipeline failed';
        }
    }
}

/**
 * POST /api/dress-swap/generate
 * ------------------------------------------------------------------
 * Async background-job orchestration pipeline for the Dress Replicate.
 *
 * Accepts multipart/form-data with:
 *   referenceImage1  (file, required) — Identity & Base Background
 *   referenceImage2  (file, required) — Target Fashion/Dress Reference
 *   aspectRatio      (text, required) — "2:3" | "4:5" | "4:3"
 *   width            (text, required) — pixel width
 *   height           (text, required) — pixel height
 *
 * Pipeline:
 *   1. Validate inputs & upload both images to Leonardo
 *   2. Save local copies to /public/uploads/references/
 *   3. Return 202 Accepted with jobId IMMEDIATELY (non-blocking)
 *   4. BACKGROUND: Gemini prompt → Leonardo generation → polling
 */
app.post('/api/dress-swap/generate', upload.fields([
    { name: 'referenceImage1', maxCount: 1 },
    { name: 'referenceImage2', maxCount: 1 }
]), validateAndDeductCredits, async (req, res) => {
    let localGenId; // hoisted so catch block can clean up on failure
    try {
        // --- Validate API keys ---------------------------------------
        if (!LEONARDO_API_KEY) {
            return res.status(500).json({
                error: 'Server not configured. Set LEONARDO_API_KEY in .env'
            });
        }
        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                error: 'Server not configured. Set GEMINI_API_KEY in .env to use the Dress Replicate.'
            });
        }

        // --- Parse fields --------------------------------------------
        const { aspectRatio, width, height } = req.body;
        const w = parseInt(width, 10);
        const h = parseInt(height, 10);
        if (!w || !h || w < 64 || h < 64) {
            return res.status(400).json({ error: 'Valid width and height are required.' });
        }

        // --- Validate both reference images are present ---------------
        const file1 = req.files?.referenceImage1?.[0];
        const file2 = req.files?.referenceImage2?.[0];

        if (!file1) {
            return res.status(400).json({ error: 'Image Reference 1 (Identity & Background) is required.' });
        }
        if (!file2) {
            return res.status(400).json({ error: 'Image Reference 2 (Fashion/Dress Reference) is required.' });
        }

        console.log(`\n=== Dress Swap request ===`);
        console.log(`  Aspect Ratio: ${aspectRatio || 'N/A'} → ${w}×${h}`);
        console.log(`  Reference 1 (Identity & BG): ${file1.originalname} (${(file1.size / 1024).toFixed(1)} KB)`);
        console.log(`  Reference 2 (Fashion Ref): ${file2.originalname} (${(file2.size / 1024).toFixed(1)} KB)`);

        // --- Generate local tracking ID -------------------------------
        localGenId = `dresswap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const userEmail = req.headers['x-user-email'] || req.body.email || '';
        insertProcessingPlaceholder(localGenId, 'dress-swap', 'Dress Replicate', w, h, userEmail);

        // --- Step 1: Save both files locally --------------------------
        const localPath1 = await saveReferenceImageLocally(file1.buffer, localGenId, 1, file1.mimetype);
        const localPath2 = await saveReferenceImageLocally(file2.buffer, localGenId, 2, file2.mimetype);

        // --- Step 2: Upload both to Leonardo (concurrently) -----------
        console.log(`  [dress-swap] Uploading both reference images to Leonardo…`);

        const [imageId1, imageId2] = await Promise.all([
            uploadImageToLeonardo(file1.buffer, file1.originalname, file1.mimetype),
            uploadImageToLeonardo(file2.buffer, file2.originalname, file2.mimetype)
        ]);

        console.log(`  [dress-swap] Leonardo image IDs — Ref1: ${imageId1}, Ref2: ${imageId2}`);
        const imageIds = [imageId1, imageId2];

        // --- Step 3: Seed in-memory store & return 202 immediately -------
        // Store initial placeholder so the frontend can begin polling right away
        const safeEmailPrefix = sanitizeEmail(userEmail);
        console.log(`  [dress-swap] User email: ${userEmail} → prefix: ${safeEmailPrefix}`);

        activeGenerations.set(localGenId, {
            leonardoGenId: null,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: '',
            type: 'dress-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _userEmail: userEmail,
            _safeEmailPrefix: safeEmailPrefix
        });

        // Fire-and-forget: the heavy pipeline runs in the background while
        // the frontend is already redirecting to Creations for live polling.
        executeDressSwapPipeline(
            localGenId, file1, file2, w, h, localPath1, localPath2, imageIds
        );

        console.log(`  [dress-swap] → 202 Accepted — localGenId: ${localGenId}\n`);
        res.status(202).json({ generationId: localGenId, status: 'PENDING' });

    } catch (err) {
        console.error('[/api/dress-swap/generate] Unexpected error:', err);
        // Mark the placeholder entry as FAILED so the frontend gets a clean terminal state
        if (localGenId && activeGenerations.has(localGenId)) {
            activeGenerations.get(localGenId).status = 'FAILED';
            activeGenerations.get(localGenId).error = err.message || 'Internal server error';
        }
        // Refund credits on failure
        if (req.creditCost && req.creditEmail) {
            await refundCredits(req.creditEmail, req.creditCost);
        }
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * GET /api/dress-swap/status/:generationId
 * ------------------------------------------------------------------
 * Returns the current status of a dress-swap generation.
 * Reuses the same in-memory activeGenerations store.
 */
app.get('/api/dress-swap/status/:generationId', async (req, res) => {
    const { generationId } = req.params;
    const record = activeGenerations.get(generationId);

    if (!record) {
        // Fallback: check MongoDB for a completed/failed record (survives server restart)
        if (db.isConnected()) {
            const dbRecord = await db.Generation.findOne({ generation_id: generationId }).lean();
            if (dbRecord && (dbRecord.status === 'FAILED' || dbRecord.status === 'failed'
                          || dbRecord.status === 'COMPLETE' || dbRecord.status === 'complete')) {
                const isFailed = dbRecord.status === 'FAILED' || dbRecord.status === 'failed';
                return res.json({
                    status: isFailed ? 'FAILED' : 'COMPLETE',
                    imageUrl: dbRecord.image_url || undefined,
                    error: dbRecord.error || undefined
                });
            }
        }
        return res.status(404).json({
            status: 'UNKNOWN',
            error: 'Generation ID not found. It may have expired or never existed.'
        });
    }

    res.json({
        status: record.status,
        imageUrl: record.imageUrl || undefined,
        error: record.error || undefined
    });
});

// ------------------------------------------------------------------
// Filter Gallery API endpoints
// ------------------------------------------------------------------

/**
 * Send a subject image + a saved background prompt text to Gemini
 * to generate a blended prompt for the Filter Gallery swap pipeline.
 *
 * Image Reference 1 = The new subject (identity to preserve)
 * backgroundPrompt  = The saved text prompt from a prior Generate Image result
 *                     describing the background/scene to reuse.
 *
 * @param {Buffer} imageBuffer      — raw bytes of the subject image
 * @param {string} mimeType         — MIME type of the subject image
 * @param {string} backgroundPrompt — the saved text prompt describing the target background
 * @param {string} [localGenId]     — optional local generation ID for updating in-memory retry status
 * @returns {{ positive_prompt: string, negative_prompt: string }}
 */
/**
 * GET /api/admin-gallery-filter/images
 * ------------------------------------------------------------------
 * Returns generation records from the "Generate Image" tool only
 * (generation_id starting with "gen_" — excludes bgswap_ and dresswap_).
 * Sorted newest-first. Supports ?limit=N and ?offset=N query params.
 */
app.get('/api/admin-gallery-filter/images', async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        // Admin can pass ?all=1 to see inactive filters too
        const showAll = req.query.all === '1';
        const query = { type: 'filter-factory', image_url: { $ne: '', $exists: true } };
        // Treat missing/legacy isActive as true so existing filters still show
        if (!showAll) query.isActive = { $ne: false };
        const records = await db.Generation.find(query)
            .sort({ created_at: -1 })
            .skip(offset)
            .limit(limit)
            .lean();

        const total = await db.Generation.countDocuments(query);

        // Enrich with fallback title, tags, and dimensions for records saved
        // before these fields were added to the Mongoose schema (strict mode
        // was silently dropping them).
        const enriched = records.map(r => ({
            ...r,
            title: r.title || r.filterTitle || (r.prompt ? r.prompt.substring(0, 30).replace(/\n/g, ' ').trim() + '…' : 'Untitled'),
            tags: (Array.isArray(r.tags) && r.tags.length > 0) ? r.tags : ['Studio', 'Indoor'],
            dimensions: r.dimensions || r.ratio || (r.width && r.height ? r.width + ' × ' + r.height : '')
        }));

        res.json({ total, limit, offset, records: enriched });
    } catch (err) {
        console.error('[/api/admin-gallery-filter/images] Error:', err);
        res.status(500).json({ error: 'Failed to read gallery records' });
    }
});

/**
 * POST /api/admin-gallery-filter/swap
 * ------------------------------------------------------------------
 * Direct-to-Leonardo background-swap: takes a new subject image and a
 * saved preset background prompt, feeds them directly into Leonardo AI
 * Image Guidance, and returns immediately (async background job).
 *
 * Accepts multipart/form-data:
 *   referenceImage1   (file, required) — new subject photo
 *   backgroundPrompt  (text, required) — saved preset prompt
 *   filterTitle       (text, optional) — preset name from the gallery card
 *   aspectRatio       (text, required) — "2:3" | "4:5" | "4:3"
 *   width             (text, required)
 *   height            (text, required)
 */
app.post('/api/admin-gallery-filter/swap', upload.fields([
    { name: 'referenceImage1', maxCount: 1 }
]), validateAndDeductCredits, async (req, res) => {
    let localGenId;
    try {
        if (!LEONARDO_API_KEY) {
            return res.status(500).json({ error: 'Server not configured. Set LEONARDO_API_KEY in .env' });
        }

        const { backgroundPrompt, filterTitle, filterId, aspectRatio, width, height } = req.body;
        const w = parseInt(width, 10);
        const h = parseInt(height, 10);
        if (!w || !h || w < 64 || h < 64) {
            return res.status(400).json({ error: 'Valid width and height are required.' });
        }
        if (!backgroundPrompt || !backgroundPrompt.trim()) {
            return res.status(400).json({ error: 'Background prompt is required.' });
        }

        const subjectFile = req.files?.referenceImage1?.[0];
        if (!subjectFile) {
            return res.status(400).json({ error: 'Subject image (Image Reference 1) is required.' });
        }

        // ── Capture user email — admin or public user ──────────────
        // Public users pass email via X-User-Email header (set by filter_gallery.html).
        // Admin users already have a session cookie and may not send the header.
        const isAdmin = verifyAdminCookie(req);
        const ownerEmail = isAdmin
            ? ADMIN_EMAIL
            : (req.headers['x-user-email'] || req.body.email || '');

        // Increment usage counter on the source filter (non-blocking)
        // Admin test-runs are excluded so usage metrics reflect real customer activity
        if (filterId && !isAdmin) {
            db.Generation.updateOne(
                { generation_id: filterId, type: 'filter-factory' },
                { $inc: { usageCount: 1 } }
            ).catch(err => console.warn('  [admin-filter] usageCount increment failed (non-fatal):', err.message));
        }

        // ── Rest of flow ──
        // (isAdmin and ownerEmail already resolved above)

        const prompt = backgroundPrompt.trim();

        console.log(`\n=== Filter Gallery Swap ===`);
        console.log(`  Subject: ${subjectFile.originalname} (${(subjectFile.size / 1024).toFixed(1)} KB)`);
        console.log(`  Preset prompt: ${prompt.slice(0, 80)}…`);
        console.log(`  Dimensions: ${w}×${h} (${aspectRatio || 'N/A'})`);
        console.log(`  User: ${ownerEmail || '(guest)'}  |  Admin: ${isAdmin}`);

        localGenId = `agfilter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Immediately persist a processing placeholder with the CORRECT owner email
        insertProcessingPlaceholder(localGenId, 'filter-swap', prompt, w, h, ownerEmail);

        // Save subject locally
        const localPath1 = await saveReferenceImageLocally(subjectFile.buffer, localGenId, 1, subjectFile.mimetype);

        // Immediately upload reference image to Cloudinary so the
        // "Before" image survives Hostinger redeploys (local ephemeral
        // storage is wiped on every deploy).
        try {
            const refUpload = await db.uploadToCloudinary(subjectFile.buffer, 'references', `ref_${localGenId}_1`);
            if (refUpload && refUpload.url) {
                await db.Generation.findOneAndUpdate(
                    { generation_id: localGenId },
                    { $set: { reference_image_1_url: refUpload.url } }
                );
                console.log(`  [cloudinary] Ref image uploaded → ${refUpload.url}`);
            }
        } catch (uploadErr) {
            console.error(`  [cloudinary] Ref image upload failed (non-fatal):`, uploadErr.message);
        }

        // Upload subject to Leonardo
        const subjectImageId = await uploadImageToLeonardo(subjectFile.buffer, subjectFile.originalname, subjectFile.mimetype);
        console.log(`  [admin-filter] Subject Leonardo ID: ${subjectImageId}`);

        // Build Leonardo payload — preset prompt fed directly with Image Guidance
        const payload = {
            model: 'nano-banana-2',
            public: false,
            parameters: {
                height: h,
                width: w,
                prompt_enhance: 'OFF',
                quantity: 1,
                style_ids: ['111dc692-d470-4eec-b791-3475abac4c46'],
                prompt: prompt,
                guidances: {
                    image_reference: [{
                        image: { id: subjectImageId, type: 'UPLOADED' },
                        strength: 'HIGH'
                    }]
                }
            }
        };

        console.log(`  [admin-filter] prompt: ${prompt.slice(0, 120)}…`);

        const leonardoGenId = await createLeonardoGeneration(payload);

        // Register for async background polling — tag public users so the
        // poll-completion handler stamps the correct owner_email at finish.
        activeGenerations.set(localGenId, {
            leonardoGenId,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: prompt,
            filterTitle: filterTitle || '',
            type: 'filter-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _userEmail: ownerEmail,
            _safeEmailPrefix: sanitizeEmail(ownerEmail),
            _publicUser: !isAdmin,
            _adminSave: isAdmin
        });

        const persistedRefs = { ref1: localPath1, ref2: null };
        startBackgroundPoll(localGenId, leonardoGenId, persistedRefs);

        console.log(`  [admin-filter] → 202 Accepted — jobId: ${localGenId}\n`);
        res.status(202).json({ jobId: localGenId });

    } catch (err) {
        console.error('[/api/admin-gallery-filter/swap] Error:', err);
        if (localGenId && activeGenerations.has(localGenId)) {
            activeGenerations.get(localGenId).status = 'FAILED';
            activeGenerations.get(localGenId).error = err.message || 'Internal server error';
        }
        // Refund credits on failure
        if (req.creditCost && req.creditEmail) {
            await refundCredits(req.creditEmail, req.creditCost);
        }
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * POST /api/filter-gallery/swap
 * ------------------------------------------------------------------
 * PUBLIC endpoint for the Filter Gallery.  Regular logged-in users
 * (not admins) call this from filter_gallery.html.  It is identical
 * to the admin-gallery-filter/swap pipeline but NEVER stamps records
 * with the admin email and has NO admin middleware.
 *
 * Accepts multipart/form-data:
 *   referenceImage1   (file, required) — new subject photo
 *   backgroundPrompt  (text, required) — saved preset prompt
 *   filterTitle       (text, optional) — preset name from the gallery card
 *   aspectRatio       (text, required) — "2:3" | "4:5" | "4:3"
 *   width             (text, required)
 *   height            (text, required)
 */
app.post('/api/filter-gallery/swap', upload.fields([
    { name: 'referenceImage1', maxCount: 1 }
]), validateAndDeductCredits, async (req, res) => {
    let localGenId;
    try {
        if (!LEONARDO_API_KEY) {
            return res.status(500).json({ error: 'Server not configured. Set LEONARDO_API_KEY in .env' });
        }

        const { backgroundPrompt, filterTitle, filterId, aspectRatio, width, height } = req.body;
        const w = parseInt(width, 10);
        const h = parseInt(height, 10);
        if (!w || !h || w < 64 || h < 64) {
            return res.status(400).json({ error: 'Valid width and height are required.' });
        }
        if (!backgroundPrompt || !backgroundPrompt.trim()) {
            return res.status(400).json({ error: 'Background prompt is required.' });
        }

        const subjectFile = req.files?.referenceImage1?.[0];
        if (!subjectFile) {
            return res.status(400).json({ error: 'Subject image (Image Reference 1) is required.' });
        }

        // Increment usage counter on the source filter (non-blocking)
        if (filterId) {
            db.Generation.updateOne(
                { generation_id: filterId, type: 'filter-factory' },
                { $inc: { usageCount: 1 } }
            ).catch(err => console.warn('  [filter-gallery] usageCount increment failed (non-fatal):', err.message));
        }

        // This is a PUBLIC endpoint — always use the header/body email, NEVER admin.
        const ownerEmail = req.headers['x-user-email'] || req.body.email || '';

        const prompt = backgroundPrompt.trim();

        console.log(`\n=== PUBLIC Filter Gallery Swap ===`);
        console.log(`  Subject: ${subjectFile.originalname} (${(subjectFile.size / 1024).toFixed(1)} KB)`);
        console.log(`  Preset prompt: ${prompt.slice(0, 80)}…`);
        console.log(`  Dimensions: ${w}×${h} (${aspectRatio || 'N/A'})`);
        console.log(`  User: ${ownerEmail || '(guest)'}`);

        localGenId = `filterswap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Persist a processing placeholder with the USER's email
        insertProcessingPlaceholder(localGenId, 'filter-swap', prompt, w, h, ownerEmail);

        // Save subject locally
        const localPath1 = await saveReferenceImageLocally(subjectFile.buffer, localGenId, 1, subjectFile.mimetype);

        // Immediately upload reference image to Cloudinary so the
        // "Before" image survives Hostinger redeploys (local ephemeral
        // storage is wiped on every deploy).
        try {
            const refUpload = await db.uploadToCloudinary(subjectFile.buffer, 'references', `ref_${localGenId}_1`);
            if (refUpload && refUpload.url) {
                await db.Generation.findOneAndUpdate(
                    { generation_id: localGenId },
                    { $set: { reference_image_1_url: refUpload.url } }
                );
                console.log(`  [cloudinary] Ref image uploaded → ${refUpload.url}`);
            }
        } catch (uploadErr) {
            console.error(`  [cloudinary] Ref image upload failed (non-fatal):`, uploadErr.message);
        }

        // Upload subject to Leonardo
        const subjectImageId = await uploadImageToLeonardo(subjectFile.buffer, subjectFile.originalname, subjectFile.mimetype);
        console.log(`  [filter-gallery] Subject Leonardo ID: ${subjectImageId}`);

        // Build Leonardo payload
        const payload = {
            model: 'nano-banana-2',
            public: false,
            parameters: {
                height: h,
                width: w,
                prompt_enhance: 'OFF',
                quantity: 1,
                style_ids: ['111dc692-d470-4eec-b791-3475abac4c46'],
                prompt: prompt,
                guidances: {
                    image_reference: [{
                        image: { id: subjectImageId, type: 'UPLOADED' },
                        strength: 'HIGH'
                    }]
                }
            }
        };

        console.log(`  [filter-gallery] prompt: ${prompt.slice(0, 120)}…`);

        const leonardoGenId = await createLeonardoGeneration(payload);

        // Register for async background polling — ALWAYS a public user
        activeGenerations.set(localGenId, {
            leonardoGenId,
            status: 'PENDING',
            imageUrl: null,
            error: null,
            prompt: prompt,
            filterTitle: filterTitle || '',
            type: 'filter-swap',
            width: w,
            height: h,
            createdAt: Date.now(),
            _userEmail: ownerEmail,
            _safeEmailPrefix: sanitizeEmail(ownerEmail),
            _publicUser: true,
            _adminSave: false
        });

        const persistedRefs = { ref1: localPath1, ref2: null };
        startBackgroundPoll(localGenId, leonardoGenId, persistedRefs);

        console.log(`  [filter-gallery] → 202 Accepted — jobId: ${localGenId}\n`);
        res.status(202).json({ jobId: localGenId });

    } catch (err) {
        console.error('[/api/filter-gallery/swap] Error:', err);
        if (localGenId && activeGenerations.has(localGenId)) {
            activeGenerations.get(localGenId).status = 'FAILED';
            activeGenerations.get(localGenId).error = err.message || 'Internal server error';
        }
        if (req.creditCost && req.creditEmail) {
            await refundCredits(req.creditEmail, req.creditCost);
        }
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * GET /api/admin-gallery-filter/status/:generationId
 * ------------------------------------------------------------------
 * Returns the current status of an admin-gallery-filter swap generation.
 */
app.get('/api/admin-gallery-filter/status/:generationId', (req, res) => {
    const { generationId } = req.params;
    const record = activeGenerations.get(generationId);
    if (!record) {
        return res.status(404).json({
            status: 'UNKNOWN',
            error: 'Generation ID not found.'
        });
    }
    res.json({
        status: record.status,
        imageUrl: record.imageUrl || undefined,
        error: record.error || undefined
    });
});

/**
 * DELETE /api/user-creations/:filename
 * ------------------------------------------------------------------
 * Deletes a user creation by filename (e.g. "gen_1234567890_abc123.jpg").
 * Removes the physical image file from user_data_image_generate/ and
 * cleans up the corresponding database record + associated local files
 * (reference images, prompt data, thumbnails).
 *
 * Returns { deleted: true } on success, 404 if not found.
 */
app.delete('/api/user-creations/:filename', async (req, res) => {
    try {
        const { filename } = req.params;

        // Security: prevent path traversal attacks
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename.' });
        }

        // Accept both filenames with extensions (e.g. "gen_123.jpg") and
        // raw generation IDs (e.g. "filterswap_1765898765_abc123").
        const hasExtension = /\.(jpg|jpeg|png|webp|gif)$/i.test(filename);
        const genId = hasExtension ? filename.replace(/\.[^/.]+$/, '') : filename;
        let fileDeleted = false;

        // 1. Try to delete the physical generated image file (if it exists)
        const filePath = hasExtension ? path.join(USER_IMAGE_GEN_DIR, filename) : null;
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                fileDeleted = true;
                console.log(`  [user-creations:delete] Removed generated image: ${filePath}`);
            } catch (err) {
                console.error(`  [user-creations:delete] Failed to remove ${filePath}:`, err.message);
            }
        }

        if (db.isConnected()) {
            const record = await db.Generation.findOne({ generation_id: genId }).lean();

            if (record) {
                // Delete all associated local files for this record
                const filesToDelete = [
                    record.user_gen_path,
                    record.user_ref_path,
                    record.user_prompt_path,
                    record.admin_gen_path,
                    record.admin_ref_path,
                    record.admin_prompt_path,
                    record.cover_image_path,
                    record.reference_image_1_path,
                    record.reference_image_2_path
                ].filter(Boolean);

                filesToDelete.forEach(relPath => {
                    // Handle both absolute and relative paths
                    const absPath = path.isAbsolute(relPath) ? relPath : path.join(__dirname, relPath);
                    try {
                        if (fs.existsSync(absPath)) {
                            fs.unlinkSync(absPath);
                            console.log(`  [user-creations:delete] Removed associated file: ${relPath}`);
                        }
                    } catch (err) {
                        console.error(`  [user-creations:delete] Failed to remove ${relPath}:`, err.message);
                    }
                });

                // Actually delete from MongoDB
                await db.Generation.deleteOne({ generation_id: genId });
                console.log(`  [user-creations:delete] Database record deleted: ${genId}`);
            }

            if (fileDeleted || record) {
                res.json({ deleted: true, filename, generation_id: genId });
            } else {
                res.status(404).json({ error: 'File not found on disk or in database.', filename });
            }
        } else {
            // Fallback: DB unavailable but file was deleted
            if (fileDeleted) {
                res.json({ deleted: true, filename, generation_id: genId });
            } else {
                res.status(404).json({ error: 'File not found.', filename });
            }
        }
    } catch (err) {
        console.error('[/api/user-creations/:filename] Error:', err);
        res.status(500).json({ error: 'Failed to delete creation.' });
    }
});

/**
 * DELETE /api/filter-gallery/:id
 * ------------------------------------------------------------------
 * Deletes a background filter asset by generation_id.
 * Removes the database record and associated local files (cover thumbnail
 * + reference images) from the uploads/ folder.
 *
 * Returns { deleted: true } on success, 404 if not found.
 */
app.delete('/api/filter-gallery/:id', requireAdminApi, async (req, res) => {
    try {
        const { id } = req.params;

        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        // Find the record first so we can clean up associated local files
        const record = await db.Generation.findOne({ generation_id: id }).lean();

        if (!record) {
            return res.status(404).json({ error: 'Record not found.', generation_id: id });
        }

        // Delete associated local files (Cloudinary URLs are skipped)
        const filesToDelete = [
            record.cover_image_path,
            record.reference_image_1_path,
            record.reference_image_2_path
        ].filter(p => p && !/^https?:\/\//i.test(p));

        filesToDelete.forEach(relPath => {
            const absPath = path.join(__dirname, relPath);
            try {
                if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath);
                    console.log(`  [filter-gallery:delete] Removed file: ${relPath}`);
                }
            } catch (err) {
                console.error(`  [filter-gallery:delete] Failed to remove ${relPath}:`, err.message);
            }
        });

        // Actually delete from MongoDB (the old writeDatabase was a no-op!)
        const result = await db.Generation.deleteOne({ generation_id: id });
        const remaining = await db.Generation.countDocuments({ type: 'filter-factory' });

        console.log(`  [filter-gallery:delete] Record deleted: ${id} (${remaining} remaining)`);

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Record not found.', generation_id: id });
        }

        res.json({ deleted: true, generation_id: id });
    } catch (err) {
        console.error('[/api/filter-gallery/:id] Error:', err);
        res.status(500).json({ error: 'Failed to delete record.' });
    }
});

// ------------------------------------------------------------------
// Admin Filter Management API — table view with toggle & delete
// ------------------------------------------------------------------

/**
 * GET /api/admin/filters
 * Returns ALL filter-factory records (including inactive) for the
 * admin filter management table. Supports ?limit=N&offset=N.
 */
app.get('/api/admin/filters', requireAdminApi, async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const limit  = Math.min(parseInt(req.query.limit) || 200, 500);
        const offset = parseInt(req.query.offset) || 0;

        const query = { type: 'filter-factory', image_url: { $ne: '', $exists: true } };
        const [records, total] = await Promise.all([
            db.Generation.find(query).sort({ created_at: -1 }).skip(offset).limit(limit).lean(),
            db.Generation.countDocuments(query)
        ]);

        const filters = records.map(r => ({
            generation_id: r.generation_id,
            title: r.title || r.filterTitle || 'Untitled',
            tags: r.tags || [],
            dimensions: r.dimensions || '',
            image_url: r.image_url || r.cover_image_url || '',
            cover_image_url: r.cover_image_url || r.image_url || '',
            isActive: r.isActive !== false,  // default true
            usageCount: r.usageCount || 0,
            created_at: r.created_at
        }));

        res.json({ total, limit, offset, filters });
    } catch (err) {
        console.error('[/api/admin/filters] Error:', err);
        res.status(500).json({ error: 'Failed to read filters.' });
    }
});

/**
 * PATCH /api/admin/filters/:id/toggle
 * Toggles the isActive flag on a filter-factory record.
 */
app.patch('/api/admin/filters/:id/toggle', requireAdminApi, async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const record = await db.Generation.findOne({ generation_id: req.params.id, type: 'filter-factory' });
        if (!record) return res.status(404).json({ error: 'Filter not found.' });

        const newState = !record.isActive;
        await db.Generation.updateOne(
            { generation_id: req.params.id },
            { $set: { isActive: newState } }
        );

        console.log(`  [admin/filters] Toggled ${req.params.id} → isActive=${newState}`);
        res.json({ success: true, generation_id: req.params.id, isActive: newState });
    } catch (err) {
        console.error('[/api/admin/filters/:id/toggle] Error:', err);
        res.status(500).json({ error: 'Failed to toggle filter.' });
    }
});

// ------------------------------------------------------------------
// Admin Save Endpoint — local file persistence for admin panel
// ------------------------------------------------------------------

/**
 * POST /api/save-admin-generation
 * ------------------------------------------------------------------
 * Receives admin generation metadata (reference image + prompt) and
 * persists them to the absolute admin data directories. The generated
 * image is saved later by the background poll completion handler.
 *
 * Accepts multipart/form-data:
 *   referenceImage  (file, required) — the subject photo
 *   prompt          (text, required) — the background prompt
 *   filterTitle     (text, optional) — preset name
 *   jobId           (text, required) — local generation ID for file naming
 */
app.post('/api/save-admin-generation', requireAdminApi, upload.fields([
    { name: 'referenceImage', maxCount: 1 }
]), async (req, res) => {
    try {
        const { prompt, filterTitle, jobId } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required.' });
        }
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'Prompt is required.' });
        }

        const refFile = req.files?.referenceImage?.[0];
        if (!refFile) {
            return res.status(400).json({ error: 'Reference image is required.' });
        }

        const genId = jobId.trim();
        console.log(`\n=== Admin Save Request ===`);
        console.log(`  jobId: ${genId}`);
        console.log(`  Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);
        console.log(`  Filter Title: "${filterTitle || '(none)'}"`);

        const savedFiles = {};

        // --- 1. Upload reference image to Cloudinary ---
        let refCloudinaryUrl = null;
        try {
            const jpegBuffer = await sharp(refFile.buffer).jpeg({ quality: 92 }).toBuffer();
            const upload = await db.uploadToCloudinary(jpegBuffer, 'references', `admin_ref_${genId}`);
            if (upload) {
                refCloudinaryUrl = upload.url;
                savedFiles.referenceImage = upload.url;
                console.log(`  [admin-save] Reference uploaded to Cloudinary: ${upload.url}`);
            }
        } catch (err) {
            console.error(`  [admin-save] Failed to upload reference:`, err.message);
        }

        // --- 2. Flag the in-memory record for admin save completion ---
        if (!activeGenerations.has(genId)) {
            activeGenerations.set(genId, { status: 'PENDING', createdAt: Date.now() });
        }
        const record = activeGenerations.get(genId);
        if (record) {
            record._adminSave = true;
            record._adminRefPath = refCloudinaryUrl || '';
            record.filterTitle = filterTitle || req.body.title || record.filterTitle || '';
            record._title = req.body.title || filterTitle || '';
            record._ratio = req.body.ratio || '';
            record._userEmail = ADMIN_EMAIL;
            record._safeEmailPrefix = sanitizeEmail(ADMIN_EMAIL);
            if (req.body.tags) {
                try {
                    record._tags = typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags;
                } catch (_) { record._tags = []; }
            }
            if (!record._tags || record._tags.length === 0) {
                const fallbackTags = [];
                if (req.body.category) fallbackTags.push(req.body.category);
                if (req.body.selected_tag) fallbackTags.push(req.body.selected_tag);
                if (req.body.lighting) fallbackTags.push(req.body.lighting);
                if (fallbackTags.length > 0) record._tags = fallbackTags;
            }
        }

        console.log(`  [admin-save] → 200 OK — ${Object.keys(savedFiles).length} files saved\n`);
        res.json({
            success: true,
            jobId: genId,
            savedFiles,
            message: 'Admin reference + prompt saved. Generated image will be saved on completion.'
        });

    } catch (err) {
        console.error('[/api/save-admin-generation] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * POST /api/save-user-generation
 * ------------------------------------------------------------------
 * Receives public user generation metadata (reference image + prompt) and
 * persists them to the absolute user data directories. The generated
 * image is saved later by the background poll completion handler.
 *
 * Designed for the public user panel (filter_gallery.html) — does NOT
 * stamp records with the admin email, keeping them isolated to the
 * public Creations gallery.
 *
 * Accepts multipart/form-data:
 *   referenceImage  (file, required) — the subject photo
 *   prompt          (text, required) — the background prompt
 *   filterTitle     (text, optional) — preset name
 *   jobId           (text, required) — local generation ID for file naming
 */
app.post('/api/save-user-generation', upload.fields([
    { name: 'referenceImage', maxCount: 1 }
]), async (req, res) => {
    try {
        const { prompt, filterTitle, jobId } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required.' });
        }
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'Prompt is required.' });
        }

        const refFile = req.files?.referenceImage?.[0];
        if (!refFile) {
            return res.status(400).json({ error: 'Reference image is required.' });
        }

        const genId = jobId.trim();

        // --- Extract and sanitize user email for file prefixing ---
        const rawEmail = req.headers['x-user-email'] || req.body.owner_email || '';
        const safeEmailPrefix = sanitizeEmail(rawEmail);
        const timestamp = Date.now();

        console.log(`\n=== User Save Request ===`);
        console.log(`  jobId: ${genId}`);
        console.log(`  Email: ${rawEmail} → prefix: ${safeEmailPrefix}`);
        console.log(`  Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);
        console.log(`  Filter Title: "${filterTitle || '(none)'}"`);

        const savedFiles = {};

        // --- 1. Upload reference image to Cloudinary ---
        let refCloudinaryUrl = null;
        try {
            const jpegBuffer = await sharp(refFile.buffer).jpeg({ quality: 92 }).toBuffer();
            const upload = await db.uploadToCloudinary(jpegBuffer, 'references', `${safeEmailPrefix}_ref_${timestamp}`);
            if (upload) {
                refCloudinaryUrl = upload.url;
                savedFiles.referenceImage = upload.url;
                console.log(`  [user-save] Reference uploaded to Cloudinary: ${upload.url}`);
            }
        } catch (err) {
            console.error(`  [user-save] Failed to upload reference:`, err.message);
        }

        // --- 2. Flag the in-memory record for user save completion ---
        if (!activeGenerations.has(genId)) {
            activeGenerations.set(genId, { status: 'PENDING', createdAt: Date.now() });
        }
        const record = activeGenerations.get(genId);
        if (record) {
            record._userSave = true;
            record._publicUser = true;
            record._userRefPath = refCloudinaryUrl || '';
            record._userEmail = rawEmail;
            record._safeEmailPrefix = safeEmailPrefix;
            record.filterTitle = filterTitle || req.body.title || record.filterTitle || '';
            record._title = req.body.title || filterTitle || '';
            record._ratio = req.body.ratio || '';
            // Pass frontend tags through strictly
            if (req.body.tags) {
                try {
                    record._tags = typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags;
                } catch (_) { record._tags = []; }
            }
            // Also capture category and lighting as individual tag fallbacks
            if (!record._tags || record._tags.length === 0) {
                const fallbackTags = [];
                if (req.body.category) fallbackTags.push(req.body.category);
                if (req.body.selected_tag) fallbackTags.push(req.body.selected_tag);
                if (req.body.lighting) fallbackTags.push(req.body.lighting);
                if (fallbackTags.length > 0) record._tags = fallbackTags;
            }
        }

        console.log(`  [user-save] → 200 OK — ${Object.keys(savedFiles).length} files saved\n`);
        res.json({
            success: true,
            jobId: genId,
            savedFiles,
            message: 'User reference + prompt saved. Generated image will be saved on completion.'
        });

    } catch (err) {
        console.error('[/api/save-user-generation] Error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * GET /api/admin-creations
 * ------------------------------------------------------------------
 * Returns ONLY admin-owned generation records (owner_email === ADMIN_EMAIL)
 * from database.json, sorted newest-first.
 *
 * Query params:
 *   ?limit=N   — cap results (default 50)
 *   ?offset=N  — pagination offset (default 0)
 */
app.get('/api/admin-creations', requireAdminApi, async (req, res) => {
    try {
        if (!db.isConnected()) return res.status(503).json({ error: 'Database unavailable.' });

        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        // Exclude processing placeholders — they have no image and would render
        // as phantom "No Preview" cards in the gallery.  Processing state is
        // tracked client-side via localStorage + active-generations polling.
        const query = { owner_email: ADMIN_EMAIL, status: { $nin: ['processing', 'PENDING'] } };
        const records = await db.Generation.find(query)
            .sort({ created_at: -1 })
            .skip(offset)
            .limit(limit)
            .lean();

        const total = await db.Generation.countDocuments(query);

        res.json({ total, limit, offset, records });
    } catch (err) {
        console.error('[/api/admin-creations] Error:', err);
        res.status(500).json({ error: 'Failed to read admin creation records' });
    }
});

/**
 * GET /api/admin/overview
 * ------------------------------------------------------------------
 * Returns 4 dashboard metrics for the admin overview:
 *   total_users, lifetime_revenue, monthly_revenue, user_generations
 * Protected by requireAdminApi middleware.
 */
app.get('/api/admin/overview', requireAdminApi, async (_req, res) => {
    try {
        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear  = now.getFullYear();

        // Metric 1: Total registered users
        const totalUsers = await db.User.countDocuments();

        // Metric 2 & 3: Lifetime and monthly revenue from MongoDB
        const packages = getCreditPackages();
        // Only sum actual purchases (top-up) — exclude usage/deduction/refund records
        // that would subtract from revenue with their negative amounts
        const successTxns = await db.Transaction.find({ status: 'success', type: { $nin: ['usage', 'deduction'] } }).lean();

        let lifetimeRevenue = 0;
        let monthlyRevenue  = 0;

        for (const txn of successTxns) {
            const txnDate = new Date(txn.created_at || 0);
            let idrAmount = txn.amount || 0;
            if (txn.package_id) {
                const pkg = packages.find(p => p.package_id === txn.package_id);
                if (pkg) idrAmount = pkg.price;
            }

            lifetimeRevenue += idrAmount;
            if (txnDate.getMonth() === currentMonth && txnDate.getFullYear() === currentYear) {
                monthlyRevenue += idrAmount;
            }
        }

        // Metric 4: Total user generations (not admin-owned)
        const userGenerations = await db.Generation.countDocuments({
            owner_email: { $nin: [ADMIN_EMAIL, '', null] },
            status: 'COMPLETE'
        });

        console.log(`  [api/admin/overview] users=${totalUsers} lifetime_rev=${lifetimeRevenue} monthly_rev=${monthlyRevenue} user_gens=${userGenerations}`);

        res.json({
            total_users: totalUsers,
            lifetime_revenue: lifetimeRevenue,
            monthly_revenue: monthlyRevenue,
            user_generations: userGenerations
        });
    } catch (err) {
        console.error('[/api/admin/overview] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve admin overview.' });
    }
});

// ------------------------------------------------------------------
// Credit Middleware — validates and deducts credits before generation
// ------------------------------------------------------------------

/**
 * Middleware to validate user credit balance and deduct before generation.
 * Attaches `req.creditCost` for potential refund on failure.
 * Returns 402 if insufficient credits.
 */
async function validateAndDeductCredits(req, res, next) {
    const currentPath = req.path;

    // ── Admin sandbox bypass — ONLY for the explicit admin testing endpoint ──
    // The admin generation sandbox (/api/admin-gallery-filter/swap) is the ONE
    // route where credit deduction is skipped.  All other routes — including the
    // public /api/filter-gallery/swap — ALWAYS deduct credits, even if the
    // browser happens to have a lingering admin_session cookie.
    const isAdminSandbox = (currentPath === '/api/admin-gallery-filter/swap');
    if (isAdminSandbox && verifyAdminCookie(req)) {
        console.log(`  [credits] ⚡ ADMIN SANDBOX BYPASS — skipping credit check for ${currentPath}`);
        req.creditCost = 0;
        req.creditEmail = ADMIN_EMAIL;
        return next();
    }

    // Determine credit cost from route mapping
    let creditCost = CREDIT_COSTS[currentPath] || 0;
    if (creditCost === 0) {
        // Unknown route — let it through without credit check
        return next();
    }

    // Defensively capture user email from EVERY possible source.
    // Public filter gallery sends X-User-Email header; other pages may use
    // body.email or the alternate user-email header.  Log clearly so we can
    // trace which source matched (or why none did).
    const userEmail = req.body.email
                   || req.headers['x-user-email']
                   || req.headers['user-email']
                   || '';
    if (!userEmail) {
        console.warn('  [credits] ⚠ Email MISSING — checked body.email, x-user-email header, user-email header');
        console.warn('  [credits]    Request path:', currentPath);
        console.warn('  [credits]    Headers:', JSON.stringify(req.headers));
        return res.status(400).json({
            success: false,
            error: 'Email diperlukan',
            message: 'Email tidak ditemukan. Pastikan Anda sudah login atau kirim header X-User-Email.'
        });
    } else {
        console.log(`  [credits] Email resolved: "${userEmail}" (source: ${req.body.email ? 'body' : req.headers['x-user-email'] ? 'x-user-email header' : req.headers['user-email'] ? 'user-email header' : 'unknown'})`);
    }

    try {
        const user = await ensureUserExists(userEmail);

        // Guard: if MongoDB is down, ensureUserExists returns null.
        // Don't crash — return a clean 503 so the frontend can show a retry message.
        if (!user) {
            return res.status(503).json({
                success: false,
                error: 'Layanan sementara tidak tersedia',
                message: 'Tidak dapat memverifikasi akun Anda. Silakan coba lagi dalam beberapa saat.'
            });
        }

        // ═══ Check and expire stale credits before deduction ═══
        const expireResult = await checkAndExpireCredits(userEmail);
        if (expireResult.balance !== null) {
            user.credits_balance = expireResult.balance;
        }

        if (user.credits_balance < creditCost) {
            return res.status(402).json({
                success: false,
                error: 'Kredit tidak mencukupi',
                message: `Menu ini memerlukan ${creditCost} kredit. Saldo Anda saat ini: ${user.credits_balance} kredit. Silakan melakukan top-up.`,
                credits_required: creditCost,
                credits_balance: user.credits_balance
            });
        }

        // Deduct credits (with action description for transaction history)
        const actionName = CREDIT_ACTION_NAMES[currentPath] || currentPath;
        const result = await deductCredits(userEmail, creditCost, actionName);
        if (!result.success) {
            return res.status(402).json({
                success: false,
                error: 'Gagal memotong kredit',
                message: result.error
            });
        }

        // Store cost on request for potential refund
        req.creditCost = creditCost;
        req.creditEmail = userEmail;
        console.log(`  [credits] ✓ Validated — ${userEmail} deducted ${creditCost} credits (balance: ${result.balance})`);
        if (typeof next === 'function') {
            next();
        } else {
            console.error('  [credits] ERROR — next is not a function in middleware chain');
        }
    } catch (err) {
        console.error('  [credits] Middleware error:', err.message);
        // Only call next(err) if next is available; otherwise just send response
        if (typeof next === 'function' && err) {
            next(err);
        } else {
            res.status(500).json({ success: false, error: 'Gagal memproses validasi kredit.' });
        }
    }
}

/**
 * DELETE /api/user/delete-account
 * Wipes user data from credits.json. Body: { email }
 */
app.delete('/api/user/delete-account', async (req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        // ── MongoDB cleanup ──
        if (db.isConnected()) {
            await db.User.deleteOne({ email });
            await db.Transaction.deleteMany({ email });
            // Intentionally do NOT delete ClaimedWelcomeGift — permanent anti-abuse tracker
            console.log(`  [user] MongoDB data deleted for: ${email}`);
        }

        // ── Legacy database.json cleanup ──
        const legacyDb = await readCreditsDB();
        if (legacyDb.users && legacyDb.users[email]) {
            delete legacyDb.users[email];
            legacyDb.transactions = (legacyDb.transactions || []).filter(t => t.email !== email);
            writeCreditsDB(legacyDb);
            console.log(`  [user] Legacy database.json entry deleted: ${email}`);
        }

        res.json({ success: true, message: 'Account and all associated data deleted.' });
    } catch (err) {
        console.error('[/api/user/delete-account] Error:', err);
        res.status(500).json({ error: 'Failed to delete account.' });
    }
});

// ------------------------------------------------------------------
// Authentication Endpoint
// ------------------------------------------------------------------

/**
 * POST /api/auth/google
 * ------------------------------------------------------------------
 * Authenticates (or auto-registers) a user via Google Identity Services.
 * Body: { idToken: "<Google ID token>" }
 *
 * On success returns the same shape as /api/auth/login:
 *   { success: true, email, credits_balance, created_at }
 *
 * New Google users receive 20 default credits and a random password.
 */
app.post('/api/auth/google', async (req, res) => {
    console.log('[GOOGLE AUTH] ======== INCOMING GOOGLE AUTH REQUEST ========');

    try {
        // Guard: req.body might be undefined if JSON parse failed
        if (!req.body || typeof req.body !== 'object') {
            console.log('[GOOGLE AUTH] FAIL — req.body is not an object');
            return res.status(400).json({ success: false, error: 'Invalid request body. Expected JSON.' });
        }

        const { idToken } = req.body;
        if (!idToken || typeof idToken !== 'string') {
            console.log('[GOOGLE AUTH] FAIL — missing or invalid idToken');
            return res.status(400).json({ success: false, error: 'Google ID token is required.' });
        }

        // Verify the Google ID token
        console.log('[GOOGLE AUTH] Verifying ID token with Google...');
        let payload;
        try {
            const ticket = await googleAuthClient.verifyIdToken({
                idToken: idToken,
                audience: GOOGLE_CLIENT_ID
            });
            payload = ticket.getPayload();
        } catch (verifyErr) {
            console.error('[GOOGLE AUTH] Token verification failed:', verifyErr.message);
            return res.status(401).json({ success: false, error: 'Google authentication failed. Token tidak valid.' });
        }

        const googleEmail = (payload.email || '').trim().toLowerCase();
        if (!googleEmail) {
            console.log('[GOOGLE AUTH] FAIL — no email in Google payload');
            return res.status(400).json({ success: false, error: 'Google account does not have a verified email.' });
        }

        console.log(`[GOOGLE AUTH] Verified Google email: ${googleEmail}`);
        console.log(`[GOOGLE AUTH] Name: ${payload.name || '(not provided)'}`);

        // Look up or create user in MongoDB
        const key = googleEmail;
        let isNewUser = false;
        let user;

        try {
            user = await db.User.findOne({ email: key });
            if (user) {
                // Existing user: update last_activity_date to track login activity
                await db.User.findOneAndUpdate(
                    { email: key },
                    { $set: { last_activity_date: new Date() } }
                );
                console.log('[GOOGLE AUTH] Existing user found:', key);
            } else {
                console.log('[GOOGLE AUTH] New Google user — creating account:', key);

                // ── Anti-abuse: check if this email has ever claimed the welcome gift ──
                let alreadyClaimed = false;
                try {
                    const claimed = await db.ClaimedWelcomeGift.findOne({ email: key });
                    alreadyClaimed = !!claimed;
                } catch (_) { /* collection may not exist yet — safe fallback */ }

                user = await db.User.create({
                    email: key,
                    password: crypto.randomBytes(16).toString('hex'),
                    credits_balance: alreadyClaimed ? 0 : 60,
                    last_activity_date: new Date()
                });

                if (!alreadyClaimed) {
                    // Permanent record: this email can never claim the welcome gift again
                    try {
                        await db.ClaimedWelcomeGift.create({ email: key, claimed_at: new Date() });
                    } catch (claimErr) {
                        if (claimErr.code !== 11000) console.error('[GOOGLE AUTH] ClaimedWelcomeGift create error:', claimErr.message);
                    }
                    // Record the gift as a transaction for the purchase history modal
                    await db.Transaction.create({
                        invoice_number: 'gift_welcome_' + Date.now(),
                        email: key,
                        amount: 0,
                        credits: 60,
                        type: 'gift',
                        description: 'New Account Gift',
                        status: 'success',
                        created_at: new Date()
                    });
                    console.log(`[GOOGLE AUTH] Welcome gift of 60 credits granted to ${key}`);
                } else {
                    console.log(`[GOOGLE AUTH] ${key} already claimed welcome gift before — no bonus credits`);
                }

                isNewUser = true;
                console.log(`[GOOGLE AUTH] New user created in MongoDB: ${key} (${user.credits_balance} credits)`);
            }
        } catch (dbErr) {
            console.error('[GOOGLE AUTH] MongoDB error:', dbErr.message);
            return res.status(500).json({ success: false, error: 'Database error. Please try again later.' });
        }

        // ═══ Check and apply credit expiration before returning balance ═══
        const expireResult = await checkAndExpireCredits(key);
        const effectiveBalance = expireResult.balance !== null ? expireResult.balance : (user.credits_balance || 0);

        const responsePayload = {
            success: true,
            email: key,
            credits_balance: effectiveBalance,
            created_at: user.created_at || new Date().toISOString(),
            is_new_user: isNewUser
        };
        console.log('[GOOGLE AUTH] SUCCESS — responding with:', JSON.stringify(responsePayload));
        return res.json(responsePayload);

    } catch (err) {
        console.error('');
        console.error('╔══════════════════════════════════════════════════════╗');
        console.error('║  [GOOGLE AUTH CRASH DETECTED]                        ║');
        console.error('╚══════════════════════════════════════════════════════╝');
        console.error('[GOOGLE AUTH CRASH] Message:', err.message);
        console.error('[GOOGLE AUTH CRASH] Stack:', err.stack);
        console.error('');
        return res.status(500).json({
            success: false,
            error: 'Server crashed during Google authentication.',
            details: err.message || 'Unknown error'
        });
    }
});

/**
 * POST /api/auth/admin-google
 * ------------------------------------------------------------------
 * Admin-only Google Sign-In. Verifies the Google ID token, then checks
 * that the email is STRICTLY admin.fotowisuda@gmail.com.
 *
 * On success: sets a secure httpOnly cookie (admin_session) and returns 200.
 * On failure: returns 403 Forbidden.
 *
 * Body: { idToken: "<Google ID token>" }
 */
app.post('/api/auth/admin-google', async (req, res) => {
    console.log('[ADMIN AUTH] ======== INCOMING ADMIN GOOGLE AUTH REQUEST ========');

    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid request body.' });
        }

        const { idToken } = req.body;
        if (!idToken || typeof idToken !== 'string') {
            return res.status(400).json({ success: false, error: 'Google ID token is required.' });
        }

        // Verify the Google ID token
        let payload;
        try {
            const ticket = await googleAuthClient.verifyIdToken({
                idToken: idToken,
                audience: GOOGLE_CLIENT_ID
            });
            payload = ticket.getPayload();
        } catch (verifyErr) {
            console.error('[ADMIN AUTH] Token verification failed:', verifyErr.message);
            return res.status(401).json({ success: false, error: 'Google authentication failed.' });
        }

        const googleEmail = (payload.email || '').trim().toLowerCase();
        console.log(`[ADMIN AUTH] Verified Google email: ${googleEmail}`);

        // STRICT CHECK: only the designated admin email is allowed
        if (googleEmail !== ADMIN_EMAIL) {
            console.warn(`[ADMIN AUTH] BLOCKED — ${googleEmail} is not the admin`);
            return res.status(403).json({
                success: false,
                error: 'Akses Ditolak',
                message: 'Hanya admin.fotowisuda@gmail.com yang diizinkan mengakses halaman admin.'
            });
        }

        // Set secure admin session cookie
        const token = createAdminToken(googleEmail);
        res.cookie('admin_session', token, {
            httpOnly: true,
            secure: false,           // set to true in production with HTTPS
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,  // 24 hours
            path: '/'
        });

        console.log('[ADMIN AUTH] SUCCESS — admin session granted to:', googleEmail);
        return res.json({ success: true, email: googleEmail, message: 'Admin authenticated.' });

    } catch (err) {
        console.error('[ADMIN AUTH CRASH]', err.message);
        return res.status(500).json({
            success: false,
            error: 'Server crashed during admin authentication.',
            details: err.message || 'Unknown error'
        });
    }
});

/**
 * GET /api/health
 * Debug endpoint — verifies the server can read/write credits.json.
 * Returns user count, package count, and whether bambang@gmail.com exists.
 */
app.get('/api/health', async (_req, res) => {
    try {
        const db = await readCreditsDB();
        const bambang = db.users['bambang@gmail.com'];
        res.json({
            status: 'ok',
            users_count: Object.keys(db.users || {}).length,
            transactions_count: (db.transactions || []).length,
            packages_count: (db.packages || []).length,
            bambang_exists: !!bambang,
            bambang_credits: bambang ? bambang.credits_balance : null,
            bambang_has_password: bambang ? !!bambang.password : null,
            user_emails: Object.keys(db.users || {})
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ------------------------------------------------------------------
// Credit System API Endpoints
// ------------------------------------------------------------------

/**
 * GET /api/credits/balance
 * Returns the user's current credit balance and available top-up packages.
 * Query: ?email=budi@gmail.com
 */
app.get('/api/credits/balance', async (req, res) => {
    try {
        const email = req.query.email || '';
        if (!email) {
            return res.status(400).json({ error: 'Email parameter is required.' });
        }
        const user = await ensureUserExists(email);
        if (!user) {
            return res.status(503).json({ error: 'Layanan sementara tidak tersedia. Silakan coba lagi.' });
        }

        // ═══ Check and expire stale credits ═══
        const expireResult = await checkAndExpireCredits(email);

        const packages = getCreditPackages();
        res.json({
            email: user.email,
            credits_balance: expireResult.balance !== null ? expireResult.balance : (user.credits_balance || 0),
            created_at: user.created_at || new Date().toISOString(),
            packages: packages,
            credits_expired: expireResult.expired || false
        });
    } catch (err) {
        console.error('[/api/credits/balance] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve credit balance.' });
    }
});

/**
 * GET /api/user/transactions
 * Returns the full payment/transaction history for a user.
 * Query: ?email=budi@gmail.com
 *
 * Response: array of {
 *   date, invoice_number, amount, credits, package_name, package_id, status, type
 * } sorted newest-first.
 */
app.get('/api/user/transactions', async (req, res) => {
    try {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ error: 'Email parameter is required.' });
        }

        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        // ═══ Auto-expire pending transactions older than 60 minutes ═══
        // If a user starts a payment but doesn't complete it within 60 min,
        // the transaction is marked as failed and 0 credits are granted.
        const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 60 minutes ago
        const expiredResult = await db.Transaction.updateMany(
            { email, status: 'pending', created_at: { $lt: cutoff } },
            { $set: { status: 'failed', credits: 0 } }
        );
        if (expiredResult.modifiedCount > 0) {
            console.log(`  [api/user/transactions] Auto-expired ${expiredResult.modifiedCount} pending transaction(s) for ${email}`);
        }

        const packages = getCreditPackages();
        // Only return purchases/refunds/gifts — exclude usage, deduction, and expiry records
        const txns = await db.Transaction.find({ email, type: { $nin: ['usage', 'deduction', 'expiry'] } }).sort({ created_at: -1 }).lean();

        const enriched = txns.map(txn => {
            const pkg = packages.find(p => p.package_id === txn.package_id);
            const amount = txn.amount || 0;
            let credits = txn.credits || pkg?.credits_given || 0;
            // Gift transactions use description as package name
            let packageName;
            if (txn.type === 'gift') {
                packageName = txn.description || 'New Account Gift';
            } else {
                packageName = pkg ? pkg.name : (txn.package_id || '');
            }
            if (!packageName && !txn.package_id) packageName = amount > 0 ? amount + ' Kredit' : '—';

            return {
                date: txn.created_at || '',
                invoice_number: txn.invoice_number || '',
                amount: amount,
                credits: credits,
                package_name: packageName,
                package_id: txn.package_id || '',
                status: txn.status || 'pending',
                type: txn.type || 'top-up'
            };
        });

        console.log(`  [api/user/transactions] ${email} → ${enriched.length} transactions`);
        res.json(enriched);
    } catch (err) {
        console.error('[/api/user/transactions] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve transaction history.' });
    }
});

/**
 * GET /api/user/usages
 * GET /api/user/usages — returns credit usage history from MongoDB
 */
app.get('/api/user/usages', async (req, res) => {
    try {
        const email = (req.query.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ error: 'Email parameter is required.' });
        }

        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        // Query transactions with type 'usage' (credit deductions from generations)
        const txns = await db.Transaction.find({ email, type: 'usage' })
            .sort({ created_at: -1 })
            .lean();

        const usages = txns.map(txn => ({
            date: txn.created_at || '',
            action: txn.description || txn.package_id || 'Penggunaan Kredit',
            credits_used: Math.abs(txn.credits) || 1
        }));

        res.json(usages);
    } catch (err) {
        console.error('[/api/user/usages] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve credit usage history.' });
    }
});

/**
 * POST /api/payment/request-qris
 * Generates a QRIS code for credit top-up via DOKU Direct QRIS API.
 * Body: { email, package_id }
 * Returns: { invoice_number, payment_url, amount, expires_at, instructions[] }
 */
app.post('/api/payment/request-qris', async (req, res) => {
    try {
        const { email, package_id } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });
        if (!package_id) return res.status(400).json({ error: 'Package ID is required.' });

        const packages = getCreditPackages();
        const pkg = packages.find(p => p.package_id === package_id);
        if (!pkg) return res.status(400).json({ error: 'Invalid package ID.' });

        const invoiceNumber = 'INV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min expiry

        // Log pending transaction in MongoDB
        if (db.isConnected()) {
            await db.Transaction.create({
                invoice_number: invoiceNumber,
                email: email.trim().toLowerCase(),
                package_id: package_id,
                amount: pkg.price,
                credits: pkg.credits_given,
                type: 'top-up',
                status: 'pending'
            });
        }

        let paymentUrl = null;

        // --- Attempt DOKU Checkout creation (QRIS-restricted) ---
        try {
            const dokuResult = await createDokuCheckout({
                email, package_id,
                invoice_number: invoiceNumber,
                amount: pkg.price
            });
            paymentUrl = dokuResult.payment_url || null;
            console.log(`  [payment] DOKU Checkout — invoice: ${invoiceNumber} | url: ${paymentUrl || 'N/A'}`);
        } catch (dokuErr) {
            console.error('  [payment] DOKU Checkout API call FAILED:', dokuErr.message);
            console.error('  [payment] DOKU raw response:', dokuErr.dokuRaw || '(none)');
            const httpStatus = dokuErr.statusCode || 502;

            // Build a user-friendly message based on the HTTP status
            let userMessage = dokuErr.message || 'DOKU API tidak merespon';
            if (dokuErr.statusCode === 500) {
                userMessage = 'DOKU gateway mengalami internal error (500). Silakan coba lagi nanti atau hubungi support.';
            } else if (dokuErr.statusCode === 401 || dokuErr.statusCode === 403) {
                userMessage = 'Konfigurasi gateway pembayaran bermasalah (auth). Silakan hubungi admin.';
            } else if (dokuErr.statusCode === 404) {
                userMessage = 'Endpoint gateway pembayaran tidak ditemukan. Silakan hubungi admin.';
            }

            return res.status(httpStatus).json({
                success: false,
                error: 'Gagal membuat sesi pembayaran — gateway error',
                message: userMessage,
                details: dokuErr.dokuRaw || null
            });
        }

        if (!paymentUrl) {
            console.error('  [payment] DOKU returned 200 but no payment_url — response format mismatch');
            return res.status(502).json({
                success: false,
                error: 'Respon DOKU tidak dikenali',
                message: 'Gateway pembayaran mengembalikan format yang tidak diharapkan. Silakan coba lagi.'
            });
        }

        const instructions = [
            { step: 1, text: 'Anda akan diarahkan ke halaman pembayaran DOKU' },
            { step: 2, text: 'Pilih metode <b>QRIS</b> pada halaman checkout' },
            { step: 3, text: 'Scan kode QR yang muncul menggunakan e-wallet atau m-banking Anda' },
            { step: 4, text: `Konfirmasi pembayaran sebesar <b>Rp ${pkg.price.toLocaleString('id-ID')}</b>` },
            { step: 5, text: 'Setelah berhasil, kredit akan otomatis bertambah' }
        ];

        console.log(`  [payment] Invoice ${invoiceNumber} — ${email} → ${pkg.name} (Rp ${pkg.price})`);
        console.log(`  [payment] >>> RESPONSE PAYLOAD:`, JSON.stringify({
            payment_url: paymentUrl,
            invoice_number: invoiceNumber
        }));
        res.json({
            success: true,
            invoice_number: invoiceNumber,
            payment_url: paymentUrl,
            amount: pkg.price,
            amount_formatted: 'Rp ' + pkg.price.toLocaleString('id-ID'),
            credits_given: pkg.credits_given,
            package_name: pkg.name,
            expires_at: expiresAt,
            expires_in_seconds: 15 * 60,
            instructions: instructions
        });
    } catch (err) {
        console.error('[/api/payment/request-qris] Error:', err);
        res.status(500).json({ error: 'Failed to generate QRIS code.' });
    }
});

/**
 * POST /api/credits/top-up
 * Initiates a DOKU QRIS payment to purchase credits.
 * Body: { email, package_id }
 * Returns: { invoice_number, payment_url, package }
 */
app.post('/api/credits/top-up', async (req, res) => {
    try {
        const { email, package_id } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });
        if (!package_id) return res.status(400).json({ error: 'Package ID is required.' });

        const packages = getCreditPackages();
        const pkg = packages.find(p => p.package_id === package_id);
        if (!pkg) return res.status(400).json({ error: 'Invalid package ID.' });

        const invoiceNumber = 'INV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

        // Log pending transaction in MongoDB
        if (db.isConnected()) {
            await db.Transaction.create({
                invoice_number: invoiceNumber,
                email: email.trim().toLowerCase(),
                package_id: package_id,
                amount: pkg.price,
                credits: pkg.credits_given,
                type: 'top-up',
                status: 'pending'
            });
        }

        // --- Attempt DOKU Checkout creation (QRIS-restricted) ---
        let paymentResult = null;
        try {
            paymentResult = await createDokuCheckout({
                email: email,
                package_id: package_id,
                invoice_number: invoiceNumber,
                amount: pkg.price
            });
        } catch (dokuErr) {
            console.error('  [credits] DOKU Checkout API unavailable:', dokuErr.message);
            console.error('  [credits] DOKU raw response:', dokuErr.dokuRaw || '(none)');

            // If sandbox simulation is explicitly enabled, fall back to simulated payment
            if (process.env.DOKU_SANDBOX_MODE === 'true') {
                console.warn('  [credits] DOKU_SANDBOX_MODE=true — using simulated payment URL');
                paymentResult = {
                    invoice_number: invoiceNumber,
                    payment_url: 'https://fotowisuda.ai/api/payments/doku-callback?simulate=1&invoice=' + encodeURIComponent(invoiceNumber) + '&email=' + encodeURIComponent(email) + '&package=' + encodeURIComponent(package_id)
                };
            } else {
                // Mark transaction as failed — no credits without real payment
                const db2 = await readCreditsDB();
                const txn2 = db2.transactions.find(t => t.invoice_number === invoiceNumber);
                if (txn2) txn2.status = 'failed';
                writeCreditsDB(db2);

                let userMessage = 'Gateway DOKU tidak dapat dijangkau: ' + (dokuErr.message || 'unknown error');
                if (dokuErr.statusCode === 500) {
                    userMessage = 'DOKU gateway mengalami internal error (500). Silakan coba lagi nanti atau hubungi support.';
                } else if (dokuErr.statusCode === 401 || dokuErr.statusCode === 403) {
                    userMessage = 'Konfigurasi gateway pembayaran bermasalah (auth). Silakan hubungi admin.';
                }

                const httpStatus = dokuErr.statusCode || 502;
                return res.status(httpStatus).json({
                    success: false,
                    error: 'Layanan pembayaran sedang tidak tersedia',
                    message: userMessage
                });
            }
        }

        console.log(`  [credits] Top-up initiated — ${email} → ${pkg.name} (Rp ${pkg.price}, ${pkg.credits_given} credits, invoice: ${invoiceNumber})`);
        res.json({
            success: true,
            invoice_number: invoiceNumber,
            payment_url: paymentResult.payment_url,
            package: pkg
        });
    } catch (err) {
        console.error('[/api/credits/top-up] Error:', err);
        res.status(500).json({ error: 'Failed to initiate top-up.' });
    }
});

/**
 * POST /api/payments/doku-callback
 * DOKU webhook endpoint — called when a payment is completed.
 *
 * ═══ PASTE THIS URL INTO YOUR DOKU DASHBOARD ═══
 *   https://fotowisuda.ai/api/payments/doku-callback
 * ════════════════════════════════════════════════════
 */
app.post('/api/payments/doku-callback', async (req, res) => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  [WEBHOOK INCOMING] DOKU callback received!          ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('[WEBHOOK INCOMING] Method:', req.method);
    console.log('[WEBHOOK INCOMING] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[WEBHOOK INCOMING] Body:', JSON.stringify(req.body, null, 2));

    try {
        const isSimulated = req.query.simulate === '1';

        if (isSimulated) {
            // --- Sandbox simulation mode — only when explicitly enabled ---
            if (process.env.DOKU_SANDBOX_MODE !== 'true') {
                return res.status(403).json({
                    error: 'Sandbox simulation is disabled.',
                    message: 'Set DOKU_SANDBOX_MODE=true in .env to enable payment simulation for testing.'
                });
            }
            const { invoice, email, package: packageId } = req.query;
            if (!invoice || !email || !packageId) {
                return res.status(400).json({ error: 'Missing invoice, email, or package query params for simulation.' });
            }

            const packages = getCreditPackages();
            const pkg = packages.find(p => p.package_id === packageId);
            if (!pkg) return res.status(400).json({ error: 'Invalid package ID.' });

            const credits = pkg.credits_given;
            addCredits(email, credits, invoice);

            console.log(`  [doku-callback] SANDBOX SIM — ${email} received ${credits} credits (invoice: ${invoice})`);

            // Return HTML page for browser, JSON for programmatic calls
            if (req.method === 'GET') {
                return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pembayaran Berhasil — fotowisuda.ai</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,sans-serif;background:#0A0C10;color:#F0F6FC;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#161B22;border:1px solid #30363D;border-radius:24px;padding:40px 32px;max-width:400px;width:100%}.check{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#22c55e,#16a34a);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px}.check::after{content:'\\2713';color:#fff}h2{font-size:20px;font-weight:700;margin-bottom:8px}.email{color:#00D1FF;font-weight:600}.credits{font-size:32px;font-weight:800;color:#22c55e;margin:16px 0}.detail{font-size:13px;color:#8B949E;margin-bottom:24px}.btn{display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#9D5BFF,#00D1FF);color:#fff;border-radius:14px;text-decoration:none;font-size:13px;font-weight:700}</style></head>
<body><div class="card"><div class="check"></div><h2>Pembayaran Berhasil!</h2><p class="detail"><span class="email">${email}</span> telah menerima</p><div class="credits">+${credits} Kredit</div><p class="detail">Invoice: ${invoice}<br>Paket: ${pkg.name}</p><a href="/" class="btn">Kembali ke Beranda</a></div></body></html>`);
            }
            return res.status(200).json({ success: true, message: 'Sandbox payment simulated successfully.', credits_added: credits });
        }

        // --- Production webhook — supports DOKU Legacy flat payload + SNAP BI nested payload ---
        console.log(`  [doku-callback] Incoming webhook body:`, JSON.stringify(req.body));
        console.log(`  [doku-callback] Incoming webhook headers:`, JSON.stringify(req.headers));

        // Detect payload format:
        //   Legacy: flat TRANSIDMERCHANT/STATUSCODE/AMOUNT
        //   SNAP BI: nested with order + payment_status
        //   Nested Direct: order.invoice_number + transaction.status (actual DOKU production payload)
        const isLegacy = req.body.TRANSIDMERCHANT || req.body.ORDERID;
        const isSnapBi = req.body.order && req.body.payment_status;
        const isNestedDirect = req.body.transaction && req.body.transaction.status && req.body.order;

        let invoice_number, userEmail, paymentSuccess;
        let packageId = '';

        if (isLegacy) {
            // ═══ DOKU Legacy Notification ═══
            invoice_number = req.body.TRANSIDMERCHANT || req.body.ORDERID || '';
            const statusCode = req.body.STATUSCODE || req.body.RESULTCODE || '';
            paymentSuccess = statusCode === '0000' || statusCode === '00';
            userEmail = req.body.EMAIL || req.body.CUSTEMAIL || '';
            const amountRaw = Math.round(parseFloat(req.body.AMOUNT || '0'));

            // Map amount to credits and package
            if (amountRaw === 29000) { packageId = 'pkg_starter_29k'; }
            else if (amountRaw === 49000) { packageId = 'pkg_populer_49k'; }
            else if (amountRaw === 149000) { packageId = 'pkg_creator_149k'; }
            else if (amountRaw === 299000) { packageId = 'pkg_studio_299k'; }
            else { packageId = ''; }

            console.log(`  [doku-callback] LEGACY — invoice: ${invoice_number}, status: ${statusCode}, amount: ${amountRaw}, email: ${userEmail}, pkg: ${packageId}`);
        } else if (isSnapBi) {
            // ═══ DOKU SNAP BI Notification ═══
            const rawBody = JSON.stringify(req.body);
            const isValid = verifyDokuSignature(req.headers, rawBody);
            if (!isValid) {
                console.warn('  [doku-callback] Invalid SNAP BI signature — request rejected');
                return res.status(401).json({ error: 'Invalid signature.' });
            }
            invoice_number = req.body.invoice_number || '';
            paymentSuccess = req.body.payment_status === 'SUCCESS';
            userEmail = (req.body.order || {}).virtual_account?.email || req.body.customer?.email || '';
            packageId = req.body.additional_info?.package_id || '';
            console.log(`  [doku-callback] SNAP BI — invoice: ${invoice_number}, status: ${req.body.payment_status}, email: ${userEmail}`);
        } else if (isNestedDirect) {
            // ═══ DOKU Nested Direct Notification (Production) ═══
            // Payload shape: { order: { invoice_number, amount }, transaction: { status }, additional_info: { package_id } }
            invoice_number = req.body.order?.invoice_number || '';
            paymentSuccess = req.body.transaction?.status === 'SUCCESS';
            const amountRaw = Math.round(parseFloat(req.body.order?.amount || '0'));

            // Priority: explicit package_id from additional_info, then map from amount
            packageId = req.body.additional_info?.package_id || '';
            if (!packageId) {
                if (amountRaw === 29000)      { packageId = 'pkg_starter_29k'; }
                else if (amountRaw === 49000)  { packageId = 'pkg_populer_49k'; }
                else if (amountRaw === 149000) { packageId = 'pkg_creator_149k'; }
                else if (amountRaw === 299000) { packageId = 'pkg_studio_299k'; }
            }

            // Try to extract email from various nested locations, or fall back to transaction lookup
            userEmail = req.body.customer?.email
                     || req.body.order?.customer?.email
                     || req.body.order?.virtual_account?.email
                     || '';

            console.log(`  [doku-callback] NESTED DIRECT — invoice: ${invoice_number}, status: ${req.body.transaction?.status}, amount: ${amountRaw}, email: ${userEmail || '(via txn lookup)'}, pkg: ${packageId}`);
        } else {
            console.warn('  [doku-callback] Unrecognized payload format — body keys:', Object.keys(req.body).join(', '));
            return res.status(200).send('CONTINUE'); // Return 200 to stop DOKU retries even on unrecognized
        }

        if (paymentSuccess) {
            const packages = getCreditPackages();
            const pkg = packages.find(p => p.package_id === packageId);
            const credits = pkg ? pkg.credits_given : 0;

            // If Legacy and no email found, try to match via transaction record
            if (!userEmail) {
                const db = await readCreditsDB();
                const txn = db.transactions.find(t => t.invoice_number === invoice_number);
                if (txn) userEmail = txn.email;
            }

            if (credits > 0 && userEmail) {
                addCredits(userEmail, credits, invoice_number);
            }

            console.log(`  [doku-callback] PAYMENT SUCCESS — ${userEmail} received ${credits} credits (invoice: ${invoice_number})`);
        }

        // Return "CONTINUE" for Legacy, JSON for SNAP BI — DOKU expects 200 to stop retrying
        if (isLegacy) {
            return res.status(200).send('CONTINUE');
        }
        res.status(200).json({ message: 'Notification received.' });
    } catch (err) {
        console.error('[/api/payments/doku-callback] Error:', err);
        res.status(500).json({ error: 'Failed to process payment notification.' });
    }
});

// GET handler for sandbox simulation (opened in browser tab by frontend)
app.get('/api/payments/doku-callback', async (req, res) => {
    console.log('[WEBHOOK GET] Sandbox simulation request:', req.query);
    const isSimulated = req.query.simulate === '1';
    if (!isSimulated) {
        return res.status(405).send('Webhook endpoint — POST only for production notifications.');
    }
    if (process.env.DOKU_SANDBOX_MODE !== 'true') {
        return res.status(403).send('Sandbox simulation is disabled.');
    }
    const { invoice, email, package: packageId } = req.query;
    if (!invoice || !email || !packageId) {
        return res.status(400).send('Missing invoice, email, or package query params.');
    }
    const packages = getCreditPackages();
    const pkg = packages.find(p => p.package_id === packageId);
    if (!pkg) return res.status(400).send('Invalid package ID.');
    const credits = pkg.credits_given;
    addCredits(email, credits, invoice);
    console.log(`[WEBHOOK GET] SANDBOX — ${email} received ${credits} credits (invoice: ${invoice})`);
    res.status(200).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pembayaran Berhasil — fotowisuda.ai</title><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,sans-serif;background:#0A0C10;color:#F0F6FC;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#161B22;border:1px solid #30363D;border-radius:24px;padding:40px 32px;max-width:400px;width:100%}.check{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#22c55e,#16a34a);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px}.check::after{content:"\\2713";color:#fff}h2{font-size:20px;font-weight:700;margin-bottom:8px}.email{color:#00D1FF;font-weight:600}.credits{font-size:32px;font-weight:800;color:#22c55e;margin:16px 0}.detail{font-size:13px;color:#8B949E;margin-bottom:24px}.btn{display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#9D5BFF,#00D1FF);color:#fff;border-radius:14px;text-decoration:none;font-size:13px;font-weight:700}</style></head><body><div class="card"><div class="check"></div><h2>Pembayaran Berhasil!</h2><p class="detail"><span class="email">'+email+'</span> telah menerima</p><div class="credits">+'+credits+' Kredit</div><p class="detail">Invoice: '+invoice+'<br>Paket: '+pkg.name+'</p><a href="/" class="btn">Kembali ke Beranda</a></div></body></html>');
});

// ------------------------------------------------------------------
// Admin User Management API
// ------------------------------------------------------------------

/**
 * GET /api/admin/users
 * ------------------------------------------------------------------
 * Returns aggregated user data for the Admin "Kelola Pengguna" table.
 * Each user includes: email, createdAt, status, totalPurchases,
 * totalSpentRp, currentCredit, totalAccumulatedCredit.
 * Protected by requireAdminApi middleware.
 */
app.get('/api/admin/users', requireAdminApi, async (req, res) => {
    try {
        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        const users = await db.User.aggregate([
            // Exclude admin accounts from user management
            { $match: { role: { $ne: 'admin' } } },
            // Left-join with transactions collection
            {
                $lookup: {
                    from: 'transactions',
                    localField: 'email',
                    foreignField: 'email',
                    pipeline: [
                        { $match: { status: 'success' } }
                    ],
                    as: 'txns'
                }
            },
            // Shape the output
            {
                $project: {
                    email: 1,
                    created_at: 1,
                    credits_balance: 1,
                    // Soft-delete support: check isDeleted flag, default false
                    status: {
                        $cond: [
                            { $eq: [{ $ifNull: ['$isDeleted', false] }, true] },
                            'Deleted',
                            'Active'
                        ]
                    },
                    // Count of successful top-up transactions
                    totalPurchases: {
                        $size: {
                            $filter: {
                                input: '$txns',
                                as: 't',
                                cond: { $eq: ['$$t.type', 'top-up'] }
                            }
                        }
                    },
                    // Sum of all positive monetary amounts (IDR)
                    totalSpentRp: {
                        $sum: {
                            $map: {
                                input: '$txns',
                                as: 't',
                                in: {
                                    $cond: [
                                        { $gt: ['$$t.amount', 0] },
                                        '$$t.amount',
                                        0
                                    ]
                                }
                            }
                        }
                    },
                    // Sum of all positive credit additions
                    totalAccumulatedCredit: {
                        $sum: {
                            $map: {
                                input: '$txns',
                                as: 't',
                                in: {
                                    $cond: [
                                        { $gt: ['$$t.credits', 0] },
                                        '$$t.credits',
                                        0
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            // Newest users first
            { $sort: { created_at: -1 } }
        ]);

        console.log(`  [api/admin/users] Returned ${users.length} users`);
        res.json({ users });
    } catch (err) {
        console.error('[/api/admin/users] Error:', err);
        res.status(500).json({ error: 'Failed to retrieve user data.' });
    }
});

/**
 * POST /api/admin/users/gift
 * ------------------------------------------------------------------
 * Manually inject (gift) credits to a specific user.
 * Accepts { email, amount } in JSON body.
 * Protected by requireAdminApi middleware.
 *
 * Actions:
 *   a. Increments the user's credits_balance by `amount`.
 *   b. Inserts a Transaction record (type: "gift") so the user sees
 *      it in their own "Riwayat Pembelian" (credit history).
 */
app.post('/api/admin/users/gift', requireAdminApi, async (req, res) => {
    try {
        if (!db.isConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }

        const { email, amount } = req.body;
        const creditsToGift = parseInt(amount, 10);

        // --- Validation ---
        if (!email || typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ error: 'Email pengguna diperlukan.' });
        }
        if (!creditsToGift || creditsToGift <= 0) {
            return res.status(400).json({ error: 'Jumlah kredit harus lebih dari 0.' });
        }

        const key = email.trim().toLowerCase();

        // Ensure the user exists
        const userExists = await db.User.findOne({ email: key });
        if (!userExists) {
            return res.status(404).json({ error: 'Pengguna dengan email tersebut tidak ditemukan.' });
        }

        // --- Increment user credit balance ---
        const updatedUser = await db.User.findOneAndUpdate(
            { email: key },
            {
                $inc: { credits_balance: creditsToGift },
                $set: { updated_at: new Date(), last_activity_date: new Date() }
            },
            { returnDocument: 'after' }
        );

        // --- Insert gift transaction record ---
        const invoiceNumber = 'gift_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await db.Transaction.create({
            invoice_number: invoiceNumber,
            email: key,
            amount: 0,                         // Rp 0 — this is a free gift
            credits: creditsToGift,
            type: 'gift',
            description: 'Gift from Admin',
            status: 'success',
            created_at: new Date()
        });

        console.log(`  [api/admin/users/gift] +${creditsToGift} credits gifted to ${key} (balance: ${updatedUser.credits_balance})`);

        res.json({
            success: true,
            message: `${creditsToGift} kredit berhasil diberikan kepada ${key}.`,
            user: {
                email: updatedUser.email,
                credits_balance: updatedUser.credits_balance,
                created_at: updatedUser.created_at,
                status: updatedUser.isDeleted ? 'Deleted' : 'Active'
            }
        });
    } catch (err) {
        console.error('[/api/admin/users/gift] Error:', err);
        res.status(500).json({ error: 'Gagal memberikan kredit.' });
    }
});

// Admin User Management page (PROTECTED)
app.get('/admin-users', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_users.html')));
app.get('/admin_users', requireAdminPage, (_req, res) => sendHtmlNoCache(res, path.join(__dirname, 'admin_users.html')));

// ------------------------------------------------------------------
// Global error handlers
// ------------------------------------------------------------------

// Multer file-filter errors
app.use((err, _req, res, _next) => {
    if (err.message?.startsWith('Only image files')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
ensureDirectories();

// Connect to MongoDB Atlas (non-blocking — server starts even if DB is slow)
db.connectDB().then(() => {
    console.log('[mongodb] Database ready — all endpoints active');
}).catch(err => {
    console.error('[mongodb] Database connection failed:', err.message);
});

app.listen(PORT, () => {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         fotowisuda.ai  —  AI Generation Dashboard         ║');
    console.log(`║         Server running at http://localhost:${PORT}             ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                              ║');
    console.log('║    GET  /                  Dashboard                      ║');
    console.log('║    GET  /swap-bg           Background Change            ║');

    console.log('║    GET  /dress-swap        Dress Replicate                ║');
    console.log('║    GET  /generate          Filter Image Factory            ║');
    console.log('║    GET  /my-creations      My Creations                 ║');
    console.log('║    GET  /filter-gallery    Filter Gallery (Public)        ║');
    console.log('║    GET  /admin-gallery-filter  Filter Gallery Admin    ║');
	    console.log('║    GET  /filter-gallery-factory  Filter Gallery Factory   ║');
    console.log('║    POST /api/generate      Start generation               ║');
    console.log('║    GET  /api/status/:id    Poll generation status         ║');
    console.log('║    POST /api/background-swap     Start bg-swap pipeline    ║');
    console.log('║    GET  /api/background-swap/status/:id  Poll bg-swap      ║');

    console.log('║    POST /api/dress-swap/generate  Start dress-swap         ║');
    console.log('║    GET  /api/dress-swap/status/:id  Poll dress-swap        ║');
    console.log('║    GET  /api/admin-gallery-filter/images  Filtered images  ║');
    console.log('║    POST /api/admin-gallery-filter/swap   Start agf-swap    ║');
    console.log('║    GET  /api/admin-gallery-filter/status/:id  Poll agf     ║');
    console.log('║    POST /api/filter-gallery/swap         PUBLIC swap       ║');
    console.log('║    GET  /api/admin-creations  Admin-only creations          ║');
    console.log('║    POST /api/save-admin-generation  Save admin files       ║');
    console.log('║    POST /api/save-user-generation   Save user files         ║');
    console.log('║    GET  /api/gallery       List stored generations        ║');
    console.log('║    GET  /api/user-creations        List user creations (DB)    ║');
    console.log('║    GET  /api/user-creations-files  List user images (filesys)  ║');
    console.log('║    DELETE /api/gallery/:id  Delete a generation            ║');
    console.log('║    DELETE /api/user-creations/:filename  Delete user image  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║  🔔 COPY THIS WEBHOOK URL TO DOKU DASHBOARD:               ║');
    console.log('║                                                           ║');
    console.log('║  https://fotowisuda.ai/api/payments/doku-callback          ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  API key configured : ${LEONARDO_API_KEY ? '✓ Yes' : '✗ No  (create .env from .env.example)'}`);
    console.log(`  Gemini key configured: ${GEMINI_API_KEY ? '✓ Yes' : '✗ No  (required for Background Change)'}`);

    console.log(`  Leonardo v2 (create) : ${LEONARDO_BASE_V2}`);
    console.log(`  Leonardo v1 (upload/status) : ${LEONARDO_BASE_V1}`);
    console.log(`  Thumbnails dir : ${THUMBNAILS_DIR}`);
    console.log(`  References dir : ${REFERENCES_DIR}`);
    console.log(`  Admin Gen dir   : ${ADMIN_IMAGE_GEN_DIR}`);
    console.log(`  Admin Ref dir   : ${ADMIN_IMAGE_REF_DIR}`);
    console.log(`  Admin Prompt dir: ${ADMIN_PROMPT_DIR}`);
    console.log(`  User Gen dir   : ${USER_IMAGE_GEN_DIR}`);
    console.log(`  User Ref dir   : ${USER_IMAGE_REF_DIR}`);
    console.log(`  User Prompt dir: ${USER_PROMPT_DIR}`);
    console.log(`  Database       : ${DATABASE_PATH}`);
    console.log('');
});
