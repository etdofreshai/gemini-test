# Gemini Image Generation API

A self-hosted API server for generating images via Google Gemini, with full control over authentication and generated content.

## Features

- 🎨 **Image Generation**: Generate images from text prompts using Gemini 3.0 Pro
- 🔄 **Image-to-Image**: Use reference images to guide generation
- 📐 **Aspect Ratios**: Support for 1:1, 4:3, 3:4, 16:9, 9:16
- 🔐 **Remote Login**: Browser-based Google authentication with live screencast
- 🐳 **Docker Ready**: Production-ready container with Chromium + Xvfb
- 🏥 **Health Endpoint**: Built-in health monitoring

---

## Quick Start

### Prerequisites

- Node.js 22+ (or Docker)
- Google account with Gemini access

### Option 1: Docker (Recommended)

```bash
# Build the image
docker build -t gemini-image-gen .

# Run the container
docker run -d \
  -p 3000:3000 \
  -v gemini-profile:/app/.chrome-profile \
  --name gemini-api \
  gemini-image-gen

# Check health
curl http://localhost:3000/api/health
```

### Option 2: Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Or build and run production
npm run build
npm start
```

### Authentication

1. Open `http://localhost:3000` in your browser
2. Click **"Login"** to open the remote browser
3. Sign in to your Google account
4. Cookies are automatically captured and stored

**Alternative**: Set cookies manually in `.env`:

```bash
cp .env.example .env
# Edit .env with your __Secure-1PSID and __Secure-1PSIDTS cookies
```

---

## API Reference

### Base URL

```
http://localhost:3000/api
```

All endpoints return JSON unless otherwise specified.

---

### Health Check

```http
GET /api/health
```

Returns server health status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-02-27T12:00:00.000Z",
  "authenticated": true
}
```

---

### Authentication Status

```http
GET /api/status
```

Check if the server has valid authentication cookies.

**Response:**
```json
{
  "authenticated": true
}
```

---

### Get Login URL

```http
GET /api/login
```

Returns the URL for browser-based login.

**Response:**
```json
{
  "redirect": "/auth/remote-login"
}
```

---

### Generate Images

```http
POST /api/generate
Content-Type: multipart/form-data
```

Generate images from a text prompt, optionally with reference images.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✅ | Text description of the image (max 4000 chars) |
| `aspectRatio` | string | ❌ | One of: `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |
| `images` | file[] | ❌ | Reference images (max 10 files, 10MB each) |

**Supported image formats:** PNG, JPEG, WebP, GIF

**Request Example (cURL):**
```bash
curl -X POST http://localhost:3000/api/generate \
  -F "prompt=A serene mountain landscape at sunset" \
  -F "aspectRatio=16:9"
```

**Response:**
```json
{
  "images": [
    {
      "filename": "mountain_landscape.png",
      "mime": "image/png",
      "dimensions": [1024, 576],
      "url": "/images/uuid-here.png",
      "savedName": "uuid-here.png",
      "upscaleId": "550e8400-e29b-41d4-a716-446655440000",
      "upscaleLink": "/api/upscale-link/550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "metadata": {
    "conversationId": "c_abc123",
    "responseId": "resp_xyz",
    "modelName": "Gemini 3.0 Pro",
    "prompt": "A serene mountain landscape at sunset"
  }
}
```

**Note:** The `upscaleId` is a server-stored token that references the upscale metadata. It does not expose sensitive tokens like `imageToken` or `responseChunkId`. Upscale links are valid for 24 hours.

**Errors:**

| Code | Message |
|------|---------|
| 400 | Missing 'prompt' field |
| 400 | 'prompt' cannot be empty |
| 400 | 'prompt' exceeds maximum length of 4000 characters |
| 400 | Invalid aspect ratio. Allowed values: 1:1, 4:3, 3:4, 16:9, 9:16 |
| 401 | Not authenticated. Call GET /api/login first. |
| 413 | File too large. Maximum size is 10MB per file. |
| 500 | Generation error (see message for details) |

---

### Upscale Image (Programmatic)

```http
POST /api/upscale
Content-Type: application/json
```

Download a full-resolution (2K) version of a generated image. Requires the original tokens from the generate response.

**Note:** For most use cases, prefer the one-click upscale link (`upscaleLink`) returned in the generate response instead of this endpoint.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `imageToken` | string | ✅ | From generate response |
| `responseChunkId` | string | ✅ | From generate response |
| `conversationId` | string | ✅ | From generate response |
| `responseId` | string | ✅ | From generate response |
| `prompt` | string | ❌ | Original prompt (optional) |

**Request Example:**
```json
{
  "imageToken": "abc123...",
  "responseChunkId": "rc_xyz...",
  "conversationId": "c_abc123",
  "responseId": "resp_xyz",
  "prompt": "A serene mountain landscape"
}
```

**Response:**
```json
{
  "url": "/images/uuid-here.png",
  "savedName": "uuid-here.png",
  "mime": "image/png",
  "bytes": 2456789
}
```

---

### One-Click Upscale Link (Recommended)

```http
GET /api/upscale-link/:id
```

Perform a one-click upscale using a server-stored token. This is the recommended way to upscale images as it doesn't require storing or passing sensitive tokens.

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Upscale token from generate response (`upscaleId`) |

**Response:**

On success, returns a `302 Found` redirect to the upscaled image URL.

**Example:**
```bash
# One-click upscale - redirects to image
curl -L http://localhost:3000/api/upscale-link/550e8400-e29b-41d4-a716-446655440000
```

**Errors:**

| Code | Message | Code |
|------|---------|------|
| 400 | Invalid upscale link ID format | - |
| 404 | Upscale link not found or expired. Links are valid for 24 hours. | `UPSCALE_LINK_EXPIRED` |
| 401 | Not authenticated. Call GET /api/login first. | - |
| 500 | Generation error (see message for details) | - |

**Upscale Link Features:**
- **TTL**: Links expire after 24 hours
- **Capacity**: Maximum 1000 pending upscale links (LRU eviction)
- **Security**: Internal tokens are never exposed to clients

---

### List Generated Images

```http
GET /api/images
```

List all locally stored generated images.

**Response:**
```json
{
  "images": [
    {
      "filename": "uuid-1.png",
      "url": "/images/uuid-1.png",
      "bytes": 1234567,
      "createdAt": 1709030400000
    }
  ]
}
```

---

### Delete Single Image

```http
DELETE /api/images/{filename}
```

Delete a specific generated image.

**Response:**
```json
{
  "success": true,
  "deleted": "uuid-1.png"
}
```

**Errors:**

| Code | Message |
|------|---------|
| 404 | File not found |

---

### Bulk Delete Images

```http
DELETE /api/images
Content-Type: application/json
```

Delete multiple images at once.

**Request:**
```json
{
  "filenames": ["uuid-1.png", "uuid-2.png"]
}
```

**Response:**
```json
{
  "success": true,
  "deleted": ["uuid-1.png"],
  "errors": ["uuid-2.png: not found"]
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `__Secure-1PSID` | - | Google auth cookie (optional) |
| `__Secure-1PSIDTS` | - | Google auth cookie (optional) |
| `GOOGLE_COOKIES` | - | Full cookie string (alternative to above) |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary path |

---

## Development

### Available Scripts

```bash
# Development with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Type checking
npm run typecheck

# Lint code
npm run lint

# Lint and fix
npm run lint:fix

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
gemini-test/
├── src/
│   ├── server/
│   │   ├── index.ts          # Express server entry point
│   │   ├── routes/
│   │   │   ├── auth.ts       # Auth endpoints (/api/login, /api/status, /api/health)
│   │   │   ├── generate.ts   # Image generation endpoints
│   │   │   └── remote-login.ts # Remote browser login UI
│   │   └── lib/
│   │       ├── auth.ts       # Session restoration
│   │       ├── browser.ts    # Chromium CDP management
│   │       ├── cookies.ts    # Cookie storage
│   │       └── gemini.ts     # Gemini API client
│   └── client/
│       ├── api.ts            # API client types
│       └── main.ts           # Frontend entry
├── dist/                      # Built output
├── .chrome-profile/           # Persistent Chrome profile
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## Docker Deployment

### Build

```bash
docker build -t gemini-image-gen .
```

### Run

```bash
# Basic run
docker run -d -p 3000:3000 --name gemini-api gemini-image-gen

# With persistent profile (keeps login session)
docker run -d \
  -p 3000:3000 \
  -v gemini-profile:/app/.chrome-profile \
  --name gemini-api \
  gemini-image-gen

# With environment cookies
docker run -d \
  -p 3000:3000 \
  -e "__Secure-1PSID=your_value" \
  -e "__Secure-1PSIDTS=your_value" \
  --name gemini-api \
  gemini-image-gen
```

### Docker Compose

```yaml
version: '3.8'
services:
  gemini-api:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - gemini-profile:/app/.chrome-profile
    restart: unless-stopped

volumes:
  gemini-profile:
```

---

## Security Considerations

1. **Cookie Storage**: Cookies are stored in memory and optionally in `.env`. In production, use secure storage.

2. **Network Access**: The API has no built-in authentication. Deploy behind a reverse proxy with auth (e.g., nginx + basic auth, Cloudflare Access).

3. **File Uploads**: 
   - Max 10 files per request
   - Max 10MB per file
   - Only image types allowed (PNG, JPEG, WebP, GIF)

4. **Rate Limiting**: Consider adding rate limiting for production use.

5. **HTTPS**: Always use HTTPS in production.

---

## Troubleshooting

### "Not authenticated" error

1. Visit `/auth/remote-login` to log in via browser
2. Or set `__Secure-1PSID` and `__Secure-1PSIDTS` in `.env`

### Chromium fails to start (Docker)

Ensure the container has sufficient memory:
```bash
docker run --memory=2g ...
```

### D-Bus/System Bus warnings in logs

When running Chromium in a container, you may see warnings like:
```
Failed to connect to the bus: Failed to connect to socket /run/dbus/system_bus_socket
```

These are **harmless** and occur because containers lack a D-Bus daemon. The server:
- Sets `DBUS_SESSION_BUS_ADDRESS=/dev/null` to suppress connection attempts
- Adds Chromium flags to disable D-Bus-dependent features
- Filters known harmless warnings from stderr output

If you see other Chromium errors, they will still be logged. Only D-Bus-related noise is suppressed.

### Cookies expired

Google session cookies expire periodically. Re-authenticate via the login UI.

---

## License

MIT
