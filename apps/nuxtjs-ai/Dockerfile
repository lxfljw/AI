# NODE_IMAGE 默认走 DaoCloud；要官方镜像：--build-arg NODE_IMAGE=node:22-alpine（在 monorepo 根目录构建，context 为 .）
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PNPM_STORE_DIR="/pnpm/store"
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/nuxtjs-ai/package.json ./apps/nuxtjs-ai/

# 国内构建：镜像源 + 拉长超时，避免 pnpm 下载/脚本阶段 TimeoutError
RUN printf '%s\n' \
  'registry=https://registry.npmmirror.com' \
  'fetch-timeout=600000' \
  'fetch-retries=5' \
  'network-concurrency=8' \
  > .npmrc

RUN sed -i \
  -e 's/esbuild: false/esbuild: true/' \
  -e "s/'@parcel\\/watcher': false/'@parcel\\/watcher': true/" \
  pnpm-workspace.yaml

# 跳过 postinstall（npx nuxt prepare 易超时），装完再单独 prepare
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
  rm -rf node_modules apps/nuxtjs-ai/node_modules \
  && pnpm install --frozen-lockfile --filter nuxtjs-ai... --ignore-scripts \
  && pnpm rebuild esbuild @parcel/watcher --filter nuxtjs-ai

RUN test -x apps/nuxtjs-ai/node_modules/.bin/nuxt

COPY apps/nuxtjs-ai ./apps/nuxtjs-ai

ENV NUXT_TELEMETRY_DISABLED=1
RUN pnpm --filter nuxtjs-ai exec nuxt prepare
RUN pnpm --filter nuxtjs-ai exec nuxt build

FROM ${NODE_IMAGE} AS runner
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
