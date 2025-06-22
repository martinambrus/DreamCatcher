FROM node:20-alpine AS npm_cache

WORKDIR /usr/npm_cache

COPY package.json ./

RUN apk add git
RUN npm install --no-audit --progress=false