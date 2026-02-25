FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/

ENV MCP_MODE=http
ENV HTTP_PORT=8080
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "dist/index.js"]
