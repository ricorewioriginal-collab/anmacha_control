# AirDeck als Server im Docker-Container (24/7-Automation, Studio im Browser, Android-App verbindet sich hierher)
FROM node:22-slim

# ffmpeg: Decoder, Encoder (MP3/LAME, AAC, Opus), Processing – aus Debian (libmp3lame, libopus enthalten)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY studio ./studio
COPY README.md HAFTUNGSAUSSCHLUSS.md ./

ENV NODE_ENV=production \
    AIRDECK_DATA=/data \
    AIRDECK_HOST=0.0.0.0 \
    AIRDECK_PORT=8750

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8750

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AIRDECK_PORT||8750)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini: saubere Signale (Stop → Zustand speichern, Encoder beenden)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server/main.ts", "--headless"]
