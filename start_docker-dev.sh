#!/bin/bash
if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.dev.example to .env and fill secrets." >&2
  exit 1
fi
# Build local npm_cache image for multi-stage COPY --from=npm_cache

docker build -t npm_cache -f npm_cache/Dockerfile .

docker compose -f docker-compose-dev.yml up -d --build