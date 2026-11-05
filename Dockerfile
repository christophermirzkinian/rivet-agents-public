# The Rivet Agents server, for Fly.io or any container host. Data lives on a volume at /data.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production \
    RIVET_DATA_DIR=/data \
    RIVET_PORT=8130
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
COPY bridge/lib ./bridge/lib
COPY redactor ./redactor
COPY tsconfig.json ./
USER node
EXPOSE 8130
CMD ["node", "--import", "tsx", "src/server/main.ts"]
