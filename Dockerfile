# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

FROM ${NODE_IMAGE} AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=chicago-lake-pulse-npm-build,target=/root/.npm,sharing=locked \
    npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM ${NODE_IMAGE} AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=chicago-lake-pulse-npm-production,target=/root/.npm,sharing=locked \
    npm ci --omit=dev && \
    npm cache clean --force


FROM ${NODE_IMAGE} AS runtime

ARG VCS_REF
ARG VERSION=development

LABEL org.opencontainers.image.title="Chicago Lake Pulse" \
      org.opencontainers.image.description="A lightweight, source-backed lake observation bot" \
      org.opencontainers.image.source="https://github.com/misterclean/chicago-lake-pulse" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=128

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node package.json ./

USER node
STOPSIGNAL SIGTERM
HEALTHCHECK NONE

ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["tick"]
