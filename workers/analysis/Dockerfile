FROM node:20-alpine

WORKDIR /usr/src/analysis

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/analysis
COPY env.sh /env.sh

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]