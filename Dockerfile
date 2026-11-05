FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY sdk ./sdk
COPY docs ./docs
COPY README.md LICENSE ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/jk_push.sqlite
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
