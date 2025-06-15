# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create directories for SSL certificates and public files
RUN mkdir -p /app/ssl /app/public /app/views

# Expose port
EXPOSE 3001

# Create startup script that checks for SSL certificates
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'if [ -f "/app/ssl/cert.pem" ] && [ -f "/app/ssl/key.pem" ]; then' >> /app/start.sh && \
    echo '  echo "SSL certificates found - starting HTTPS server"' >> /app/start.sh && \
    echo '  cp /app/ssl/cert.pem /app/cert.pem' >> /app/start.sh && \
    echo '  cp /app/ssl/key.pem /app/key.pem' >> /app/start.sh && \
    echo '  node server.js' >> /app/start.sh && \
    echo 'else' >> /app/start.sh && \
    echo '  echo "No SSL certificates found - starting HTTP server"' >> /app/start.sh && \
    echo '  node server-http.js' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    chmod +x /app/start.sh

# Start the application
CMD ["/app/start.sh"]
