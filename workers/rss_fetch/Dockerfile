FROM node:20-alpine

RUN apk add --update --no-cache openssl net-tools

WORKDIR /usr/src/rss_fetch

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/rss_fetch
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]