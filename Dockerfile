FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs index.html ./
COPY data/ ./data/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
