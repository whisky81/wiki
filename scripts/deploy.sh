#!/usr/bin/env bash

set -euo pipefail

cd /opt/wiki-app

if [ -z "${IMAGE_TAG:-}" ]; then
  echo "Error: IMAGE_TAG environment variable is not set." >&2
  exit 1
fi

echo "Deploying release: ${IMAGE_TAG}..."

# Login if credentials are provided via environment variables (for private GHCR repos)
if [ -n "${REGISTRY_USER:-}" ] && [ -n "${REGISTRY_TOKEN:-}" ]; then
  echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin
fi

# Pull the exact immutable artifact built in CI
docker compose pull wiki

# Restart/Update container with the new image
docker compose up -d wiki

# Wait and verify health
echo "Verifying deployment..."
docker compose ps