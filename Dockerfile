FROM node:20-alpine

ENV NODE_ENV=production
ENV APP_PATH_FOR_SCRIPTS="/home/on-demand-scraping/scripts"
ENV APP_IS_DEBUG_ON="false"
ENV APP_PORT="3646"

RUN apk add --no-cache tini

RUN mkdir -p /usr/app
WORKDIR /usr/app

COPY package*.json ./

RUN npm ci --include=prod

COPY --chown=node:node . .

STOPSIGNAL SIGTERM

ENTRYPOINT ["tini", "--"]

CMD ["node", "app.mjs"]
