# Multi-stage build for hosts that deploy from Docker (e.g. Fly.io).
# The image runs ONE process: the Colyseus server, which also serves the
# built client (same origin -> no CORS, single port).

FROM node:22-alpine AS build
WORKDIR /app

# Install exactly what the lockfile pins (workspaces: client/server/shared).
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/
RUN npm ci

COPY . .
# tsc --noEmit + vite build -> client/dist
RUN npm run build -w client

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    LOL_TEST=0
COPY --from=build /app ./
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "server"]
