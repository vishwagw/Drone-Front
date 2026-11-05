# Drone Front game server: serves the game page, accounts and checkout, and the online worlds.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY index.html ./
COPY server/*.js ./server/
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
# Runs as root so it can write to the mounted /data volume (Fly volumes mount root-owned).
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
