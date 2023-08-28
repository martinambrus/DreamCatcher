FROM redis:7.0-alpine

COPY sentinel.conf /etc/redis/sentinel.conf

CMD [ "redis-sentinel", "/etc/redis/sentinel.conf" ]