FROM node:20-alpine

COPY app /usr/src/link_writer
WORKDIR /usr/src/link_writer
COPY env.sh /env.sh

RUN npm install redis pg

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./link_writer.mjs" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./link_writer.mjs" ]