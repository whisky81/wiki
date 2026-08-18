#!/usr/bin/env bash

set -euo pipefail

cd /opt/wiki-app

git fetch origin main

git reset --hard origin/main

docker compose up -d --build

docker compose ps