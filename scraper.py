#!/usr/bin/env python3
"""
ZoroTV.bar Ultimate Scraper
- Anti-detection: Playwright stealth + random delays
- Full catalog, episode, and source extraction
- Subtitle VTT downloader
- JSON output for API
"""

import asyncio
import json
import sys
import re
import hashlib
import os
from datetime import datetime
from typing import Dict, List, Optional, Any
from urllib.parse import urljoin, urlparse

import aiohttp
import aiofiles
from playwright.async_api import async_playwright, Browser, Page
from fake_useragent import UserAgent
import random
import time

class ZoroScraper:
    def __init__(self, headless: bool = True, stealth: bool = True):
        self.base_url = "https://zorotv.bar"
        self.anime_list_url = f"{self.base_url}/anime"
        self.headless = headless
        self.stealth = stealth
        self.ua = UserAgent()
        self.session: Optional[aiohttp.ClientSession] = None
        self.cache_dir = "./cache"
        os.makedirs(self.cache_dir, exist_ok=True)

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers={"User-Agent": self.ua.random}
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()

    async def _get_page(self) -> tuple[Browser, Page]:
        """Launch browser with stealth options"""
        playwright = await async_playwright().start()
        browser = await playwright.chromium.launch(
            headless=self.headless,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-infobars'
            ]
        )
        context = await browser.new_context(
            user_agent=self.ua.random,
            viewport={'width': 1920, 'height': 1080},
            locale='en-US',
            timezone_id='America/New_York',
            permissions=['geolocation'],
            device_scale_factor=1,
            has_touch=False,
            is_mobile=False
        )
        page = await context.new_page()
        
        # Stealth: override navigator properties
        if self.stealth:
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                window.chrome = { runtime: {} };
                Object.defineProperty(document, 'hidden', {get: () => false});
            """)

        return browser, page

    async def _random_delay(self, min_sec: float = 1.0, max_sec: float = 3.0):
        """Human-like random delay"""
        await asyncio.sleep(random.uniform(min_sec, max_sec))

    async def _cache_get(self, key: str) -> Optional[Any]:
        """Get from cache"""
        cache_file = os.path.join(self.cache_dir, f"{hashlib.md5(key.encode()).hexdigest()}.json")
        if os.path.exists(cache_file):
            async with aiofiles.open(cache_file, 'r') as f:
                content = await f.read()
                return json.loads(content)
        return None

    async def _cache_set(self, key: str, data: Any):
        """Save to cache"""
        cache_file = os.path.join(self.cache_dir, f"{hashlib.md5(key.encode()).hexdigest()}.json")
        async with aiofiles.open(cache_file, 'w') as f:
            await f.write(json.dumps(data, indent=2))

    async def fetch_anime_list(self, page: int = 1, force_refresh: bool = False) -> List[Dict]:
        """Fetch paginated anime list with retry"""
        cache_key = f"anime_list_{page}"
        if not force_refresh:
            cached = await self._cache_get(cache_key)
            if cached:
                return cached

        for attempt in range(3):
            try:
                browser, page_obj = await self._get_page()
                url = f"{self.anime_list_url}?page={page}"
                print(f"[+] Fetching anime list page {page} (attempt {attempt+1})")
                
                await page_obj.goto(url, wait_until='domcontentloaded', timeout=30000)
                await self._random_delay(2, 4)
                
                # Wait for content to load
                await page_obj.wait_for_selector('.anime-item, .film-list, .items', timeout=15000)
                
                # Scroll to trigger lazy loading
                await page_obj.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                await self._random_delay(1, 2)

                anime_data = await page_obj.evaluate('''() => {
                    const items = document.querySelectorAll('.anime-item, .film-item, .item, .movie-item');
                    const result = [];
                    items.forEach(item => {
                        const title = item.querySelector('.title, .name, h3, .anime-title')?.innerText?.trim() || '';
                        const image = item.querySelector('img')?.src || 
                                     item.querySelector('.poster img')?.src || 
                                     item.querySelector('.cover img')?.src || '';
                        const url = item.querySelector('a')?.href || '';
                        const episodes = item.querySelector('.episodes, .eps, .episode-count')?.innerText?.trim() || '0';
                        const rating = item.querySelector('.rating, .score')?.innerText?.trim() || 'N/A';
                        const year = item.querySelector('.year, .release-date')?.innerText?.trim() || '';
                        
                        // Extract anime slug from URL
                        const slug = url.split('/').filter(Boolean).pop() || '';
                        
                        result.push({
                            title: title,
                            image: image.startsWith('//') ? 'https:' + image : image,
                            url: url,
                            slug: slug,
                            episodes: episodes.replace(/[^0-9]/g, '') || '0',
                            rating: rating,
                            year: year
                        });
                    });
                    return result;
                }''')

                await browser.close()
                
                # Clean and validate data
                anime_data = [a for a in anime_data if a['title'] and a['url']]
                
                await self._cache_set(cache_key, anime_data)
                return anime_data

            except Exception as e:
                print(f"[!] Error on attempt {attempt+1}: {str(e)}")
                await self._random_delay(5, 10)
                if attempt == 2:
                    raise
        return []

    async def fetch_anime_details(self, slug: str, force_refresh: bool = False) -> Dict:
        """Fetch detailed info for a specific anime"""
        cache_key = f"anime_details_{slug}"
        if not force_refresh:
            cached = await self._cache_get(cache_key)
            if cached:
                return cached

        url = f"{self.base_url}/anime/{slug}"
        print(f"[+] Fetching details for: {slug}")

        browser, page = await self._get_page()
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            await self._random_delay(2, 3)
            await page.wait_for_selector('.anime-info, .detail, .info', timeout=10000)

            details = await page.evaluate('''() => {
                const getText = (selector) => document.querySelector(selector)?.innerText?.trim() || '';
                const getAttr = (selector, attr) => document.querySelector(selector)?.getAttribute(attr) || '';
                
                return {
                    title: getText('.title, h1, .anime-title'),
                    synopsis: getText('.synopsis, .description, .summary, .plot'),
                    genres: Array.from(document.querySelectorAll('.genres a, .genre, .tags a')).map(el => el.innerText.trim()),
                    studios: getText('.studio, .studios'),
                    status: getText('.status, .airing-status'),
                    releaseYear: getText('.released, .year'),
                    coverImage: getAttr('.cover img, .poster img, .banner img', 'src'),
                    trailer: getAttr('.trailer iframe', 'src'),
                    totalEpisodes: getText('.episode-count, .episodes')
                };
            }''')

            # Fix image URLs
            if details['coverImage'] and details['coverImage'].startswith('//'):
                details['coverImage'] = 'https:' + details['coverImage']

            await browser.close()
            await self._cache_set(cache_key, details)
            return details

        except Exception as e:
            await browser.close()
            raise

    async def fetch_episode_list(self, slug: str, force_refresh: bool = False) -> List[Dict]:
        """Fetch all episodes for an anime"""
        cache_key = f"episodes_{slug}"
        if not force_refresh:
            cached = await self._cache_get(cache_key)
            if cached:
                return cached

        url = f"{self.base_url}/anime/{slug}"
        print(f"[+] Fetching episodes for: {slug}")

        browser, page = await self._get_page()
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            await self._random_delay(2, 3)
            
            # Wait for episode list
            await page.wait_for_selector('.episode-list, .episodes, .eplist, .episode-container', timeout=15000)

            episodes = await page.evaluate('''() => {
                const items = document.querySelectorAll('.episode-item, .episode, .eplist-item, .ep-list li');
                const result = [];
                items.forEach((item, index) => {
                    const num = item.querySelector('.ep-number, .ep-num, .number')?.innerText?.trim() || String(index + 1);
                    const title = item.querySelector('.ep-title, .title, .name')?.innerText?.trim() || '';
                    const url = item.querySelector('a')?.href || '';
                    const date = item.querySelector('.date, .release-date')?.innerText?.trim() || '';
                    
                    // Extract episode ID from URL
                    const epId = url.split('/').filter(Boolean).pop() || '';
                    
                    result.push({
                        number: num.replace(/[^0-9]/g, ''),
                        title: title || `Episode ${num}`,
                        url: url,
                        epId: epId,
                        date: date
                    });
                });
                return result;
            }''')

            await browser.close()
            await self._cache_set(cache_key, episodes)
            return episodes

        except Exception as e:
            await browser.close()
            raise

    async def fetch_episode_sources(self, ep_id: str, force_refresh: bool = False) -> Dict:
        """Fetch video sources, subtitles, and metadata for an episode"""
        cache_key = f"sources_{ep_id}"
        if not force_refresh:
            cached = await self._cache_get(cache_key)
            if cached:
                return cached

        url = f"{self.base_url}/watch/{ep_id}"
        print(f"[+] Fetching sources for episode: {ep_id}")

        browser, page = await self._get_page()
        try:
            await page.goto(url, wait_until='domcontentloaded', timeout=30000)
            await self._random_delay(2, 4)
            
            # Wait for player
            await page.wait_for_selector('.player, .video-container, #player, video, iframe', timeout=15000)

            sources_data = await page.evaluate('''() => {
                const sources = [];
                const subtitles = [];
                const info = {};
                
                // Get video element sources
                const video = document.querySelector('video');
                if (video) {
                    const src = video.src || video.querySelector('source')?.src;
                    if (src) sources.push({ url: src, type: 'direct', quality: 'auto' });
                    
                    // Get subtitle tracks
                    const tracks = video.textTracks;
                    for (let i = 0; i < tracks.length; i++) {
                        const track = tracks[i];
                        const trackUrl = track.src || track.getAttribute('src') || '';
                        if (trackUrl) {
                            subtitles.push({
                                url: trackUrl,
                                language: track.language || '',
                                label: track.label || track.language || 'Unknown'
                            });
                        }
                    }
                }
                
                // Get iframe embeds (server sources)
                const iframes = document.querySelectorAll('iframe');
                iframes.forEach(iframe => {
                    const src = iframe.src;
                    if (src && (src.includes('.m3u8') || src.includes('.mp4') || 
                        src.includes('embed') || src.includes('player') || 
                        src.includes('stream') || src.includes('video'))) {
                        sources.push({ url: src, type: 'embed', quality: 'auto' });
                    }
                });
                
                // Get server buttons if any
                const servers = document.querySelectorAll('.server, .server-btn, .source-btn');
                servers.forEach(server => {
                    const data = server.dataset || {};
                    const serverUrl = data.url || data.src || server.getAttribute('data-url') || '';
                    if (serverUrl) {
                        sources.push({ 
                            url: serverUrl, 
                            type: 'server', 
                            quality: server.innerText?.trim() || 'auto',
                            serverName: data.server || data.name || 'Unknown'
                        });
                    }
                });
                
                // Extract metadata
                info.title = document.querySelector('.episode-title, .title, h1')?.innerText?.trim() || '';
                info.episode = document.querySelector('.episode-number, .ep-num')?.innerText?.trim() || '';
                
                return { sources, subtitles, info };
            }''')

            # Process subtitle URLs
            for sub in sources_data['subtitles']:
                if sub['url'] and not sub['url'].startswith('http'):
                    sub['url'] = urljoin(self.base_url, sub['url'])

            await browser.close()
            
            # Deduplicate sources
            seen = set()
            unique_sources = []
            for s in sources_data['sources']:
                key = s['url']
                if key and key not in seen:
                    seen.add(key)
                    unique_sources.append(s)
            sources_data['sources'] = unique_sources

            await self._cache_set(cache_key, sources_data)
            return sources_data

        except Exception as e:
            await browser.close()
            raise

    async def download_subtitle(self, sub_url: str, output_path: str) -> str:
        """Download and save subtitle file"""
        if not sub_url:
            return ''
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(sub_url, headers={'User-Agent': self.ua.random}) as resp:
                    if resp.status == 200:
                        content = await resp.text()
                        os.makedirs(os.path.dirname(output_path), exist_ok=True)
                        async with aiofiles.open(output_path, 'w', encoding='utf-8') as f:
                            await f.write(content)
                        return output_path
        except Exception as e:
            print(f"[!] Failed to download subtitle: {e}")
        return ''

    async def search_anime(self, query: str, limit: int = 10) -> List[Dict]:
        """Search for anime by title"""
        cache_key = f"search_{query.lower().replace(' ', '_')}"
        cached = await self._cache_get(cache_key)
        if cached:
            return cached[:limit]

        browser, page = await self._get_page()
        try:
            search_url = f"{self.base_url}/search?keyword={query.replace(' ', '+')}"
            await page.goto(search_url, wait_until='domcontentloaded', timeout=30000)
            await self._random_delay(2, 3)
            
            results = await page.evaluate('''() => {
                const items = document.querySelectorAll('.anime-item, .search-result, .item');
                return Array.from(items).map(item => ({
                    title: item.querySelector('.title, .name')?.innerText?.trim() || '',
                    image: item.querySelector('img')?.src || '',
                    url: item.querySelector('a')?.href || '',
                    slug: (item.querySelector('a')?.href || '').split('/').filter(Boolean).pop() || ''
                }));
            }''')
            
            await browser.close()
            await self._cache_set(cache_key, results)
            return results[:limit]

        except Exception as e:
            await browser.close()
            raise

    async def get_anime_genres(self) -> List[str]:
        """Get list of available genres"""
        cache_key = "genres_list"
        cached = await self._cache_get(cache_key)
        if cached:
            return cached

        browser, page = await self._get_page()
        try:
            await page.goto(self.base_url, wait_until='domcontentloaded', timeout=30000)
            genres = await page.evaluate('''() => {
                return Array.from(document.querySelectorAll('.genre, .genres a, .tag'))
                    .map(el => el.innerText.trim())
                    .filter(g => g && g.length > 0);
            }''')
            
            await browser.close()
            genres = list(set(genres))
            await self._cache_set(cache_key, genres)
            return genres

        except Exception as e:
            await browser.close()
            raise

    async def get_recent_episodes(self, limit: int = 20) -> List[Dict]:
        """Get recently updated episodes"""
        cache_key = "recent_episodes"
        cached = await self._cache_get(cache_key)
        if cached:
            return cached[:limit]

        browser, page = await self._get_page()
        try:
            await page.goto(f"{self.base_url}/recent", wait_until='domcontentloaded', timeout=30000)
            await self._random_delay(2, 3)
            
            episodes = await page.evaluate('''() => {
                const items = document.querySelectorAll('.recent-item, .episode-item, .update-item');
                return Array.from(items).map(item => ({
                    title: item.querySelector('.title, .anime-name')?.innerText?.trim() || '',
                    episode: item.querySelector('.ep-number, .episode')?.innerText?.trim() || '',
                    url: item.querySelector('a')?.href || '',
                    image: item.querySelector('img')?.src || '',
                    time: item.querySelector('.time, .date')?.innerText?.trim() || ''
                }));
            }''')
            
            await browser.close()
            await self._cache_set(cache_key, episodes)
            return episodes[:limit]

        except Exception as e:
            await browser.close()
            raise

# ==================== CLI INTERFACE ====================

async def main():
    import argparse
    parser = argparse.ArgumentParser(description='ZoroTV.bar Ultimate Scraper')
    parser.add_argument('action', choices=['list', 'details', 'episodes', 'sources', 'search', 'recent', 'genres'])
    parser.add_argument('--page', type=int, default=1, help='Page number for list')
    parser.add_argument('--slug', type=str, help='Anime slug')
    parser.add_argument('--ep-id', type=str, help='Episode ID')
    parser.add_argument('--query', type=str, help='Search query')
    parser.add_argument('--limit', type=int, default=10, help='Limit results')
    parser.add_argument('--force', action='store_true', help='Force refresh cache')
    parser.add_argument('--headless', action='store_true', default=True, help='Run in headless mode')
    parser.add_argument('--output', type=str, help='Output JSON file')
    
    args = parser.parse_args()
    
    async with ZoroScraper(headless=args.headless) as scraper:
        result = {}
        try:
            if args.action == 'list':
                result = await scraper.fetch_anime_list(args.page, args.force)
            elif args.action == 'details':
                if not args.slug:
                    print("Error: --slug required for details")
                    sys.exit(1)
                result = await scraper.fetch_anime_details(args.slug, args.force)
            elif args.action == 'episodes':
                if not args.slug:
                    print("Error: --slug required for episodes")
                    sys.exit(1)
                result = await scraper.fetch_episode_list(args.slug, args.force)
            elif args.action == 'sources':
                if not args.ep_id:
                    print("Error: --ep-id required for sources")
                    sys.exit(1)
                result = await scraper.fetch_episode_sources(args.ep_id, args.force)
            elif args.action == 'search':
                if not args.query:
                    print("Error: --query required for search")
                    sys.exit(1)
                result = await scraper.search_anime(args.query, args.limit)
            elif args.action == 'recent':
                result = await scraper.get_recent_episodes(args.limit)
            elif args.action == 'genres':
                result = await scraper.get_anime_genres()
            
            output = json.dumps(result, indent=2, ensure_ascii=False)
            
            if args.output:
                with open(args.output, 'w', encoding='utf-8') as f:
                    f.write(output)
                print(f"[+] Output saved to {args.output}")
            else:
                print(output)
                
        except Exception as e:
            print(f"[!] Error: {str(e)}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())