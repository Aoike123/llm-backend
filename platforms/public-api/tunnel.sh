#!/usr/bin/env bash
set -euo pipefail
: "${PUBLIC_API_SSH_TARGET:?Set PUBLIC_API_SSH_TARGET to an SSH config alias or user@host}"
: "${PUBLIC_API_SSH_IDENTITY:?Set PUBLIC_API_SSH_IDENTITY to an absolute private key path}"
: "${PUBLIC_API_SSH_KNOWN_HOSTS:?Set PUBLIC_API_SSH_KNOWN_HOSTS to a verified known_hosts file}"
exec /usr/bin/ssh -NT \
  -p "${PUBLIC_API_SSH_PORT:-22}" -i "$PUBLIC_API_SSH_IDENTITY" \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$PUBLIC_API_SSH_KNOWN_HOSTS" \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ConnectTimeout=15 \
  -R "127.0.0.1:${PUBLIC_API_REMOTE_PORT:-28984}:127.0.0.1:${INFERENCE_PORT:-18982}" \
  "$PUBLIC_API_SSH_TARGET"
