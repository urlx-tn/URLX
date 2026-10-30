# Build with the workspace package manager; run production services with Bun.
FROM node:24-bookworm-slim AS workspace
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /workspace
COPY . .

FROM workspace AS web-build
ARG PUBLIC_SERVER_URL
ARG PUBLIC_CONVERSION_SERVER_URL
ENV PUBLIC_SERVER_URL=${PUBLIC_SERVER_URL} \
	PUBLIC_CONVERSION_SERVER_URL=${PUBLIC_CONVERSION_SERVER_URL}
RUN pnpm install --frozen-lockfile --filter-prod 'web...' \
	&& pnpm --filter web build \
	&& pnpm --filter web deploy --prod --legacy /out/web \
	&& node scripts/check-runtime-packages.mjs /out/web

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS bun-distroless
ENV HOME=/tmp
ENTRYPOINT []

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:3ee00291cf386ec52a552e6a858d555debd74776eb4bfa53fa3df2cd6677515e AS web-runtime
COPY --from=bun-distroless /usr/local/bin/ /usr/local/bin/
COPY --from=bun-distroless /usr/local/bun-node-fallback-bin/ /usr/local/bun-node-fallback-bin/
ENV HOME=/tmp \
	BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
	BUN_INSTALL_BIN=/usr/local/bin \
	PATH="${PATH}:/usr/local/bun-node-fallback-bin"
ENTRYPOINT []

FROM web-runtime AS web
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
COPY --from=web-build --chown=1000:1000 /out/web/ ./
COPY --from=web-build --chown=1000:1000 /workspace/apps/web/dist/ ./dist/
COPY --from=workspace --chown=1000:1000 /workspace/deploy/entrypoints/check-egress-policy.ts /app/check-egress-policy.ts
COPY --from=workspace --chown=1000:1000 /workspace/deploy/entrypoints/start-web.ts /app/start-web.ts
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bun", "/app/start-web.ts"]
CMD ["bun", "./dist/server/entry.mjs"]

FROM workspace AS urlx-production-install
RUN pnpm install --frozen-lockfile --prod \
	--filter-prod 'server...' \
	--filter-prod '@urlx/conversion-renderer...' \
	--filter-prod '@urlx/db...'

FROM urlx-production-install AS server-deploy
RUN pnpm --filter server deploy --prod --legacy /out/server
RUN node scripts/check-runtime-packages.mjs /out/server

FROM bun-distroless AS server
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
COPY --from=server-deploy --chown=1000:1000 /out/server/ ./
USER 1000:1000
CMD ["bun", "src/main-api.ts"]

FROM urlx-production-install AS renderer-deploy
RUN pnpm --filter @urlx/conversion-renderer deploy --prod --legacy /out/conversion-renderer \
	&& node scripts/check-runtime-packages.mjs /out/conversion-renderer

FROM urlx-production-install AS migrator-deploy
RUN pnpm --filter @urlx/db deploy --prod --legacy /out/migrator
RUN node scripts/check-runtime-packages.mjs /out/migrator

FROM oven/bun:1.4.4-debian AS bun-runtime

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS conversion-renderer
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=renderer-deploy --chown=pwuser:pwuser /out/conversion-renderer/ ./
USER pwuser
EXPOSE 3100
CMD ["bun", "src/main.ts"]

FROM bun-distroless AS migrator
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
COPY --from=migrator-deploy --chown=1000:1000 /out/migrator/ ./
USER 1000:1000
CMD ["bun", "./scripts/migrate.ts"]
