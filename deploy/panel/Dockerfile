# Builds the panel (API + web app) from the repo root.
FROM node:24-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --filter "!@gamepanel/agent" build

FROM node:24-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production WEB_DIST=/app/apps/panel-web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/panel-api/dist/main.js"]
