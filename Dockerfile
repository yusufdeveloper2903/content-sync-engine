# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24

# ---- deps: full dependency tree for building ---------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---- build: compile TypeScript -----------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: runtime dependencies only ------------------------------------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/content-sync.db
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json openapi.yaml ./
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so SIGTERM reaches Node directly and graceful shutdown runs.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
