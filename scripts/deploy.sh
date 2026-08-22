#!/usr/bin/env bash

set -euo pipefail

cd /opt/wiki-app

if [ -z "${IMAGE_TAG:-}" ]; then
  echo "Error: IMAGE_TAG environment variable is not set." >&2
  exit 1
fi

export IMAGE_TAG
export IMAGE_REPO="${IMAGE_REPO:-whisky81/wiki}"

echo "Deploying release: ${IMAGE_TAG} (repo: ${IMAGE_REPO})..."

# Login if credentials are provided via environment variables (for private GHCR repos)
if [ -n "${REGISTRY_USER:-}" ] && [ -n "${REGISTRY_TOKEN:-}" ]; then
  echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin
fi

# Pull the exact immutable artifact built in CI
docker compose pull

# Restart/Update container with the new image
docker compose up -d

# Wait and verify health
echo "Verifying deployment..."
docker compose ps