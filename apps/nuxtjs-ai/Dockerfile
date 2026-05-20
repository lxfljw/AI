# syntax=docker/dockerfile:1
# Monorepo 根目录为构建上下文：docker build -f apps/nuxtjs-ai/Dockerfile -t nuxtjs-ai .
# 或本目录：docker compose up -d --build

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/nuxtjs-ai/package.json ./apps/nuxtjs-ai/
RUN pnpm install --frozen-lockfile --filter nuxtjs-ai...

COPY apps/nuxtjs-ai ./apps/nuxtjs-ai

ENV NUXT_TELEMETRY_DISABLED=1
RUN pnpm --filter nuxtjs-ai run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NUXT_TELEMETRY_DISABLED=1
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000

COPY --from=build --chown=node:node /repo/apps/nuxtjs-ai/.output ./.output

EXPOSE 3000
USER node
CMD ["node", ".output/server/index.mjs"]
