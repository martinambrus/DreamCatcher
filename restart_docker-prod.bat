docker compose -f docker-compose-prod.yml --env-file .env.prod  down
docker compose -f docker-compose-prod.yml --env-file .env.prod up -d --build