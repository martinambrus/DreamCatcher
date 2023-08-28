FROM node:20-alpine as base

WORKDIR /usr/src/control_center

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/control_center
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]

# DEV
FROM base as dev
COPY env.sh.dev /env.sh

# PROD
FROM base as prod
COPY env.sh.prod /env.sh