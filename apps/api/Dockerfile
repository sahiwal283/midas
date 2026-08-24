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

# The compiled API is CommonJS and `require()`s the workspace packages at
# runtime (@midas/shared's pickReferenceNumber, @midas/ocr-client's error
# classes, @midas/import's ImportService). Every package points `main` at raw
# .ts, which Node cannot load — the API dies with "SyntaxError: Unexpected
# token 'export'" on first boot.
#
# Compile each package that ships a tsconfig.build.json to CommonJS and repoint
# its `main`/`types` at the output. The loop is deliberate: adding a package
# without this step is how the break returns. The rewrite lives only in the
# image — the repo keeps `main` on src so dev and vitest resolve TS directly.
WORKDIR /app
RUN set -e; for pkg in packages/*/; do \
      [ -f "$pkg/tsconfig.build.json" ] || continue; \
      npx tsc -p "$pkg/tsconfig.build.json"; \
      main=$(node -p "require('./$pkg/package.json').main"); \
      built=$(printf '%s' "$main" | sed -e 's#^\./src/#./dist/#' -e 's#\.ts$#.js#'); \
      types=$(printf '%s' "$built" | sed -e 's#\.js$#.d.ts#'); \
      npm pkg set main="$built" types="$types" --prefix "$pkg"; \
      echo "built $pkg -> $built"; \
    done
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
