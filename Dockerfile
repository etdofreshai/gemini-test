FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime ---
FROM node:22-slim

# Install Chromium and Xvfb (headed Chrome with virtual display = Google thinks it's real)
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
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Point browser.ts at the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Start Xvfb so Chromium can run headed (avoids Google bot detection)
ENV DISPLAY=:99

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

RUN mkdir -p tmp

# Entrypoint: start Xvfb, then the node server
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -nolisten tcp & sleep 1 && node dist/server/index.js"]
