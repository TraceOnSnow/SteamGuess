FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_LABELER_ENABLED=false
ARG VITE_BACKEND_ENABLED=true
ENV VITE_LABELER_ENABLED=$VITE_LABELER_ENABLED
ENV VITE_BACKEND_ENABLED=$VITE_BACKEND_ENABLED
RUN npm run build

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /app/data/runtime /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 4173
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.js"]
