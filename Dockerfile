# plasmic-mcp over streamable HTTP (for n8n / remote MCP clients).
# Build:  docker build -t plasmic-mcp-http .
# Run:    docker run -p 3010:3010 \
#           -e PLASMIC_HOST=http://10.0.2.2:3003 \
#           -e PLASMIC_EMAIL=... -e PLASMIC_PASSWORD=... \
#           -e MCP_HTTP_TOKEN=... plasmic-mcp-http
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3010
USER node
CMD ["node", "dist/http.js"]
