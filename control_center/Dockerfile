FROM node:20-alpine

RUN apk add --update --no-cache openssl net-tools

WORKDIR /usr/src/control_center

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/control_center
RUN cp -R /usr/src/control_center/Database/prisma /usr/src/control_center/prisma
RUN npx prisma generate
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "node", "./app.js" ]