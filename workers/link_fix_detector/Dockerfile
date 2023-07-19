FROM node:20-alpine

COPY app /usr/src/link_fix_detector
WORKDIR /usr/src/link_fix_detector
COPY env.sh /env.sh

RUN npm install redis pg typescript @types/node
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]