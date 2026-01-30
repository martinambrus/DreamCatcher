FROM node:20-alpine

RUN apk add --update --no-cache openssl net-tools

WORKDIR /usr/src/err_log_writer

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/err_log_writer
RUN cp -R /usr/src/err_log_writer/Database/prisma /usr/src/err_log_writer/prisma
RUN npx prisma generate
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]