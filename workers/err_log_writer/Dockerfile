FROM node:20-alpine

WORKDIR /usr/src/err_log_writer

RUN npm install redis@4.6.7 pg@8.11.1 kafkajs@2.2.4 @opentelemetry/api@1.4.1 @opentelemetry/exporter-jaeger@1.15.0 @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources@1.15.0 @opentelemetry/sdk-trace-base@1.15.0 @opentelemetry/sdk-trace-node@1.15.0 @opentelemetry/semantic-conventions@1.15.0 typescript @types/node@20.4.5

COPY app /usr/src/err_log_writer
COPY env.sh /env.sh

RUN npx tsc

#CMD [ "/bin/sh", "-c", "source /env.sh && printenv && node ./app.js" ]
CMD [ "/bin/sh", "-c", "source /env.sh && node ./app.js" ]