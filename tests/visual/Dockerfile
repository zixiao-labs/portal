FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps --only-shell chromium \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Build and run as the caller so Lightning can write generated files and
# save screenshots and snapshots to bind mounts.
ARG TEST_UID=1000
ARG TEST_GID=1000
RUN chown "${TEST_UID}:${TEST_GID}" /app
COPY --chown=${TEST_UID}:${TEST_GID} . .
ENV HOME=/tmp
USER ${TEST_UID}:${TEST_GID}
RUN pnpm build
