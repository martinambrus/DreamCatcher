FROM node:20-alpine

RUN apk add --update --no-cache openssl net-tools

WORKDIR /usr/src/rag_chunker

COPY --from=npm_cache /usr/npm_cache/node_modules ./node_modules

COPY app /usr/src/rag_chunker
RUN cp -R /usr/src/rag_chunker/Database/prisma /usr/src/rag_chunker/prisma
RUN npx prisma generate
RUN npx tsc

CMD [ "node", "./app.js" ]
