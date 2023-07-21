FROM node:20-alpine

COPY workers/link_writer/app /usr/src/link_writer
WORKDIR /usr/src/link_writer
COPY workers/link_writer/env.sh /env.sh

RUN npm install redis pg typescript @types/node
RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]