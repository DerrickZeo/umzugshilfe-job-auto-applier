# Simplified Dockerfile for Maximum Speed
FROM node:18-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libxss1 \
    libasound2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN useradd -r -m appuser

# Set working directory
WORKDIR /app
RUN chown appuser:appuser /app

# Switch to app user
USER appuser

# Copy package files
COPY --chown=appuser:appuser package*.json ./

# Install dependencies
RUN npm ci --production && npm cache clean --force

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy application code
COPY --chown=appuser:appuser app.js ./
COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser .env* ./

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "app.js"]