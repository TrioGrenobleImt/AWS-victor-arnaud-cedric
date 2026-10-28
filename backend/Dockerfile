# API image for both ECS services (shop: api/server.js, admin: admin/server.js). Build context: backend/
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib ./lib
COPY api ./api
COPY admin ./admin

USER node
EXPOSE 8080
CMD ["node", "api/server.js"]
