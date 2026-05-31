FROM node:20-slim

# Install dependencies (Python, ffmpeg, curl, pip)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with EJS support for YouTube challenge solving
# The [default] extra bundles the JavaScript solver scripts needed for YouTube's n-parameter challenge
RUN pip3 install --break-system-packages "yt-dlp[default]"

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
