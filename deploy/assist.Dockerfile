# design-assist HTTP service (see README "Design assist").
#
# Build context = a directory containing package.json, package-lock.json,
# dist/ (from `npm run build`), and prompts/. Deployed on the Plasmic VPS at
# /opt/plasmic-design-assist:
#
#   docker build -f deploy/assist.Dockerfile -t plasmic-design-assist .
#   docker run -d --name plasmic-design-assist --restart unless-stopped \
#     --env-file /opt/plasmic-design-assist/.env -p 8766:8766 plasmic-design-assist
#
# On the VPS, PLASMIC_HOST=http://10.0.2.2:3003 reaches the Studio container
# directly (no Cloudflare), same as the plasmic-page-api precedent.

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY prompts ./prompts
EXPOSE 8766
CMD ["node", "dist/assist/server.js"]
