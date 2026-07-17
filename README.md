# fotowisuda.ai — AI Image Generation Dashboard

A local full-stack web application that provides a Leonardo.ai-inspired dashboard for generating AI images. The frontend is built with Tailwind CSS (glassmorphic dark theme) and the backend is an Express.js server that securely proxies requests to the Leonardo.ai API.

---

## Quick Start

### 1. Prerequisites

- **Node.js** v18 or later ([download](https://nodejs.org/))
- **Leonardo.ai API Key** ([get one here](https://app.leonardo.ai/api-access))

### 2. Install Dependencies

```bash
cd 260710_fw_ai_5
npm install
```

### 3. Configure Your API Key

```bash
# Copy the example environment file
cp .env.example .env
```

Open `.env` in your editor and replace `your_leonardo_api_key_here` with your actual Leonardo.ai API key:

```
LEONARDO_API_KEY=ln-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

### 4. Start the Server

```bash
npm start
```

Or use dev mode with auto-reload (Node 18+):

```bash
npm run dev
```

### 5. Open the Dashboard

Navigate to **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## Project Architecture

```
260710_fw_ai_5/
├── server.js          # Express backend — API proxy, image upload, Leonardo integration
├── code.html          # Frontend dashboard — Tailwind CSS + vanilla JS
├── package.json       # Node.js dependencies
├── .env.example       # Environment variable template
├── .env               # Your secrets (git-ignored)
├── .gitignore
├── prd_5.md           # Product requirements document
├── DESIGN.md          # Design system tokens
└── README.md          # This file
```

### How It Works

```
┌──────────────┐     FormData (multipart)      ┌──────────────┐     JSON (API key auth)     ┌─────────────────┐
│              │  ──────────────────────────▶   │              │  ───────────────────────▶   │                 │
│  code.html   │     POST /api/generate         │  server.js   │     Leonardo REST API      │  Leonardo.ai    │
│  (browser)   │  ◀──────────────────────────   │  (Node.js)   │  ◀───────────────────────   │  Cloud API      │
│              │     { generationId }            │              │     generation status       │                 │
└──────────────┘                                └──────────────┘                             └─────────────────┘
       │                                               │
       │  GET /api/status/:id (poll every 2s)          │
       │  ◀────────────────────────────────────────    │
       │                                               │
       ▼                                               ▼
  Progress bar                                    Image upload to
  animates while                                  Leonardo (presigned
  polling status                                  URL), then generation
                                                   creation + polling
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the dashboard frontend |
| `POST` | `/api/generate` | Start image generation (multipart/form-data) |
| `GET` | `/api/status/:generationId` | Poll generation status |

### POST /api/generate

Accepts `multipart/form-data`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | text | Yes | Image generation prompt |
| `width` | text | Yes | Image width in pixels |
| `height` | text | Yes | Image height in pixels |
| `referenceImage1` | file | No | First reference image |
| `referenceImage2` | file | No | Second reference image |

Returns: `{ generationId: string, status: "PENDING" }`

### GET /api/status/:generationId

Returns: `{ status: "PENDING"|"PROCESSING"|"COMPLETE"|"FAILED", imageUrl?: string, error?: string }`

---

## Locked Parameters

The following are hardcoded per the PRD and not user-configurable:

| Parameter | Value |
|-----------|-------|
| Model | Nano Banana 2 |
| Prompt Enhance | OFF |
| Style | DYNAMIC |
| Quantity | 1 |
| Private Mode | ON |

---

## Troubleshooting

**"LEONARDO_API_KEY not set"**
→ Make sure `.env` exists and contains your key. Restart the server after editing.

**"CORS error" in browser**
→ The frontend must be accessed via `http://localhost:3000`, not by opening `code.html` directly as a file.

**"Upload init failed"**
→ Check that your Leonardo API key is valid and has not expired.

**Port 3000 is already in use**
→ Change `PORT=3001` (or another port) in `.env` and restart.
