FROM node:22-slim AS build

WORKDIR /app

# Skip Puppeteer's bundled Chromium during build
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime ---
FROM node:22-slim

# Chromium deps for headless Puppeteer (session restore)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium instead of Puppeteer's bundled one
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

RUN mkdir -p tmp

# Pass cookies via env vars:
#   docker run -e __Secure-1PSID=... -e __Secure-1PSIDTS=... -p 3000:3000 gemini-image-gen
# Or use GOOGLE_COOKIES="__Secure-1PSID=...;__Secure-1PSIDTS=..."
# Note: Browser login (headless: false) is not available in Docker.
CMD ["node", "dist/server/index.js"]
