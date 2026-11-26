#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

revision=${1:?Specify the Git commit to deploy}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid Git commit.' >&2; exit 1; }
host=${DEPLOY_HOST:-zixiaolabs.com}
port=${DEPLOY_PORT:-22}
user=${DEPLOY_USER:-portal-deploy}
if [[ ! $host =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ || ! $port =~ ^[1-9][0-9]{0,4}$ ||
      $port -gt 65535 || ! $user =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo 'Invalid deployment SSH host, port or user.' >&2
  exit 1
fi

umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/bundle"
required=(PORTAL_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_ORG_ID
  SMTP_HOST SMTP_USER SMTP_PASSWORD)
for key in "${required[@]}"; do
  if [[ -z ${!key:-} ]]; then
    printf 'Missing %s.\n' "$key" >&2
    exit 1
  fi
done
for key in "${required[@]}" SMTP_PORT SMTP_TLS_MODE SMTP_FROM SMTP_FROM_NAME; do
  value=${!key:-}
  if [[ $value == *$'\n'* || $value == *$'\r'* ]]; then
    printf '%s must be a single-line value.\n' "$key" >&2
    exit 1
  fi
  printf '%s=%s\n' "$key" "$value" >> "$work/bundle/portal.env"
done
printf '%s\n' "${DEPLOY_SSH_KEY:?Missing DEPLOY_SSH_KEY}" > "$work/identity"
printf '%s\n' "${DEPLOY_SSH_KNOWN_HOSTS:?Missing DEPLOY_SSH_KNOWN_HOSTS}" > "$work/known_hosts"
cp scripts/deploy-portal.sh "$work/bundle/deploy.sh"
docker image save "zixiao-portal:$revision" | gzip -1 > "$work/bundle/portal.tar.gz"

# Only the validated commit goes in the remote command; the env file is data, never sourced.
remote_command=$(cat <<'EOF'
set -eu
umask 077
# Docker installed via Snap cannot read the host's /tmp from its private mount namespace.
bundle=$(mktemp -d "$HOME/zixiao-portal-deploy.XXXXXXXX")
trap 'rm -rf -- "$bundle"' EXIT
trap 'exit 1' HUP INT TERM
tar -xf - -C "$bundle"
bash "$bundle/deploy.sh" "$bundle" "$revision"
EOF
)
tar -cf - -C "$work/bundle" deploy.sh portal.env portal.tar.gz |
  ssh -F /dev/null -T -p "$port" -i "$work/identity" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$work/known_hosts" -o GlobalKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    "$user@$host" "revision=$revision; $remote_command"
