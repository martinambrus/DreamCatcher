FROM node:20-alpine

WORKDIR /usr/src/link_fix_detector

RUN npm install redis pg kafkajs typescript @types/node

COPY app /usr/src/link_fix_detector
COPY env.sh /env.sh

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]