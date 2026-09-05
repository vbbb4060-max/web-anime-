FROM node:20-alpine

WORKDIR /app

# Install Python and Playwright dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    g++ \
    make \
    git \
    curl \
    && ln -sf python3 /usr/bin/python

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Install Python dependencies for scraper
RUN pip3 install --no-cache-dir \
    playwright \
    aiohttp \
    aiofiles \
    fake-useragent \
    beautifulsoup4 \
    lxml \
    && playwright install chromium --with-deps

# Create directories
RUN mkdir -p subtitle_cache cache

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]