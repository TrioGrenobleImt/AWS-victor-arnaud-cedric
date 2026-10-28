# Shop API image (ECS on EC2). Build context: backend/
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib ./lib
COPY api ./api

USER node
EXPOSE 8080
CMD ["node", "api/server.js"]
