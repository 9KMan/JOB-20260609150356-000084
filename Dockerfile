# =============================================================
# NRG Clinic Healthcare Integration — multi-stage build
# =============================================================
FROM node:20-alpine AS builder
WORKDIR /app

# Install build deps for bcrypt
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npx tsc -p tsconfig.json

# ----------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop privileges
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts

USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

CMD ["node", "dist/src/server.js"]
