FROM node:20-alpine

WORKDIR /usr/src/link_writer

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/link_writer
RUN cp -R /usr/src/link_writer/Utils/Database/prisma /usr/src/link_writer/prisma
RUN npx prisma generate
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]