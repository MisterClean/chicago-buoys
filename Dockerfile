# syntax=docker/dockerfile:1.7

ARG BUILD_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
ARG RUNTIME_IMAGE=alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

FROM ${BUILD_IMAGE} AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=chicago-lake-pulse-npm-build,target=/root/.npm,sharing=locked \
    npm ci

COPY tsconfig.json ./
COPY src ./src
COPY LICENSE ./
RUN npm run build && \
    npm run bundle && \
    npm prune --omit=dev

# Preserve the license texts of every bundled production dependency without
# carrying the production dependency tree into the runtime image.
RUN node --input-type=module <<'NOTICE_SCRIPT'
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve("node_modules");
const licenseName = /^(?:licen[cs]e|copying|notice)/iu;
const licenseFiles = [];
const pending = [root];

while (pending.length > 0) {
  const directory = pending.pop();
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      pending.push(path);
    } else if (licenseName.test(entry)) {
      licenseFiles.push(path);
    }
  }
}

licenseFiles.sort();
const notices = licenseFiles.map((path) => {
  const heading = `===== ${relative(root, path)} =====`;
  return `${heading}\n${readFileSync(path, "utf8").trim()}\n`;
});
writeFileSync("THIRD_PARTY_NOTICES.txt", notices.join("\n"));
NOTICE_SCRIPT


FROM ${RUNTIME_IMAGE} AS runtime

ARG VCS_REF
ARG VERSION=development

LABEL org.opencontainers.image.title="Chicago Lake Pulse" \
      org.opencontainers.image.description="A lightweight, source-backed lake observation bot" \
      org.opencontainers.image.source="https://github.com/misterclean/chicago-lake-pulse" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

# Stay on Node 24 while accepting security revisions from Alpine's stable branch.
# hadolint ignore=DL3018
RUN apk add --no-cache 'nodejs~24' icu-data-en && \
    addgroup -g 1000 node && \
    adduser -u 1000 -G node -s /bin/sh -D node

ENV HOME=/tmp \
    NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=128"

WORKDIR /app

COPY --from=build --chown=1000:1000 /build/dist/src/cli.js ./dist/src/cli.js
COPY --from=build --chown=1000:1000 /build/dist/src/cli.js.map ./dist/src/cli.js.map
COPY --from=build --chown=1000:1000 /build/dist/src/cli.js.LEGAL.txt ./dist/src/cli.js.LEGAL.txt
COPY --from=build --chown=1000:1000 /build/package.json ./package.json
COPY --from=build --chown=1000:1000 /build/LICENSE ./LICENSE
COPY --from=build --chown=1000:1000 /build/THIRD_PARTY_NOTICES.txt ./THIRD_PARTY_NOTICES.txt

USER 1000:1000
STOPSIGNAL SIGTERM
HEALTHCHECK NONE

ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["tick"]
