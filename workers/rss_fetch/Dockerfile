FROM node:20-alpine

WORKDIR /usr/src/rss_fetch

RUN apk add git
RUN npm install redis@4.6.7 kafkajs@2.2.4 typescript cacheable-lookup@7.0.0 luxon@3.3.0 striptags@3.2.0 html-entities@2.4.0 node-fetch@3.3.2 https://github.com/martinambrus/rss-parser @types/node@20.4.5

COPY env.sh /env.sh
COPY app /usr/src/rss_fetch

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]