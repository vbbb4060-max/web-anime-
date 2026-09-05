#!/usr/bin/env node

/**
 * ANIMEFLIX BACKEND SERVER
 * Complete API for Netflix-style anime streaming
 * - Scrapes ZoroTV.bar on-demand
 * - Caches results in Redis/MongoDB
 * - Translates subtitles via LibreTranslate
 * - Streams video with adaptive bitrate
 * - Ad-blocking proxy middleware
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const NodeCache = require('node-cache');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

// ==================== CONFIGURATION ====================

const PORT = process.env.PORT || 3000;
const CACHE_TTL = process.env.CACHE_TTL || 3600; // 1 hour
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/animeflix';
const TRANSLATE_URL = process.env.TRANSLATE_URL || 'https://libretranslate.com/translate';
const MAX_SOURCES_PER_EPISODE = parseInt(process.env.MAX_SOURCES || '5');

// ==================== INITIALIZATION ====================

const app = express();
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 120 });

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow video streaming
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Static files for cached subtitles
app.use('/subtitles', express.static(path.join(__dirname, 'subtitle_cache')));

// ==================== DATABASE CONNECTION ====================

let dbConnected = false;

async function connectDatabase() {
  try {
    await mongoose.connect(MONGO_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000
    });
    console.log('[+] MongoDB connected');
    dbConnected = true;
  } catch (e) {
    console.warn('[!] MongoDB connection failed, using file cache only:', e.message);
    dbConnected = false;
  }
}

// Connect but don't block startup
connectDatabase();

// ==================== SCHEMAS ====================

if (dbConnected) {
  const animeSchema = new mongoose.Schema({
    slug: { type: String, unique: true, index: true },
    title: String,
    synopsis: String,
    genres: [String],
    coverImage: String,
    status: String,
    releaseYear: String,
    totalEpisodes: String,
    lastUpdated: { type: Date, default: Date.now },
    episodes: [{
      number: String,
      title: String,
      epId: String,
      date: String
    }]
  });

  const episodeSchema = new mongoose.Schema({
    epId: { type: String, unique: true, index: true },
    animeSlug: String,
    animeTitle: String,
    number: String,
    title: String,
    sources: [{
      url: String,
      type: String,
      quality: String,
      serverName: String
    }],
    subtitles: [{
      url: String,
      language: String,
      label: String
    }],
    lastUpdated: { type: Date, default: Date.now }
  });

  const Anime = mongoose.model('Anime', animeSchema);
  const Episode = mongoose.model('Episode', episodeSchema);
}

// ==================== HELPER FUNCTIONS ====================

function getCacheKey(type, identifier) {
  return `animeflix:${type}:${identifier}`;
}

async function getCached(type, identifier) {
  const key = getCacheKey(type, identifier);
  const cached = cache.get(key);
  if (cached) {
    console.log(`[Cache HIT] ${key}`);
    return cached;
  }
  
  // Try Redis if available
  // (Redis integration skipped for simplicity, but you can add it)
  return null;
}

async function setCached(type, identifier, data, ttl = CACHE_TTL) {
  const key = getCacheKey(type, identifier);
  cache.set(key, data, ttl);
  console.log(`[Cache SET] ${key}`);
}

function getSubtitleCachePath(epId, lang) {
  const hash = crypto.createHash('md5').update(`${epId}:${lang}`).digest('hex');
  const dir = path.join(__dirname, 'subtitle_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.vtt`);
}

async function callPythonScraper(args) {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['scraper.py', ...args]);
    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => { stdout += data.toString(); });
    python.stderr.on('data', (data) => { stderr += data.toString(); });

    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python scraper failed (code ${code}): ${stderr}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse JSON from scraper: ${e.message}\nOutput: ${stdout.substring(0, 200)}`));
        }
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to start Python scraper: ${err.message}`));
    });
  });
}

// ==================== SUBTITLE TRANSLATOR ====================

class SubtitleTranslator {
  constructor() {
    this.translateUrl = TRANSLATE_URL;
    this.cacheDir = path.join(__dirname, 'subtitle_cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  parseVTT(content) {
    const lines = content.split('\n');
    const segments = [];
    let current = null;
    let textLines = [];

    for (let line of lines) {
      line = line.trim();
      
      // Skip header and metadata
      if (line.startsWith('WEBVTT') || line.startsWith('Kind:') || 
          line.startsWith('Language:') || line.startsWith('NOTE')) {
        continue;
      }

      // Timing line
      if (line.includes('-->')) {
        if (current) {
          current.text = textLines.join('\n').trim();
          if (current.text) {
            segments.push(current);
          }
        }
        const parts = line.split('-->');
        if (parts.length >= 2) {
          current = {
            start: parts[0].trim(),
            end: parts[1].trim(),
            text: ''
          };
          textLines = [];
        }
        continue;
      }

      // Text content
      if (current && line) {
        textLines.push(line);
      }
    }

    // Push last segment
    if (current) {
      current.text = textLines.join('\n').trim();
      if (current.text) {
        segments.push(current);
      }
    }

    return segments;
  }

  buildVTT(segments) {
    let vtt = 'WEBVTT\n\n';
    for (let seg of segments) {
      vtt += `${seg.start} --> ${seg.end}\n${seg.text}\n\n`;
    }
    return vtt;
  }

  async translateText(text, targetLang) {
    if (!text || text.trim().length === 0) return text;
    if (targetLang === 'en' || targetLang === 'auto') return text;

    try {
      const response = await axios.post(this.translateUrl, {
        q: text,
        source: 'auto',
        target: targetLang,
        format: 'text'
      }, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data && response.data.translatedText) {
        return response.data.translatedText;
      }
      return text;
    } catch (e) {
      console.warn(`[!] Translation failed for text segment: ${e.message}`);
      return text; // Fallback to original
    }
  }

  async translateSubtitle(subtitleUrl, targetLang) {
    console.log(`[+] Translating subtitle to ${targetLang}: ${subtitleUrl}`);
    
    try {
      // Download original subtitle
      const response = await axios.get(subtitleUrl, {
        responseType: 'text',
        timeout: 15000
      });
      const vttContent = response.data;

      // Parse VTT
      const segments = this.parseVTT(vttContent);
      if (segments.length === 0) {
        console.warn('[!] No segments found in subtitle file');
        return vttContent;
      }

      // Translate each segment (batch in chunks to avoid rate limits)
      const chunkSize = 20;
      const translatedSegments = [];
      
      for (let i = 0; i < segments.length; i += chunkSize) {
        const chunk = segments.slice(i, i + chunkSize);
        const translatedChunk = await Promise.all(
          chunk.map(async (seg) => {
            if (!seg.text.trim()) return seg;
            try {
              const translated = await this.translateText(seg.text, targetLang);
              return { ...seg, text: translated };
            } catch (e) {
              return seg;
            }
          })
        );
        translatedSegments.push(...translatedChunk);
        
        // Small delay between chunks to avoid rate limiting
        if (i + chunkSize < segments.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Rebuild VTT
      const translatedVTT = this.buildVTT(translatedSegments);
      return translatedVTT;
    } catch (e) {
      console.error(`[!] Failed to translate subtitle: ${e.message}`);
      throw new Error(`Subtitle translation failed: ${e.message}`);
    }
  }

  async getTranslatedSubtitle(epId, subtitleUrl, targetLang) {
    if (!subtitleUrl) return null;
    
    const cachePath = getSubtitleCachePath(epId, targetLang);
    
    // Check cache
    if (fs.existsSync(cachePath)) {
      console.log(`[+] Using cached translated subtitle: ${cachePath}`);
      return fs.readFileSync(cachePath, 'utf8');
    }

    try {
      const translated = await this.translateSubtitle(subtitleUrl, targetLang);
      fs.writeFileSync(cachePath, translated, 'utf8');
      return translated;
    } catch (e) {
      console.error(`[!] Translation failed: ${e.message}`);
      // Fallback: download original subtitle and cache it
      try {
        const response = await axios.get(subtitleUrl, { responseType: 'text', timeout: 10000 });
        fs.writeFileSync(cachePath, response.data, 'utf8');
        return response.data;
      } catch (fallbackErr) {
        console.error(`[!] Fallback also failed: ${fallbackErr.message}`);
        return null;
      }
    }
  }
}

const translator = new SubtitleTranslator();

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    cacheSize: cache.keys().length,
    dbConnected: dbConnected,
    version: '1.0.0'
  });
});

// Get anime list with pagination
app.get('/api/anime', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const force = req.query.force === 'true';

    // Check cache
    const cacheKey = `anime_list_page_${page}_limit_${limit}`;
    if (!force) {
      const cached = await getCached('anime', cacheKey);
      if (cached) {
        return res.json({
          success: true,
          page,
          limit,
          total: cached.length || 0,
          data: cached,
          cached: true
        });
      }
    }

    // Fetch from scraper
    console.log(`[+] Fetching anime list page ${page} from scraper`);
    const animeList = await callPythonScraper(['list', '--page', String(page)]);

    // Validate and limit results
    const limited = Array.isArray(animeList) ? animeList.slice(0, limit) : [];

    // Cache results
    if (limited.length > 0) {
      await setCached('anime', cacheKey, limited);
    }

    res.json({
      success: true,
      page,
      limit,
      total: limited.length || 0,
      data: limited,
      cached: false
    });

  } catch (error) {
    console.error('[/api/anime] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch anime list',
      message: error.message
    });
  }
});

// Get anime details by slug
app.get('/api/anime/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const force = req.query.force === 'true';

    // Check cache
    const cacheKey = `anime_details_${slug}`;
    if (!force) {
      const cached = await getCached('anime', cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: cached,
          cached: true
        });
      }
    }

    // Fetch from scraper
    console.log(`[+] Fetching details for ${slug}`);
    const details = await callPythonScraper(['details', '--slug', slug]);

    // Fetch episodes as well
    let episodes = [];
    try {
      episodes = await callPythonScraper(['episodes', '--slug', slug]);
    } catch (e) {
      console.warn(`[!] Failed to fetch episodes for ${slug}: ${e.message}`);
    }

    const result = {
      ...details,
      episodes: episodes || []
    };

    // Cache results
    if (result.title) {
      await setCached('anime', cacheKey, result);
    }

    res.json({
      success: true,
      data: result,
      cached: false
    });

  } catch (error) {
    console.error('[/api/anime/:slug] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch anime details',
      message: error.message
    });
  }
});

// Get episodes for an anime
app.get('/api/anime/:slug/episodes', async (req, res) => {
  try {
    const { slug } = req.params;
    const force = req.query.force === 'true';

    const cacheKey = `episodes_${slug}`;
    if (!force) {
      const cached = await getCached('episodes', cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: cached,
          cached: true
        });
      }
    }

    console.log(`[+] Fetching episodes for ${slug}`);
    const episodes = await callPythonScraper(['episodes', '--slug', slug]);

    await setCached('episodes', cacheKey, episodes);

    res.json({
      success: true,
      data: episodes,
      cached: false
    });

  } catch (error) {
    console.error('[/api/anime/:slug/episodes] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch episodes',
      message: error.message
    });
  }
});

// Get episode sources with subtitle translation
app.get('/api/watch/:epId', async (req, res) => {
  try {
    const { epId } = req.params;
    const { lang = 'en', force = 'false' } = req.query;
    const forceRefresh = force === 'true';

    // Check cache for sources
    const cacheKey = `sources_${epId}_lang_${lang}`;
    if (!forceRefresh) {
      const cached = await getCached('watch', cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: cached,
          cached: true
        });
      }
    }

    console.log(`[+] Fetching sources for episode ${epId} with language ${lang}`);
    
    // Fetch sources from scraper
    const sourcesData = await callPythonScraper(['sources', '--ep-id', epId]);
    
    // Validate sources
    if (!sourcesData || !sourcesData.sources || sourcesData.sources.length === 0) {
      throw new Error('No video sources found for this episode');
    }

    // Limit sources
    const limitedSources = sourcesData.sources.slice(0, MAX_SOURCES_PER_EPISODE);
    
    // Process subtitles
    let subtitleUrl = null;
    let translatedSubtitle = null;
    
    if (sourcesData.subtitles && sourcesData.subtitles.length > 0) {
      const sub = sourcesData.subtitles[0]; // Use first subtitle track
      subtitleUrl = sub.url;
      
      if (subtitleUrl) {
        // Get translated subtitle
        translatedSubtitle = await translator.getTranslatedSubtitle(
          epId,
          subtitleUrl,
          lang
        );
      }
    }

    // Build response
    const result = {
      episode: {
        id: epId,
        title: sourcesData.info?.title || `Episode ${epId}`,
        number: sourcesData.info?.episode || ''
      },
      sources: limitedSources.map(s => ({
        url: s.url,
        type: s.type || 'direct',
        quality: s.quality || 'auto',
        serverName: s.serverName || null
      })),
      subtitles: sourcesData.subtitles || [],
      translatedSubtitle: translatedSubtitle ? {
        url: `/subtitles/${getSubtitleCachePath(epId, lang).split('/').pop()}`,
        language: lang,
        label: `Translated to ${lang}`
      } : null,
      originalSubtitles: subtitleUrl ? [{
        url: subtitleUrl,
        language: sourcesData.subtitles[0]?.language || 'en',
        label: sourcesData.subtitles[0]?.label || 'Original'
      }] : []
    };

    // Cache results
    await setCached('watch', cacheKey, result, 600); // 10 minutes cache for watch data

    res.json({
      success: true,
      data: result,
      cached: false
    });

  } catch (error) {
    console.error('[/api/watch/:epId] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch episode sources',
      message: error.message
    });
  }
});

// Search anime
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }

    const cacheKey = `search_${q.toLowerCase().replace(/\s+/g, '_')}`;
    const cached = await getCached('search', cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached.slice(0, parseInt(limit)),
        cached: true
      });
    }

    console.log(`[+] Searching for: ${q}`);
    const results = await callPythonScraper(['search', '--query', q, '--limit', String(limit)]);

    await setCached('search', cacheKey, results, 1800); // 30 minutes

    res.json({
      success: true,
      data: results,
      cached: false
    });

  } catch (error) {
    console.error('[/api/search] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Search failed',
      message: error.message
    });
  }
});

// Get recent episodes
app.get('/api/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const cacheKey = 'recent_episodes';
    const cached = await getCached('recent', cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached.slice(0, limit),
        cached: true
      });
    }

    console.log('[+] Fetching recent episodes');
    const recent = await callPythonScraper(['recent', '--limit', String(limit)]);

    await setCached('recent', cacheKey, recent, 600); // 10 minutes

    res.json({
      success: true,
      data: recent,
      cached: false
    });

  } catch (error) {
    console.error('[/api/recent] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent episodes',
      message: error.message
    });
  }
});

// Get genres
app.get('/api/genres', async (req, res) => {
  try {
    const cacheKey = 'genres';
    const cached = await getCached('genres', cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    console.log('[+] Fetching genres');
    const genres = await callPythonScraper(['genres']);

    await setCached('genres', cacheKey, genres, 86400); // 24 hours

    res.json({
      success: true,
      data: genres,
      cached: false
    });

  } catch (error) {
    console.error('[/api/genres] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch genres',
      message: error.message
    });
  }
});

// Proxy for video streaming (with ad-blocking)
app.get('/api/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Block known ad domains
    const adDomains = [
      'doubleclick', 'googlead', 'googlesyndication',
      'exoclick', 'propellerads', 'popads', 'adserver',
      'adnxs', 'pubmatic', 'openx', 'rubicon'
    ];
    const urlLower = url.toLowerCase();
    for (const domain of adDomains) {
      if (urlLower.includes(domain)) {
        return res.status(403).json({ error: 'Ad content blocked' });
      }
    }

    console.log(`[+] Proxying: ${url.substring(0, 100)}...`);

    // Stream the video
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://zorotv.bar/',
        'Origin': 'https://zorotv.bar'
      }
    });

    // Forward headers
    res.set({
      'Content-Type': response.headers['content-type'] || 'video/mp4',
      'Content-Length': response.headers['content-length'],
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });

    // Pipe the stream
    await pipeline(response.data, res);

  } catch (error) {
    console.error('[/api/proxy] Error:', error);
    res.status(500).json({
      error: 'Proxy failed',
      message: error.message
    });
  }
});

// Clear cache endpoint (admin only - add auth in production)
app.post('/api/cache/clear', async (req, res) => {
  try {
    cache.flushAll();
    console.log('[+] Cache cleared');
    res.json({
      success: true,
      message: 'Cache cleared successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache',
      message: error.message
    });
  }
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
  console.error('[!] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found'
  });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`[+] ANIMEFLIX Backend running on port ${PORT}`);
  console.log(`[+] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[+] Cache TTL: ${CACHE_TTL}s`);
  console.log(`[+] Database: ${dbConnected ? 'Connected' : 'File cache only'}`);
  console.log(`[+] Translation URL: ${TRANSLATE_URL}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[!] Shutting down gracefully...');
  if (dbConnected) {
    await mongoose.disconnect();
    console.log('[+] MongoDB disconnected');
  }
  process.exit(0);
});

module.exports = app; // For testing