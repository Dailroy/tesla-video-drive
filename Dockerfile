FROM node:20-bookworm-slim

# ffmpeg - transcoding, yt-dlp - resolving YouTube/Twitch sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=8742 \
    ALT_PORT=80 \
    HWACCEL=auto

EXPOSE 80 8742

CMD ["node", "server/server.js"]
