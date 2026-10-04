FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY orchestrator/package.json orchestrator/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY orchestrator orchestrator
COPY web web
RUN npm run build -w web && npm run build -w orchestrator
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_PATH=/data/rbi.sqlite
ENV STATIC_DIR=/app/web/dist
COPY --from=build /src/package.json /app/package.json
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/orchestrator/package.json /app/orchestrator/package.json
COPY --from=build /src/orchestrator/dist /app/orchestrator/dist
COPY --from=build /src/orchestrator/neko-policies /app/orchestrator/neko-policies
COPY --from=build /src/web/dist /app/web/dist
# Host installer (extract with: podman run --rm --entrypoint cat IMAGE /deploy/install.sh)
COPY deploy/podman /deploy
WORKDIR /app/orchestrator
EXPOSE 8080 8090
# Default: portal/orchestrator. Worker hosts override with dist/worker-main.js.
CMD ["node", "dist/index.js"]
