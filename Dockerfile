# Tabi — one image for every role: single host, HA primary (Fly.io) or HA backup (home server).
FROM node:22-alpine
ARG TARGETARCH
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data

# Cloudflare Tunnel connector. Only started by the node that is currently serving.
RUN wget -qO /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-amd64}" \
 && chmod +x /usr/local/bin/cloudflared

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 # keep only the compact OCR models that the app serves
 && rm -rf node_modules/@tesseract.js-data/*/4.0.0 \
 && npm cache clean --force
COPY server ./server
COPY public ./public

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
