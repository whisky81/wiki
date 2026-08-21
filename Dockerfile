FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN npm run build
RUN npm prune --omit=dev



FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/wiki.db

WORKDIR /app

COPY --from=build \
  /app/node_modules \
  ./node_modules

COPY --from=build \
  /app/dist \
  ./dist

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/src/server.js"]