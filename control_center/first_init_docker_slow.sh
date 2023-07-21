#!/bin/sh
docker compose up -d --build redis
docker compose up -d --build postgres
docker compose up -d --build rss_fetch
docker compose up -d --build analysis
docker compose up -d --build link_writer
docker compose up -d --build link_fix_detector
docker compose up -d --build log_writer