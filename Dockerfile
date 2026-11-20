# ---------- Stage 1: build ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV TORRENT_PATH=/tmp/torrents
ENV PORT=3000
ENV HOST=0.0.0.0

# prod deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# writable torrent cache
RUN mkdir -p /tmp/torrents && chown -R node:node /tmp/torrents
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/vlc-status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
