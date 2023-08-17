FROM node:20-alpine as npm_cache

WORKDIR /usr/npm_cache

COPY package.json ./

RUN apk add git
RUN npm install --no-audit --progress=false