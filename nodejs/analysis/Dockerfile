FROM node:20-alpine

COPY app /usr/src/analysis
WORKDIR /usr/src/analysis
COPY env.sh /env.sh

RUN npm install redis pg

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./analysis.mjs" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./analysis.mjs" ]