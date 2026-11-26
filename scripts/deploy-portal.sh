#!/usr/bin/env bash
set -euo pipefail

bundle=${1:?Specify a deployment bundle}
revision=${2:?Specify the Git commit to deploy}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid Git commit.' >&2; exit 1; }
image=zixiao-portal:$revision
name=zixiao-portal
previous=$name-previous
origin=https://zixiaolabs.com

exec 9>"$HOME/.zixiao-portal-deploy.lock"
flock --nonblock 9 || { echo 'A portal deployment is already running.' >&2; exit 1; }
docker image load --input "$bundle/portal.tar.gz"
image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
server_platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
if [[ $image_platform != "$server_platform" ]]; then
  echo "Image platform $image_platform does not match Docker host $server_platform." >&2
  exit 1
fi
if docker container inspect "$previous" >/dev/null 2>&1; then
  echo "An interrupted deployment left $previous; inspect and recover it before retrying." >&2
  exit 1
fi

probe() {
  local status
  status=$(curl -q --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 3 --header "Host: ${origin#https://}" "http://127.0.0.1:3000/$1") &&
    [[ $status == 200 ]]
}
wait_for_portal() {
  local attempt
  for (( attempt=1; attempt<=20; attempt++ )); do
    # The sitemap query also exercises the production SQLite volume.
    if probe login && probe sitemap.xml; then return 0; fi
    if [[ $(docker container inspect --format '{{.State.Running}}' "$name") != true ]]; then
      return 1
    fi
    sleep 2
  done
  return 1
}

restore=false
replace=false
# Called by the EXIT trap.
# shellcheck disable=SC2329
rollback() {
  local status=$?
  trap - EXIT HUP INT TERM
  if $replace; then
    docker container rm --force "$name" >/dev/null 2>&1 || true
  fi
  if $restore; then
    if docker container rename "$previous" "$name" &&
      docker container start "$name" >/dev/null && wait_for_portal; then
      echo 'Restored the previous portal container.' >&2
    else
      echo 'The previous portal container did not recover; inspect Docker on the server.' >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM

if docker container inspect "$name" >/dev/null 2>&1; then
  docker container rename "$name" "$previous"
  restore=true
  docker container stop "$previous" >/dev/null
fi

replace=true
docker run --detach --init --name "$name" --pull never \
  --env-file "$bundle/portal.env" --env "PORTAL_ORIGIN=$origin" \
  --env PORT=3000 --env BIND_HOST=0.0.0.0 --env SQLITE_PATH=/data/portal.sqlite \
  --publish 127.0.0.1:3000:3000 --volume zixiao-portal-data:/data \
  "$image" >/dev/null

if wait_for_portal; then
  docker container update --restart unless-stopped "$name" >/dev/null
  trap - EXIT HUP INT TERM
  if $restore; then
    docker container rm "$previous" >/dev/null
  fi
  echo "Deployed portal commit $revision."
  exit 0
fi
echo 'Portal readiness check failed. Inspect the release and configuration before retrying.' >&2
exit 1
