FROM redis:7.0-alpine as base

# copy initial cofiguration set with error codes
COPY startup /usr/src/redis_startup
WORKDIR /usr/src/redis_startup

CMD [ "/bin/sh", "/usr/src/redis_startup/redis_start.sh" ]

# REPLICATION SLAVE
FROM base as slave

CMD [ "/bin/sh", "/usr/src/redis_startup/redis_start_slave.sh" ]