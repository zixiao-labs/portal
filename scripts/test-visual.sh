#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p artifacts

# Use the same rendering environment on CI and on developer machines.
echo 'Preparing the Linux/amd64 visual test image...'
image=$(docker build --quiet --platform linux/amd64 --file tests/visual/Dockerfile \
  --build-arg "TEST_UID=$(id -u)" --build-arg "TEST_GID=$(id -g)" .)
docker run --rm --init --platform linux/amd64 --shm-size=256m \
  --env CI \
  --mount "type=bind,source=$PWD/artifacts,target=/app/artifacts" \
  --mount "type=bind,source=$PWD/tests/visual/__snapshots__,target=/app/tests/visual/__snapshots__" \
  "$image" pnpm exec lightning run --project visual "$@"
