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
	&& pnpm --filter web deploy --prod --legacy /out/web

FROM oven/bun:1.4.4-debian AS web
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
COPY --from=web-build --chown=bun:bun /out/web/ ./
COPY --from=web-build --chown=bun:bun /workspace/apps/web/dist/ ./dist/
COPY --from=workspace --chown=bun:bun /workspace/deploy/entrypoints/check-egress-policy.ts /app/check-egress-policy.ts
COPY --from=workspace --chown=bun:bun /workspace/deploy/entrypoints/start-web.sh /usr/local/bin/start-urlx-web
RUN chmod 0555 /usr/local/bin/start-urlx-web
USER bun
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-urlx-web"]
CMD ["bun", "./dist/server/entry.mjs"]

FROM workspace AS urlx-production-install
RUN pnpm install --frozen-lockfile --prod \
	--filter-prod 'server...' \
	--filter-prod '@urlx/conversion-renderer...' \
	--filter-prod '@urlx/db...'

FROM urlx-production-install AS server-deploy
RUN pnpm --filter server deploy --prod --legacy /out/server

FROM oven/bun:1.4.4-debian AS server
WORKDIR /app
ENV NODE_ENV=production
COPY --from=server-deploy --chown=bun:bun /out/server/ ./
USER bun
CMD ["bun", "src/main-api.ts"]

FROM urlx-production-install AS renderer-deploy
RUN pnpm --filter @urlx/conversion-renderer deploy --prod --legacy /out/conversion-renderer

FROM urlx-production-install AS migrator-deploy
RUN pnpm --filter @urlx/db deploy --prod --legacy /out/migrator

FROM oven/bun:1.4.4-debian AS bun-runtime

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS conversion-renderer
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=renderer-deploy --chown=pwuser:pwuser /out/conversion-renderer/ ./
USER pwuser
EXPOSE 3100
CMD ["bun", "src/main.ts"]

FROM oven/bun:1.4.4-debian AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=migrator-deploy --chown=bun:bun /out/migrator/ ./
USER bun
CMD ["bun", "run", "db:migrate"]
