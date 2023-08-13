FROM node:20-alpine

WORKDIR /usr/src/rss_fetch

RUN apk add git
RUN npm install redis kafkajs typescript cacheable-lookup luxon striptags html-entities https://github.com/martinambrus/rss-parser @types/node

COPY env.sh /env.sh
COPY app /usr/src/rss_fetch

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]