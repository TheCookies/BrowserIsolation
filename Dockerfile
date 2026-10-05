FROM node:26-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY orchestrator/package.json orchestrator/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY orchestrator orchestrator
COPY web web
RUN npm run build -w web && npm run build -w orchestrator
RUN npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_PATH=/data/rbi.sqlite
ENV STATIC_DIR=/app/web/dist
# iproute2: detect host eth0 when running with --network=host
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/package.json /app/package.json
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/orchestrator/package.json /app/orchestrator/package.json
COPY --from=build /src/orchestrator/dist /app/orchestrator/dist
COPY --from=build /src/orchestrator/neko-policies /app/orchestrator/neko-policies
COPY --from=build /src/web/dist /app/web/dist
COPY deploy/podman/entrypoint.sh /entrypoint.sh
COPY deploy/podman /deploy
RUN chmod +x /entrypoint.sh /deploy/*.sh
WORKDIR /app/orchestrator
EXPOSE 8080 8090
# Bootstraps /config/.env on first start, then runs orchestrator (or worker if RBI_ROLE=worker).
ENTRYPOINT ["/entrypoint.sh"]
