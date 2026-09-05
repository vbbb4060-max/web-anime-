#!/usr/bin/env node

/**
 * STANDALONE SUBTITLE TRANSLATOR
 * Can be used independently or imported
 * Supports VTT, SRT, and ASS formats
 * Caches translations locally
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SubtitleTranslator {
  constructor(options = {}) {
    this.translateUrl = options.translateUrl || process.env.TRANSLATE_URL || 'https://libretranslate.com/translate';
    this.cacheDir = options.cacheDir || path.join(__dirname, 'subtitle_cache');
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.chunkSize = options.chunkSize || 50;
    this.delayBetweenChunks = options.delayBetweenChunks || 500;
    
    // Supported formats
    this.supportedFormats = ['vtt', 'srt', 'ass'];
    
    // Create cache directory
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Parse subtitle content based on format
   */
  parseSubtitles(content, format = 'vtt') {
    switch (format.toLowerCase()) {
      case 'vtt':
        return this.parseVTT(content);
      case 'srt':
        return this.parseSRT(content);
      case 'ass':
        return this.parseASS(content);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Parse VTT format
   */
  parseVTT(content) {
    const lines = content.split('\n');
    const segments = [];
    let current = null;
    let textLines = [];
    let inMetadata = true;

    for (let line of lines) {
      line = line.trim();

      // Skip empty lines at start
      if (inMetadata && !line) continue;
      if (inMetadata && line.startsWith('WEBVTT')) continue;
      if (inMetadata && line.includes('-->')) {
        inMetadata = false;
      }
      
      if (inMetadata) continue;

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

      // Text content (skip cue identifiers and notes)
      if (current && line && !line.match(/^\d+$/) && !line.startsWith('NOTE')) {
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

  /**
   * Parse SRT format
   */
  parseSRT(content) {
    const lines = content.split('\n');
    const segments = [];
    let current = null;
    let textLines = [];
    let expectingTime = false;

    for (let line of lines) {
      line = line.trim();

      // Skip empty lines
      if (!line) {
        if (current) {
          current.text = textLines.join('\n').trim();
          if (current.text) {
            segments.push(current);
          }
          current = null;
          textLines = [];
          expectingTime = false;
        }
        continue;
      }

      // Check if this is a timing line
      if (line.includes('-->')) {
        const parts = line.split('-->');
        if (parts.length >= 2) {
          current = {
            start: parts[0].trim(),
            end: parts[1].trim(),
            text: ''
          };
          textLines = [];
          expectingTime = false;
        }
        continue;
      }

      // Skip cue numbers
      if (/^\d+$/.test(line) && !current) {
        expectingTime = true;
        continue;
      }

      // Text content
      if (current) {
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

  /**
   * Parse ASS format (basic support)
   */
  parseASS(content) {
    const lines = content.split('\n');
    const segments = [];
    let inEvents = false;

    for (let line of lines) {
      line = line.trim();

      if (line.startsWith('[Events]')) {
        inEvents = true;
        continue;
      }

      if (inEvents && line.startsWith('Dialogue:')) {
        const parts = line.split(',');
        if (parts.length >= 5) {
          const start = parts[1].trim();
          const end = parts[2].trim();
          const text = parts.slice(4).join(',').replace(/\{[^}]*\}/g, '').trim();
          
          if (text) {
            segments.push({
              start: start,
              end: end,
              text: text
            });
          }
        }
      }
    }

    return segments;
  }

  /**
   * Build subtitle content from segments
   */
  buildSubtitles(segments, format = 'vtt') {
    switch (format.toLowerCase()) {
      case 'vtt':
        return this.buildVTT(segments);
      case 'srt':
        return this.buildSRT(segments);
      case 'ass':
        return this.buildASS(segments);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Build VTT format
   */
  buildVTT(segments) {
    let vtt = 'WEBVTT\n\n';
    for (let seg of segments) {
      vtt += `${seg.start} --> ${seg.end}\n${seg.text}\n\n`;
    }
    return vtt;
  }

  /**
   * Build SRT format
   */
  buildSRT(segments) {
    let srt = '';
    let index = 1;
    for (let seg of segments) {
      srt += `${index}\n${seg.start} --> ${seg.end}\n${seg.text}\n\n`;
      index++;
    }
    return srt;
  }

  /**
   * Build ASS format
   */
  buildASS(segments) {
    let ass = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    for (let seg of segments) {
      ass += `Dialogue: 0,${seg.start},${seg.end},Default,,0,0,0,,${seg.text}\n`;
    }
    return ass;
  }

  /**
   * Detect subtitle format from content or URL
   */
  detectFormat(content, url = '') {
    const urlLower = url.toLowerCase();
    if (urlLower.endsWith('.vtt') || urlLower.includes('.vtt')) return 'vtt';
    if (urlLower.endsWith('.srt') || urlLower.includes('.srt')) return 'srt';
    if (urlLower.endsWith('.ass') || urlLower.includes('.ass')) return 'ass';
    
    // Detect from content
    if (content.trim().startsWith('WEBVTT')) return 'vtt';
    if (content.includes('-->') && content.match(/\d+\n\d{2}:\d{2}:\d{2}/)) return 'srt';
    if (content.includes('[Script Info]') && content.includes('Dialogue:')) return 'ass';
    
    return 'vtt'; // Default
  }

  /**
   * Translate text using LibreTranslate
   */
  async translateText(text, targetLang, sourceLang = 'auto') {
    if (!text || text.trim().length === 0) return text;
    if (targetLang === sourceLang || targetLang === 'en') return text;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.post(this.translateUrl, {
          q: text,
          source: sourceLang,
          target: targetLang,
          format: 'text'
        }, {
          timeout: this.timeout,
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.translatedText) {
          return response.data.translatedText;
        }
        return text;
      } catch (e) {
        console.warn(`[!] Translation attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt === this.maxRetries - 1) return text;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    return text;
  }

  /**
   * Translate entire subtitle file
   */
  async translateSubtitle(content, targetLang, sourceLang = 'auto', format = null) {
    if (!format) {
      format = this.detectFormat(content);
    }

    console.log(`[+] Translating subtitle (${format}) to ${targetLang}`);
    
    // Parse subtitles
    const segments = this.parseSubtitles(content, format);
    if (segments.length === 0) {
      throw new Error('No subtitle segments found');
    }

    // Split into chunks and translate
    const translatedSegments = [];
    const totalSegments = segments.length;
    
    for (let i = 0; i < segments.length; i += this.chunkSize) {
      const chunk = segments.slice(i, i + this.chunkSize);
      const translatedChunk = await Promise.all(
        chunk.map(async (seg) => {
          if (!seg.text.trim()) return seg;
          try {
            const translated = await this.translateText(seg.text, targetLang, sourceLang);
            return { ...seg, text: translated };
          } catch (e) {
            console.warn(`[!] Failed to translate segment: ${e.message}`);
            return seg;
          }
        })
      );
      translatedSegments.push(...translatedChunk);
      
      // Progress
      const progress = Math.min(100, Math.round((i + chunk.length) / totalSegments * 100));
      console.log(`[+] Translation progress: ${progress}%`);
      
      // Delay between chunks
      if (i + this.chunkSize < segments.length) {
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenChunks));
      }
    }

    // Rebuild subtitle
    return this.buildSubtitles(translatedSegments, format);
  }

  /**
   * Get cache path for a subtitle
   */
  getCachePath(epId, targetLang, format = 'vtt') {
    const hash = crypto.createHash('md5').update(`${epId}:${targetLang}`).digest('hex');
    return path.join(this.cacheDir, `${hash}.${format}`);
  }

  /**
   * Translate subtitle from URL with caching
   */
  async translateFromUrl(subtitleUrl, targetLang, epId = null) {
    if (!epId) {
      epId = crypto.createHash('md5').update(subtitleUrl).digest('hex');
    }

    // Detect format from URL
    const format = this.detectFormat('', subtitleUrl);
    const cachePath = this.getCachePath(epId, targetLang, format);

    // Check cache
    if (fs.existsSync(cachePath)) {
      console.log(`[+] Using cached translation: ${cachePath}`);
      return fs.readFileSync(cachePath, 'utf8');
    }

    // Download subtitle
    console.log(`[+] Downloading subtitle: ${subtitleUrl}`);
    const response = await axios.get(subtitleUrl, {
      responseType: 'text',
      timeout: this.timeout
    });
    const content = response.data;

    // Translate
    const translated = await this.translateSubtitle(content, targetLang, 'auto', format);

    // Cache
    fs.writeFileSync(cachePath, translated, 'utf8');
    console.log(`[+] Cached translation: ${cachePath}`);

    return translated;
  }

  /**
   * Batch translate multiple subtitles
   */
  async batchTranslate(subtitleUrls, targetLang) {
    const results = {};
    for (const [key, url] of Object.entries(subtitleUrls)) {
      try {
        results[key] = await this.translateFromUrl(url, targetLang, key);
      } catch (e) {
        console.error(`[!] Failed to translate ${key}: ${e.message}`);
        results[key] = null;
      }
    }
    return results;
  }

  /**
   * Clear cache for a specific episode or all
   */
  clearCache(epId = null) {
    if (epId) {
      const pattern = this.getCachePath(epId, '*');
      const dir = this.cacheDir;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(epId)) {
          fs.unlinkSync(path.join(dir, file));
          console.log(`[+] Deleted cache: ${file}`);
        }
      }
    } else {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      console.log(`[+] Cleared all cache (${files.length} files)`);
    }
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    const files = fs.readdirSync(this.cacheDir);
    const stats = {
      totalFiles: files.length,
      totalSize: 0,
      files: []
    };
    
    for (const file of files) {
      const filePath = path.join(this.cacheDir, file);
      const stat = fs.statSync(filePath);
      stats.totalSize += stat.size;
      stats.files.push({
        name: file,
        size: stat.size,
        modified: stat.mtime
      });
    }
    
    stats.totalSizeMB = (stats.totalSize / 1024 / 1024).toFixed(2);
    return stats;
  }
}

// ==================== CLI INTERFACE ====================

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const translator = new SubtitleTranslator();

  async function main() {
    switch (command) {
      case 'translate':
        const url = args[1];
        const lang = args[2] || 'en';
        const epId = args[3] || null;
        if (!url) {
          console.error('Usage: node translator.js translate <subtitle_url> <target_lang> [episode_id]');
          process.exit(1);
        }
        try {
          const result = await translator.translateFromUrl(url, lang, epId);
          console.log(result);
        } catch (e) {
          console.error('Error:', e.message);
          process.exit(1);
        }
        break;

      case 'clear':
        const epToClear = args[1] || null;
        translator.clearCache(epToClear);
        break;

      case 'stats':
        const stats = translator.getCacheStats();
        console.log(JSON.stringify(stats, null, 2));
        break;

      default:
        console.log(`
Subtitle Translator CLI
=======================
Commands:
  translate <url> <lang> [ep_id]  - Translate subtitle from URL
  clear [ep_id]                    - Clear cache (all or specific episode)
  stats                            - Show cache statistics

Examples:
  node translator.js translate https://example.com/sub.vtt en
  node translator.js translate https://example.com/sub.vtt es episode123
  node translator.js clear
  node translator.js stats
        `);
    }
  }

  main().catch(console.error);
}

module.exports = SubtitleTranslator;