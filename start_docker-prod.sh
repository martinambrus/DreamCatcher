#!/bin/bash
docker compose -f docker-compose-prod.yml --env-file .env.prod up -d --build