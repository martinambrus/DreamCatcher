FROM redis:7.0-alpine

# copy initial cofiguration set with error codes
COPY infrastructure/redis/startup /usr/src/redis_startup
WORKDIR /usr/src/redis_startup

CMD [ "/bin/sh", "/usr/src/redis_startup/redis_start.sh" ]