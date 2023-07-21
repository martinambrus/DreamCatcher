FROM node:20-alpine

COPY workers/link_fix_detector/app /usr/src/link_fix_detector
WORKDIR /usr/src/link_fix_detector
COPY workers/link_fix_detector/env.sh /env.sh

RUN npm install redis pg typescript @types/node
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]