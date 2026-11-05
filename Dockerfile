# Drone Front game server: serves the game page and runs the online worlds.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY index.html ./
COPY server/server.js ./server/
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server/server.js"]
