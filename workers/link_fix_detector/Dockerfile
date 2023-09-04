FROM node:20-alpine

WORKDIR /usr/src/link_fix_detector

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/link_fix_detector
RUN cp -R /usr/src/link_fix_detector/Database/prisma /usr/src/link_fix_detector/prisma
RUN npx prisma generate
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]