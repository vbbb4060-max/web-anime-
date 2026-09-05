/**
 * ANIMEFLIX FRONTEND
 * Full Netflix-style UI with:
 * - Responsive grid layout
 * - Infinite scroll / pagination
 * - Video player with subtitle support
 * - Language selector for subtitles
 * - Search functionality
 * - Watch history (localStorage)
 * - Dark theme with smooth animations
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import './App.css';

// ==================== CONFIGURATION ====================

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// ==================== CUSTOM HOOKS ====================

function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = (value) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch {}
  };

  return [storedValue, setValue];
}

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

// ==================== COMPONENTS ====================

// Loading skeleton
const LoadingSkeleton = ({ count = 12 }) => (
  <div className="skeleton-grid">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="skeleton-card">
        <div className="skeleton-image"></div>
        <div className="skeleton-title"></div>
        <div className="skeleton-episodes"></div>
      </div>
    ))}
  </div>
);

// Anime card component
const AnimeCard = ({ anime, onClick }) => (
  <div className="anime-card" onClick={() => onClick(anime)}>
    <div className="anime-card-image">
      <img src={anime.image || '/placeholder.jpg'} alt={anime.title} loading="lazy" />
      {anime.episodes && (
        <span className="episode-badge">{anime.episodes}</span>
      )}
    </div>
    <h3 className="anime-title">{anime.title}</h3>
    <div className="anime-meta">
      {anime.rating && <span className="rating">⭐ {anime.rating}</span>}
      {anime.year && <span className="year">{anime.year}</span>}
    </div>
  </div>
);

// Episode list component
const EpisodeList = ({ episodes, onSelect, selectedEpisode }) => (
  <div className="episode-list">
    <h3>Episodes</h3>
    <div className="episode-grid">
      {episodes.map((ep, index) => (
        <div
          key={ep.epId || index}
          className={`episode-item ${selectedEpisode === ep.epId ? 'active' : ''}`}
          onClick={() => onSelect(ep)}
        >
          <span className="ep-number">{ep.number || index + 1}</span>
          <span className="ep-title">{ep.title || `Episode ${index + 1}`}</span>
        </div>
      ))}
    </div>
  </div>
);

// Video player component with subtitles
const VideoPlayer = ({ src, subtitles, onClose, episodeInfo }) => {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useLocalStorage('video_volume', 0.8);
  const [selectedSub, setSelectedSub] = useState(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
      setDuration(videoRef.current.duration);
    }
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
    }
  };

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="video-player-modal" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="video-player-container">
        <button className="close-player" onClick={onClose}>✕</button>
        
        <div className="video-wrapper">
          <video
            ref={videoRef}
            src={src}
            onClick={togglePlay}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => setIsPlaying(false)}
            crossOrigin="anonymous"
          >
            {subtitles && subtitles.map((sub, i) => (
              <track
                key={i}
                kind="subtitles"
                src={sub.url}
                srcLang={sub.language}
                label={sub.label}
                default={i === 0}
              />
            ))}
          </video>
          
          <div className="video-controls">
            <button onClick={togglePlay}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <span className="time-display">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <input
              type="range"
              className="volume-slider"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={handleVolumeChange}
            />
            <span className="volume-icon">🔊</span>
          </div>
        </div>

        {episodeInfo && (
          <div className="episode-info">
            <h3>{episodeInfo.title}</h3>
            <p>{episodeInfo.description}</p>
          </div>
        )}

        {subtitles && subtitles.length > 1 && (
          <div className="subtitle-selector">
            <label>Subtitles: </label>
            <select onChange={(e) => setSelectedSub(e.target.value)}>
              {subtitles.map((sub, i) => (
                <option key={i} value={i}>{sub.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
};

// ==================== MAIN APP ====================

function App() {
  // State
  const [animeList, setAnimeList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [selectedAnime, setSelectedAnime] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [selectedEpisode, setSelectedEpisode] = useState(null);
  const [videoData, setVideoData] = useState(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [language, setLanguage] = useLocalStorage('subtitle_language', 'en');
  const [recentEpisodes, setRecentEpisodes] = useLocalStorage('recent_episodes', []);
  const [viewMode, setViewMode] = useState('grid'); // grid | list

  const debouncedSearch = useDebounce(searchQuery, 500);
  const observerRef = useRef(null);
  const lastElementRef = useRef(null);

  // ==================== API CALLS ====================

  const fetchAnimeList = useCallback(async (pageNum, append = true) => {
    if (loading) return;
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/anime`, {
        params: { page: pageNum, limit: 20 }
      });
      const data = response.data.data || [];
      if (append) {
        setAnimeList(prev => [...prev, ...data]);
      } else {
        setAnimeList(data);
      }
      setHasMore(data.length > 0);
    } catch (error) {
      console.error('Failed to fetch anime:', error);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const fetchAnimeDetails = useCallback(async (slug) => {
    try {
      const response = await axios.get(`${API_URL}/anime/${slug}`);
      const data = response.data.data;
      if (data.episodes) {
        setEpisodes(data.episodes);
      }
      return data;
    } catch (error) {
      console.error('Failed to fetch anime details:', error);
      return null;
    }
  }, []);

  const fetchEpisodeSources = useCallback(async (epId) => {
    try {
      const response = await axios.get(`${API_URL}/watch/${epId}`, {
        params: { lang: language }
      });
      const data = response.data.data;
      setVideoData(data);
      setShowPlayer(true);
      
      // Add to recent
      setRecentEpisodes(prev => {
        const exists = prev.find(e => e.epId === epId);
        if (exists) {
          return [exists, ...prev.filter(e => e.epId !== epId)];
        }
        return [{ epId, title: data.episode?.title || `Episode ${epId}`, watched: Date.now() }, ...prev].slice(0, 50);
      });
      
      return data;
    } catch (error) {
      console.error('Failed to fetch episode sources:', error);
      alert('Failed to load video. Please try again.');
      return null;
    }
  }, [language, setRecentEpisodes]);

  const searchAnime = useCallback(async (query) => {
    if (!query || query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    try {
      const response = await axios.get(`${API_URL}/search`, {
        params: { q: query, limit: 20 }
      });
      setSearchResults(response.data.data || []);
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  // ==================== EFFECTS ====================

  useEffect(() => {
    fetchAnimeList(1, false);
  }, []);

  useEffect(() => {
    if (debouncedSearch) {
      searchAnime(debouncedSearch);
    } else {
      setSearchResults([]);
    }
  }, [debouncedSearch, searchAnime]);

  // Infinite scroll
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading && !searchQuery) {
        setPage(prev => prev + 1);
      }
    }, { threshold: 0.1 });

    if (lastElementRef.current) {
      observerRef.current.observe(lastElementRef.current);
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, loading, searchQuery]);

  useEffect(() => {
    if (page > 1 && !searchQuery) {
      fetchAnimeList(page, true);
    }
  }, [page, fetchAnimeList, searchQuery]);

  // ==================== HANDLERS ====================

  const handleAnimeClick = async (anime) => {
    setSelectedAnime(anime);
    const details = await fetchAnimeDetails(anime.slug);
    if (details) {
      setSelectedAnime({ ...anime, ...details });
    }
  };

  const handleEpisodeSelect = async (episode) => {
    setSelectedEpisode(episode);
    await fetchEpisodeSources(episode.epId);
  };

  const handleBack = () => {
    setSelectedAnime(null);
    setEpisodes([]);
    setSelectedEpisode(null);
    setVideoData(null);
  };

  const handleClosePlayer = () => {
    setShowPlayer(false);
    setVideoData(null);
  };

  const handleLanguageChange = (e) => {
    setLanguage(e.target.value);
    // Reload current episode with new language
    if (selectedEpisode) {
      fetchEpisodeSources(selectedEpisode.epId);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
  };

  // ==================== RENDER ====================

  // Determine what to display
  const displayData = searchQuery ? searchResults : animeList;
  const isLoading = loading || isSearching;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1 className="logo">ANIME<span>FLIX</span></h1>
          <button className="mode-toggle" onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}>
            {viewMode === 'grid' ? '⊞ List' : '⊠ Grid'}
          </button>
        </div>

        <div className="header-right">
          <div className="search-container">
            <input
              type="text"
              placeholder="Search anime..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button className="clear-search" onClick={handleClearSearch}>✕</button>
            )}
          </div>

          <select
            value={language}
            onChange={handleLanguageChange}
            className="language-select"
          >
            <option value="en">🇬🇧 English</option>
            <option value="es">🇪🇸 Spanish</option>
            <option value="fr">🇫🇷 French</option>
            <option value="de">🇩🇪 German</option>
            <option value="ja">🇯🇵 Japanese</option>
            <option value="zh">🇨🇳 Chinese</option>
            <option value="ar">🇸🇦 Arabic</option>
            <option value="pt">🇵🇹 Portuguese</option>
            <option value="ru">🇷🇺 Russian</option>
            <option value="it">🇮🇹 Italian</option>
            <option value="ko">🇰🇷 Korean</option>
          </select>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {selectedAnime ? (
          // Anime detail view
          <div className="anime-detail-view">
            <button className="back-button" onClick={handleBack}>← Back</button>
            
            <div className="anime-detail-header">
              <img
                src={selectedAnime.coverImage || selectedAnime.image}
                alt={selectedAnime.title}
                className="anime-cover"
              />
              <div className="anime-info">
                <h2>{selectedAnime.title}</h2>
                <p className="synopsis">{selectedAnime.synopsis || 'No synopsis available.'}</p>
                <div className="detail-meta">
                  {selectedAnime.genres && (
                    <div className="genres">
                      {selectedAnime.genres.map(g => (
                        <span key={g} className="genre-tag">{g}</span>
                      ))}
                    </div>
                  )}
                  {selectedAnime.status && <span className="status">{selectedAnime.status}</span>}
                  {selectedAnime.releaseYear && <span className="year">{selectedAnime.releaseYear}</span>}
                </div>
              </div>
            </div>

            <EpisodeList
              episodes={episodes}
              onSelect={handleEpisodeSelect}
              selectedEpisode={selectedEpisode?.epId}
            />
          </div>
        ) : (
          // Grid/List view
          <>
            {searchQuery && displayData.length > 0 && (
              <div className="search-results-info">
                Found {displayData.length} results for "{searchQuery}"
              </div>
            )}

            {isLoading && displayData.length === 0 ? (
              <LoadingSkeleton />
            ) : displayData.length === 0 ? (
              <div className="empty-state">
                <p>No anime found {searchQuery && `for "${searchQuery}"`}</p>
              </div>
            ) : (
              <div className={`anime-grid ${viewMode}`}>
                {displayData.map((anime, index) => (
                  <div
                    key={anime.slug || index}
                    ref={index === displayData.length - 1 ? lastElementRef : null}
                  >
                    <AnimeCard anime={anime} onClick={handleAnimeClick} />
                  </div>
                ))}
              </div>
            )}

            {loading && displayData.length > 0 && (
              <div className="loading-more">Loading more...</div>
            )}
          </>
        )}
      </main>

      {/* Video Player Modal */}
      {showPlayer && videoData && (
        <VideoPlayer
          src={videoData.sources?.[0]?.url || ''}
          subtitles={[
            ...(videoData.translatedSubtitle ? [{
              url: videoData.translatedSubtitle.url || videoData.translatedSubtitle,
              language: language,
              label: `Translated (${language})`
            }] : []),
            ...(videoData.originalSubtitles || [])
          ]}
          onClose={handleClosePlayer}
          episodeInfo={videoData.episode}
        />
      )}

      {/* Footer */}
      <footer className="footer">
        <p>AnimeFlix - Watch anime free. No ads. No bullshit.</p>
        <p className="disclaimer">All content is streamed from third-party sources.</p>
      </footer>
    </div>
  );
}

export default App;