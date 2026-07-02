# Use official Node.js LTS runtime
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Create directories for logs and data; ensure they are owned by node
RUN mkdir -p /app/logs /app/data && chown -R node:node /app/logs /app/data

# Drop root privileges
USER node

# Expose port
EXPOSE 3001

# Health check: hit the /health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["node", "server.js"]
