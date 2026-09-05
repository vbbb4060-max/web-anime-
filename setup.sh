#!/bin/bash

# ============================================================
# ANIMEFLIX - One-Click Deployment Script
# ============================================================
# This script sets up everything:
# - Checks dependencies (Docker, Docker Compose, Python, Node)
# - Clones/updates the project
# - Builds and starts all containers
# - Configures SSL (optional)
# ============================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════╗"
echo "║          🎬 ANIMEFLIX DEPLOYMENT             ║"
echo "║     Netflix-style Anime Streaming Platform    ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================================
# STEP 1: Check Dependencies
# ============================================================
echo -e "${YELLOW}[1/6] Checking dependencies...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker first.${NC}"
    echo "Visit: https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}✅ Docker found${NC}"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose not found. Please install Docker Compose.${NC}"
    echo "Visit: https://docs.docker.com/compose/install/"
    exit 1
fi
echo -e "${GREEN}✅ Docker Compose found${NC}"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 not found. Please install Python 3.8+.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Python3 found ($(python3 --version))${NC}"

# Check Node
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node 18+.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Node.js found ($(node --version))${NC}"

# ============================================================
# STEP 2: Create Directory Structure
# ============================================================
echo -e "${YELLOW}[2/6] Creating directory structure...${NC}"

mkdir -p backend/subtitle_cache
mkdir -p backend/cache
mkdir -p frontend/src
mkdir -p ssl
mkdir -p logs

echo -e "${GREEN}✅ Directory structure created${NC}"

# ============================================================
# STEP 3: Create .env Files
# ============================================================
echo -e "${YELLOW}[3/6] Creating configuration files...${NC}"

# Backend .env
cat > backend/.env << EOF
NODE_ENV=production
PORT=3000
FRONTEND_URL=http://localhost
TRANSLATE_URL=https://libretranslate.com/translate
CACHE_TTL=3600
MONGO_URL=mongodb://mongodb:27017/animeflix
REDIS_URL=redis://redis:6379
MAX_SOURCES_PER_EPISODE=5
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
EOF

# Frontend .env
cat > frontend/.env << EOF
REACT_APP_API_URL=http://localhost:3000/api
EOF

echo -e "${GREEN}✅ Configuration files created${NC}"

# ============================================================
# STEP 4: Install Python Dependencies
# ============================================================
echo -e "${YELLOW}[4/6] Installing Python dependencies...${NC}"

pip3 install --user --quiet \
    playwright \
    aiohttp \
    aiofiles \
    fake-useragent \
    beautifulsoup4 \
    lxml \
    requests \
    selenium \
    2>&1 | grep -v "already satisfied" || true

# Install Playwright browsers
python3 -m playwright install chromium --with-deps 2>&1 | grep -v "already" || true

echo -e "${GREEN}✅ Python dependencies installed${NC}"

# ============================================================
# STEP 5: Build and Start Containers
# ============================================================
echo -e "${YELLOW}[5/6] Building and starting Docker containers...${NC}"

# Stop any existing containers
docker-compose down 2>/dev/null || true

# Build and start
if docker compose version &> /dev/null; then
    docker compose up -d --build
else
    docker-compose up -d --build
fi

# Wait for services to be ready
echo -e "${YELLOW}⏳ Waiting for services to start...${NC}"
sleep 10

# Check if containers are running
if docker ps | grep -q "animeflix"; then
    echo -e "${GREEN}✅ All containers are running${NC}"
else
    echo -e "${RED}❌ Some containers failed to start. Check logs with: docker-compose logs${NC}"
    exit 1
fi

# ============================================================
# STEP 6: SSL Setup (Optional)
# ============================================================
echo -e "${YELLOW}[6/6] SSL Setup (optional)...${NC}"

read -p "Do you want to set up SSL with Let's Encrypt? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter your domain name (e.g., animeflix.com): " DOMAIN
    
    if [ -n "$DOMAIN" ]; then
        # Install certbot if not present
        if ! command -v certbot &> /dev/null; then
            echo "Installing certbot..."
            apt-get update && apt-get install -y certbot python3-certbot-nginx || \
            brew install certbot 2>/dev/null || \
            echo -e "${YELLOW}⚠️  Please install certbot manually: https://certbot.eff.org/${NC}"
        fi
        
        if command -v certbot &> /dev/null; then
            certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" || \
            echo -e "${YELLOW}⚠️  SSL setup failed. You can run it manually later.${NC}"
            
            # Copy certificates
            if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
                cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ssl/cert.pem
                cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem" ssl/key.pem
                echo -e "${GREEN}✅ SSL certificates installed${NC}"
            fi
        fi
    fi
else
    echo -e "${YELLOW}⚠️  Skipping SSL setup. Use HTTP only.${NC}"
fi

# ============================================================
# Final Output
# ============================================================
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════╗"
echo "║          🎉 DEPLOYMENT COMPLETE!             ║"
echo "╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}📌 Access your AnimeFlix instance:${NC}"
echo -e "   🌐 http://localhost"
echo -e "   📊 API: http://localhost:3000/api/health"
echo -e "   📝 Logs: docker-compose logs -f"

echo -e "\n${BLUE}📌 Useful commands:${NC}"
echo -e "   🚀 Start:  docker-compose up -d"
echo -e "   🛑 Stop:   docker-compose down"
echo -e "   📋 Logs:   docker-compose logs -f"
echo -e "   🔄 Restart: docker-compose restart"
echo -e "   🧹 Clean:  docker-compose down -v"

echo -e "\n${BLUE}📌 Files:${NC}"
echo -e "   📁 Backend: ./backend/"
echo -e "   📁 Frontend: ./frontend/"
echo -e "   📁 Subtitles: ./backend/subtitle_cache/"
echo -e "   📁 Logs: ./logs/"

echo -e "\n${GREEN}Happy streaming! 🎬${NC}"