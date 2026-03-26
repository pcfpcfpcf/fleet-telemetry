FROM node:18-alpine

WORKDIR /app

# curl is used by docker-compose healthcheck.
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy adapter script
COPY adapter.js .

# Health check: adapter logs to stdout, so we check process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

# Run adapter
CMD ["npm", "start"]
