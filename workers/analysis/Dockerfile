FROM node:20-alpine

WORKDIR /usr/src/analysis

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/analysis
RUN cp -R /usr/src/analysis/Database/prisma /usr/src/analysis/prisma
RUN npx prisma generate
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]