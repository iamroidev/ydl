FROM node:20-slim

# Install dependencies (Python, ffmpeg, curl)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp globally
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy package definition files
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

# Install application dependencies
RUN npm install
RUN cd web && npm install

# Copy application source code
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# Expose default port
EXPOSE 3000

# Set production environment
ENV PORT=3000
ENV NODE_ENV=production

# Start the web server
CMD ["npm", "run", "web"]
