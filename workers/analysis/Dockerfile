FROM node:20-alpine

COPY workers/analysis/app /usr/src/analysis
WORKDIR /usr/src/analysis
COPY workers/analysis/env.sh /env.sh

RUN npm install redis pg typescript @types/node
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]