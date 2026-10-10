# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY tools/package.json tools/
RUN npm ci
COPY shared shared
COPY client client
RUN npm run build -w client

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 LSL_SKIP_INTRO=1
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY tools/package.json tools/
RUN npm ci --omit=dev -w server -w tools && npm cache clean --force
COPY shared shared
COPY server server
COPY tools tools
COPY content content
COPY --from=build /app/client/dist client/dist
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/ >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start", "-w", "server"]
