FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.21.0

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS production
ENV NODE_ENV=production BIND_HOST=0.0.0.0 SQLITE_PATH=/data/portal.sqlite
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/start.mjs scripts/http.mjs scripts/check-smtp.mjs ./scripts/
COPY --chown=node:node src/deployment.mjs ./src/
COPY --chown=node:node src/server/smtp.mjs ./src/server/
COPY License .
USER node
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
