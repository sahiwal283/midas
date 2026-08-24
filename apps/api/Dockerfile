# Build context is the repo root (set in docker-compose.yml)

FROM node:20-alpine AS base
WORKDIR /app
# imagemagick powers receipt preprocessing (HEIC conversion, auto-orient, resize)
# in @midas/ocr-client — see packages/ocr-client/src/preprocessing.ts.
RUN apk add --no-cache python3 make g++ imagemagick

# ── dev stage ──────────────────────────────────────────────────────────────────
FROM base AS dev
# Copy workspace root package.json for npm workspaces
COPY package.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
# Install from workspace root so @midas/shared resolves
WORKDIR /app/apps/api
RUN cd ../.. && npm install --workspace=apps/api
COPY apps/api/ .
CMD ["sh", "-c", "npx tsx src/db/runSqlMigrations.ts && npm run db:seed && npm run dev"]

# ── build stage ───────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
RUN cd ../.. && npm install --workspace=apps/api
COPY apps/api/ .
RUN npm run build

# The compiled API is CommonJS and `require()`s @midas/shared and
# @midas/ocr-client at runtime (error classes, pickReferenceNumber, …). Both
# packages point `main` at raw .ts, which Node cannot load — so compile them to
# CJS here and repoint `main` at the build output. This rewrite lives only in
# the image; the repo keeps `main` on src so dev and vitest resolve TypeScript
# directly.
WORKDIR /app
RUN npx tsc -p packages/shared/tsconfig.build.json \
 && npx tsc -p packages/ocr-client/tsconfig.build.json \
 && npm pkg set main=./dist/types/index.js types=./dist/types/index.d.ts --prefix packages/shared \
 && npm pkg set main=./dist/index.js types=./dist/index.d.ts --prefix packages/ocr-client
WORKDIR /app/apps/api

# ── production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS prod
WORKDIR /app
RUN apk add --no-cache imagemagick
# Copy pre-installed node_modules from build stage (avoids npm install + registry access)
# packages/ must be present so the @midas/shared symlink in node_modules resolves
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
RUN mkdir -p uploads
CMD ["sh", "-c", "node dist/server.js"]
