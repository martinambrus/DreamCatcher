FROM node:20-alpine

WORKDIR /usr/src/analysis

RUN npm install redis pg kafkajs typescript @types/node

COPY app /usr/src/analysis
COPY env.sh /env.sh

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]