# syntax=docker/dockerfile:1

# --- Build stage: compile TypeScript with full (dev) dependencies ---
FROM node:22-slim AS builder
WORKDIR /app

# Install all dependencies (including dev) against the lockfile for a
# reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src -> dist (tsc).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: ship only production deps and compiled output ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — no dev toolchain in the final image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled JavaScript from the build stage.
COPY --from=builder /app/dist ./dist

# Runtime-writable config directory (config.ts persists to ./data). Owned by the
# unprivileged node user we drop to below.
RUN mkdir -p data && chown -R node:node /app
USER node

# Secrets (YNAB_TOKEN, ANTHROPIC_API_KEY, TELEGRAM_*, etc.) are intentionally NOT
# declared as ARG/ENV here — Railway injects them as runtime environment
# variables, so they never enter the build context or image layers.

# Documentation only; the app binds to process.env.PORT (Railway sets it).
EXPOSE 3000

CMD ["node", "dist/index.js"]
