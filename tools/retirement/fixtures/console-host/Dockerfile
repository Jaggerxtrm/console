FROM oven/bun:1 AS builder
WORKDIR /app

COPY . .
RUN bun install
RUN cd apps/console && bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV XTRM_DATA_DIR=/data
ENV XDG_PROJECTS_DIR=/projects

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/bun.lock /app/bun.lock
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=builder /app/apps /app/apps
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/dist /app/dist

RUN bun install --production --frozen-lockfile
RUN mkdir -p /data /projects

EXPOSE 3000
CMD ["bun", "apps/console/src/server/index.ts"]
