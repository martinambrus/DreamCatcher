#!/bin/bash
docker compose -f docker-compose-dev-utils.yml -f docker-compose-dev-services.yml -f docker-compose-dev-infrastructure.yml down