FROM node:20-slim

# Install dependencies (Python, ffmpeg, curl, pip, git for cloning bgutil)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with EJS support and the POT plugin
RUN pip3 install --break-system-packages "yt-dlp[default]" bgutil-ytdlp-pot-provider

# Clone and build the bgutil POT provider server
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-pot \
    && cd /opt/bgutil-pot/server \
    && npm ci \
    && npx tsc

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

# Create startup script that runs both bgutil POT server and the app
RUN echo '#!/bin/bash\n\
echo "Starting bgutil POT provider server on port 4416..."\n\
cd /opt/bgutil-pot/server && node build/main.js &\n\
POT_PID=$!\n\
sleep 2\n\
echo "POT server started (PID: $POT_PID)"\n\
echo "Starting RoiTube web server..."\n\
cd /app && exec node web/server.js\n' > /app/start.sh && chmod +x /app/start.sh

# Expose default port
EXPOSE 3000

# Set production environment
ENV PORT=3000
ENV NODE_ENV=production

# Start both services
CMD ["/bin/bash", "/app/start.sh"]
