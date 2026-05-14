# Build context is the repo root (set in docker-compose.yml)

FROM node:20-alpine AS base
WORKDIR /app

FROM base AS dev
COPY package.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
WORKDIR /app/apps/web
RUN cd ../.. && npm install --workspace=apps/web
COPY apps/web/ .
CMD ["npm", "run", "dev"]

FROM base AS build
COPY package.json ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
WORKDIR /app/apps/web
RUN cd ../.. && npm install --workspace=apps/web
COPY apps/web/ .
RUN npm run build

FROM nginx:alpine AS prod
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
