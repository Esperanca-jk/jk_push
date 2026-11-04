FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY docs ./docs
COPY README.md LICENSE ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/jk_push.sqlite
EXPOSE 8787
CMD ["node", "src/server.js"]
