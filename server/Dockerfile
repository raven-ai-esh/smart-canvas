FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server/boot.js"]
