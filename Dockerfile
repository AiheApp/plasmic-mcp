# plasmic-page-api — HTTP seeding service (see src/http-server.ts)
#
# NOTE: this image is REST-only. The canvas tools (plasmic_insert_html /
# plasmic_insert_template / plasmic_canvas_doctor) need a Chromium install
# (npx playwright install chromium) and are not bundled here — playwright is
# lazy-loaded, so the rest of the server works without it and canvas calls
# fail with a structured BROWSER_UNAVAILABLE error. Run canvas ops from a
# host with a browser (see docs/canvas-runbook.md).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8765
USER node
CMD ["node", "dist/http-server.js"]
