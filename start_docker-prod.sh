#!/bin/bash
if [ ! -f .env.prod ]; then
  echo "Missing .env.prod. Copy .env.prod.example to .env.prod and fill secrets." >&2
  exit 1
fi
docker compose -f docker-compose-prod.yml --env-file .env.prod up -d --build