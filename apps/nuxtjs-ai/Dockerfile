# NODE_IMAGE 默认走 DaoCloud；要官方镜像：--build-arg NODE_IMAGE=node:22-alpine（在 monorepo 根目录构建，context 为 .）
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /repo

FROM base AS build
# 与本地一致：在 monorepo 根目录清理后安装依赖
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/nuxtjs-ai/package.json ./apps/nuxtjs-ai/
RUN sed -i \
  -e 's/esbuild: false/esbuild: true/' \
  -e "s/'@parcel\\/watcher': false/'@parcel\\/watcher': true/" \
  pnpm-workspace.yaml \
  && rm -rf node_modules apps/nuxtjs-ai/node_modules \
  && pnpm install --frozen-lockfile --filter nuxtjs-ai...

RUN test -x apps/nuxtjs-ai/node_modules/.bin/nuxt

COPY apps/nuxtjs-ai ./apps/nuxtjs-ai

ENV NUXT_TELEMETRY_DISABLED=1
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
