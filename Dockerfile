# Use Node.js 20 slim as base
FROM node:20-slim

# Install system dependencies:
# - python3: Required by yt-dlp
# - ffmpeg: Required for media processing/muxing
# - curl: To download yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify installations
RUN python3 --version && yt-dlp --version && ffmpeg -version

# Set working directory
WORKDIR /app

# Copy package configuration
COPY package*.json ./

# Install production dependencies only
RUN npm install --production

# Copy application source
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the application port
EXPOSE 3000

# Use a non-root user for security (optional but recommended)
# Note: yt-dlp might need home dir access in some cases, so we'll stick to root or ensure permissions
# RUN useradd -m appuser
# USER appuser

# Healthcheck to monitor app status
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
