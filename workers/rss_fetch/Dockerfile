FROM node:20-alpine

WORKDIR /usr/src/rss_fetch

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY env.sh /env.sh
COPY app /usr/src/rss_fetch

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]