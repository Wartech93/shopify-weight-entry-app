FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npm run build

FROM node:22-bookworm-slim AS runner

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/build ./build
COPY --from=builder /app/app ./app
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/shopify.app.toml ./shopify.app.toml
COPY --from=builder /app/shopify.app.quick-weights.toml ./shopify.app.quick-weights.toml
COPY --from=builder /app/shopify.web.toml ./shopify.web.toml
COPY --from=builder /app/env.d.ts ./env.d.ts
COPY --from=builder /app/vite.config.ts ./vite.config.ts

CMD ["npm", "run", "docker-start"]
