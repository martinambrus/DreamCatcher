FROM node:20-alpine

WORKDIR /usr/src/analysis

RUN npm install redis@4.6.7 pg@8.11.1 kafkajs@2.2.4 typescript @types/node@20.4.5

COPY app /usr/src/analysis
COPY env.sh /env.sh

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]