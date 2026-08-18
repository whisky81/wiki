FROM node:22-bookworm-slim

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

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/src/server.js"]