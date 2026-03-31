import { useEffect, useState, useRef, useMemo } from 'react';
import Map from './components/Map';
import NewsFeed from './components/NewsFeed';
import { NewsItem } from './types';
import { Layers, Map as MapIcon, Filter, Loader2 } from 'lucide-react';
import { US_STATES, WORLD_CITIES, COUNTRY_MAP } from './constants/locations';

const FALLBACK_COUNTRIES = Object.keys(COUNTRY_MAP);

const CITY_TO_COUNTRY_CODE: Record<string, string> = {
  ...WORLD_CITIES
};

const MAJOR_CITIES = Object.keys(WORLD_CITIES);

const ALL_STATES = Object.keys(US_STATES);

export default function App() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [selectedNewsId, setSelectedNewsId] = useState<string>();
  const [showCountryHeatmap, setShowCountryHeatmap] = useState(true);
  const [showPointHeatmap, setShowPointHeatmap] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [filterTopic, setFilterTopic] = useState('');
  const [timeFilter, setTimeFilter] = useState<'1h' | '6h' | '24h' | '48h' | '7d' | 'custom' | 'all'>('24h');
  const [customDays, setCustomDays] = useState(30);
  const [heatmapRadius, setHeatmapRadius] = useState(25);
  const [heatmapBlur, setHeatmapBlur] = useState(15);
  const [autoZoomOnNew, setAutoZoomOnNew] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingCount, setProcessingCount] = useState({ current: 0, total: 0 });
  const [logLevel, setLogLevel] = useState<'debug' | 'error'>('debug');
  const processedIds = useRef<Set<string>>(new Set());
  const processedTitles = useRef<Set<string>>(new Set());

  const logger = {
    debug: (msg: string, ...args: any[]) => { if (logLevel === 'debug') console.log(`[DEBUG] ${msg}`, ...args); },
    info: (msg: string, ...args: any[]) => { if (logLevel === 'debug') console.log(`[INFO] ${msg}`, ...args); },
    warn: (msg: string, ...args: any[]) => { if (logLevel === 'debug') console.warn(`[WARN] ${msg}`, ...args); },
    error: (msg: string, ...args: any[]) => { console.error(`[ERROR] ${msg}`, ...args); },
  };

  const processNewsItem = async (rawItem: any) => {
    const normalizedTitle = rawItem.title.trim().toLowerCase();
    if (processedIds.current.has(rawItem.id) || processedTitles.current.has(normalizedTitle)) return null;
    
    let extractedLocation = null;
    let countryCode = "";
    let countryName = "Global";

    // 1. Rule-based extraction (Fast, No AI)
    const title = rawItem.title;
    const desc = rawItem.description || "";
    const combinedText = (title + " " + desc).toLowerCase();
    const titleLower = title.toLowerCase();
    const categories = rawItem.categories || [];
    
    // 1a. Direct RSS GeoPoint (Best)
    if (rawItem.geoPoint) {
      const pubDate = rawItem.pubDate || new Date().toISOString();
      const dateObj = new Date(pubDate);
      const timestamp = isNaN(dateObj.getTime()) ? Date.now() : dateObj.getTime();

      const enrichedItem: NewsItem = {
        ...rawItem,
        locationName: "Geotagged Location",
        countryCode: "",
        countryName: "Global",
        lat: rawItem.geoPoint.lat,
        lng: rawItem.geoPoint.lng,
        timestamp: timestamp
      };
      logger.info(`[MATCHED] Direct RSS GeoPoint for "${title}"`);
      processedIds.current.add(rawItem.id);
      processedTitles.current.add(normalizedTitle);
      return enrichedItem;
    }

    // 1b. Direct RSS Location string
    if (rawItem.rssLocation) {
      extractedLocation = rawItem.rssLocation;
      logger.info(`[MATCHED] Direct RSS Location tag: ${extractedLocation} for "${title}"`);
    }

    // 1c. Scan TITLE for countries (High Priority)
    if (!extractedLocation) {
      for (const country of FALLBACK_COUNTRIES) {
        const regex = new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(titleLower)) {
          extractedLocation = country;
          countryName = country;
          countryCode = COUNTRY_MAP[country] || "";
          logger.info(`[MATCHED] Rule-based extraction (Country Scan - Title): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1d. Scan TITLE for major cities (High Priority)
    if (!extractedLocation) {
      for (const city of MAJOR_CITIES) {
        const regex = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(titleLower)) {
          extractedLocation = city;
          countryCode = CITY_TO_COUNTRY_CODE[city] || "";
          logger.info(`[MATCHED] Rule-based extraction (City Scan - Title): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1e. Scan TITLE for US States (High Priority)
    if (!extractedLocation) {
      for (const state of ALL_STATES) {
        const regex = new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(titleLower)) {
          extractedLocation = state;
          countryName = "United States";
          countryCode = "USA";
          logger.info(`[MATCHED] Rule-based extraction (State Scan - Title): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1f. Scan Categories for locations
    if (!extractedLocation) {
      for (const cat of categories) {
        const isCity = MAJOR_CITIES.find(c => c.toLowerCase() === cat.toLowerCase());
        const isCountry = FALLBACK_COUNTRIES.find(c => c.toLowerCase() === cat.toLowerCase());
        if (isCity || isCountry) {
          extractedLocation = cat;
          if (isCountry) {
            countryName = isCountry;
            countryCode = COUNTRY_MAP[isCountry] || "";
          } else if (isCity) {
            countryCode = CITY_TO_COUNTRY_CODE[isCity] || "";
          }
          logger.info(`[MATCHED] RSS Category: ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1g. Pattern: "Location: Headline" or "Location - Headline"
    if (!extractedLocation) {
      const prefixMatch = title.match(/^([^:|-]{3,20})[:|-]\s/);
      if (prefixMatch) {
        const potentialLoc = prefixMatch[1].trim();
        const isCity = MAJOR_CITIES.find(c => c.toLowerCase() === potentialLoc.toLowerCase());
        const isCountry = FALLBACK_COUNTRIES.find(c => c.toLowerCase() === potentialLoc.toLowerCase());
        const isState = ALL_STATES.find(s => s.toLowerCase() === potentialLoc.toLowerCase());
        
        if (isCity || isCountry || isState) {
          extractedLocation = potentialLoc;
          if (isCountry) {
            countryName = isCountry;
            countryCode = COUNTRY_MAP[isCountry] || "";
          } else if (isCity) {
            countryCode = CITY_TO_COUNTRY_CODE[isCity] || "";
          } else if (isState) {
            countryName = "United States";
            countryCode = "USA";
          }
          logger.info(`[MATCHED] Rule-based extraction (Prefix): ${extractedLocation} for "${title}"`);
        }
      }
    }

    // 1h. Scan DESCRIPTION for countries (Fallback)
    if (!extractedLocation) {
      for (const country of FALLBACK_COUNTRIES) {
        const regex = new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(desc.toLowerCase())) {
          extractedLocation = country;
          countryName = country;
          countryCode = COUNTRY_MAP[country] || "";
          logger.info(`[MATCHED] Rule-based extraction (Country Scan - Desc): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1i. Scan DESCRIPTION for major cities (Fallback)
    if (!extractedLocation) {
      for (const city of MAJOR_CITIES) {
        const regex = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(desc.toLowerCase())) {
          extractedLocation = city;
          countryCode = CITY_TO_COUNTRY_CODE[city] || "";
          logger.info(`[MATCHED] Rule-based extraction (City Scan - Desc): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    // 1j. Scan DESCRIPTION for US States (Fallback)
    if (!extractedLocation) {
      for (const state of ALL_STATES) {
        const regex = new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(desc.toLowerCase())) {
          extractedLocation = state;
          countryName = "United States";
          countryCode = "USA";
          logger.info(`[MATCHED] Rule-based extraction (State Scan - Desc): ${extractedLocation} for "${title}"`);
          break;
        }
      }
    }

    if (!extractedLocation) {
      extractedLocation = "Global";
    }

    if (extractedLocation === "Global") {
      processedIds.current.add(rawItem.id);
      return null;
    }

    try {
      // 3. Geocoding
      const geocodeQuery = (extractedLocation === "Global" && countryName && countryName !== "Global") ? countryName : extractedLocation;
      if (!geocodeQuery || geocodeQuery === "Global") {
        processedIds.current.add(rawItem.id);
        return null;
      }

      const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(geocodeQuery)}`);
      
      if (!geoRes.ok) {
        if (geoRes.status === 404) {
          logger.warn(`Location not found for: ${geocodeQuery}`);
          processedIds.current.add(rawItem.id);
        } else {
          logger.error(`Geocoding API error (${geoRes.status}) for: ${geocodeQuery}`);
        }
        return null;
      }

      const geo = await geoRes.json();
      
      // Refine descriptive location
      let descriptiveLocation = extractedLocation;
      if (geo.displayName) {
        const parts = geo.displayName.split(',').map((p: string) => p.trim());
        if (parts.length > 1) {
          descriptiveLocation = parts.slice(0, 3).join(', ');
        }
      }

      // Ensure pubDate is valid
      const pubDate = rawItem.pubDate || new Date().toISOString();
      const dateObj = new Date(pubDate);
      const timestamp = isNaN(dateObj.getTime()) ? Date.now() : dateObj.getTime();

      const enrichedItem: NewsItem = {
        ...rawItem,
        locationName: descriptiveLocation,
        countryCode: countryCode || "",
        countryName: countryName || "Global",
        lat: geo.lat,
        lng: geo.lng,
        timestamp: timestamp
      };

      processedIds.current.add(rawItem.id);
      processedTitles.current.add(normalizedTitle);
      return enrichedItem;
    } catch (error) {
      logger.error("Error geocoding news item:", error);
      return null;
    }
  };

  const autoZoomRef = useRef(autoZoomOnNew);
  useEffect(() => {
    autoZoomRef.current = autoZoomOnNew;
  }, [autoZoomOnNew]);

  const isProcessingRef = useRef(false);

  const fetchAndProcessNews = async () => {
    logger.info("Starting news fetch and process cycle...");
    if (isProcessingRef.current) {
      logger.debug("Already processing, skipping this cycle.");
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);
    
    try {
      // 1. Fetch fresh RSS
      const res = await fetch('/api/news-rss');
      if (!res.ok) {
        throw new Error(`RSS API returned ${res.status}: ${await res.text()}`);
      }
      
      const rawItems = await res.json();
      if (!Array.isArray(rawItems)) {
        throw new Error("RSS API did not return an array of items");
      }
      
      logger.info(`Fetched ${rawItems.length} news items from RSS.`);
      
      const newItems: NewsItem[] = [];
      // Filter for items not in cache (by ID or Title)
      const unprocessed = rawItems.filter((item: any) => {
        const normalizedTitle = item.title.trim().toLowerCase();
        return !processedIds.current.has(item.id) && !processedTitles.current.has(normalizedTitle);
      }).slice(0, 50);
      
      logger.info(`Processing ${unprocessed.length} new items...`);
      setProcessingCount({ current: 0, total: unprocessed.length });
      
      let currentIdx = 0;
      for (const item of unprocessed) {
        currentIdx++;
        setProcessingCount({ current: currentIdx, total: unprocessed.length });
        
        // Add a small delay before Gemini call to be gentler on the API
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const enriched = await processNewsItem(item);
        if (enriched) {
          newItems.push(enriched);
          logger.debug(`Successfully processed: ${enriched.title} (${enriched.locationName})`);
          
          // Update UI incrementally so user sees progress
          setNews(prev => {
            const combined = [enriched, ...prev];
            const unique = combined.filter((item, index, self) => 
              index === self.findIndex((t) => t.id === item.id || t.title.trim().toLowerCase() === item.title.trim().toLowerCase())
            );
            return unique.slice(0, 5000);
          });

          // Save to DB immediately too
          fetch('/api/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([enriched])
          }).catch(err => logger.error("Failed to save item to DB", err));
        }
        
        // Wait for geocoding rate limit (Nominatim is 1 req/sec)
        await new Promise(resolve => setTimeout(resolve, 1100));
      }

      if (newItems.length > 0) {
        logger.info(`Finished processing batch. Added ${newItems.length} new items.`);
        if (autoZoomRef.current && newItems.length > 0) {
          setSelectedNewsId(newItems[0].id);
        }
        setLastUpdated(Date.now());
      }
    } catch (error) {
      logger.error("Failed to fetch/process news:", error);
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      setProcessingCount({ current: 0, total: 0 });
    }
  };

  useEffect(() => {
    const initFetch = async () => {
      try {
        const cacheRes = await fetch('/api/news');
        const cachedNews = await cacheRes.json();
        if (cachedNews.length > 0) {
          setNews(cachedNews);
          cachedNews.forEach((item: NewsItem) => {
            processedIds.current.add(item.id);
            processedTitles.current.add(item.title.trim().toLowerCase());
          });
          logger.info(`Loaded ${cachedNews.length} items from cache.`);
        } else {
          // If cache is empty, it might have been cleared. Reset our local tracking.
          logger.info("Cache is empty. Resetting local tracking.");
          processedIds.current.clear();
          processedTitles.current.clear();
          setNews([]);
        }
      } catch (e) {
        logger.error("Initial fetch failed", e);
      }
      // After initial cache fetch, do a fresh RSS check
      fetchAndProcessNews();
    };
    initFetch();

    const interval = setInterval(fetchAndProcessNews, 60000);
    return () => clearInterval(interval);
  }, []);

  const [showFlushConfirm, setShowFlushConfirm] = useState(false);

  const flushDatabase = async () => {
    logger.info("Flushing database...");
    try {
      const res = await fetch('/api/news/flush', { method: 'POST' });
      if (res.ok) {
        logger.info("Database flushed on server.");
        processedIds.current.clear();
        processedTitles.current.clear();
        setNews([]);
        logger.info("Local state cleared.");
        setShowFlushConfirm(false);
        
        // Reset processing flag to allow immediate re-fetch
        isProcessingRef.current = false;
        setIsProcessing(false);
        
        // Re-fetch news after flush
        logger.info("Triggering fresh fetch after flush...");
        fetchAndProcessNews();
      } else {
        logger.error("Failed to flush database on server:", await res.text());
      }
    } catch (e) {
      logger.error("Failed to flush database", e);
    }
  };

  const agencies = Array.from(new Set(news.map(item => item.source))).sort();
  const countries: string[] = news
    .map(item => item.countryCode)
    .filter((code): code is string => !!code)
    .filter((code, index, self) => self.indexOf(code) === index)
    .sort();

  // Helper to get country name from code if available in news items
  const getCountryName = (code: string) => {
    const item = news.find(n => n.countryCode === code);
    return item?.countryName || code;
  };

  const filteredNews = useMemo(() => {
    return news.filter(item => {
      const matchesTopic = item.title.toLowerCase().includes(filterTopic.toLowerCase()) ||
                          item.source.toLowerCase().includes(filterTopic.toLowerCase());
      
      if (!matchesTopic) return false;

      if (agencyFilter !== 'all' && item.source !== agencyFilter) return false;
      
      if (countryFilter !== 'all' && item.countryCode !== countryFilter) return false;

      if (timeFilter === 'all') return true;
      
      const now = Date.now();
      const itemTime = item.timestamp;
      const diffHours = (now - itemTime) / (1000 * 60 * 60);

      // Handle potential future dates from clock skew or timezone issues
      // We allow up to 24 hours in the "future" to account for significant clock offsets
      if (diffHours < -24) return false; 

      if (timeFilter === '1h') return diffHours <= 1;
      if (timeFilter === '6h') return diffHours <= 6;
      if (timeFilter === '24h') return diffHours <= 24;
      if (timeFilter === '48h') return diffHours <= 48;
      if (timeFilter === '7d') return diffHours <= 24 * 7;
      if (timeFilter === 'custom') return diffHours <= 24 * customDays;
      
      return true;
    }).sort((a, b) => b.timestamp - a.timestamp);
  }, [news, filterTopic, agencyFilter, countryFilter, timeFilter, customDays]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden">
      {/* Header */}
      <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-4 md:px-6 shrink-0 relative z-[2000] bg-zinc-950/50 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center shadow-lg shadow-orange-900/20">
            <MapIcon size={20} className="text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">GeoNews <span className="text-orange-500 italic">Live</span></h1>
        </div>

        <div className="flex items-center gap-4">
          {isProcessing && (
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-orange-500 animate-pulse">
              <Loader2 size={12} className="animate-spin" />
              Live Processing {processingCount.total > 0 ? `(${processingCount.current}/${processingCount.total})` : ''}
            </div>
          )}
          
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 mr-2">
              <span className="text-zinc-500 text-[9px] uppercase font-bold tracking-widest">Logs:</span>
              <button
                onClick={() => setLogLevel(logLevel === 'debug' ? 'error' : 'debug')}
                className={`px-2 py-1 rounded text-[9px] font-bold uppercase transition-all border ${logLevel === 'debug' ? 'bg-orange-600/10 border-orange-500/50 text-orange-500' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-400'}`}
              >
                {logLevel}
              </button>
            </div>
            <button
              onClick={() => fetchAndProcessNews()}
              disabled={isProcessing}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-[10px] font-bold uppercase tracking-wider rounded border border-zinc-700 transition-colors"
            >
              Refresh News
            </button>
            <div className="h-8 w-[1px] bg-zinc-800 mx-2" />
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold uppercase tracking-wider transition-all border ${showSettings ? 'bg-orange-600 border-orange-500 text-white shadow-lg shadow-orange-900/40' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'}`}
            >
              <Filter size={14} />
              {showSettings ? 'Close Controls' : 'Control Center'}
            </button>
          </div>
        </div>

        {/* Unified Control Center Overlay */}
        {showSettings && (
          <div className="absolute top-20 right-4 md:right-6 w-[calc(100%-2rem)] md:w-80 bg-zinc-900/95 backdrop-blur-2xl border border-zinc-800 rounded-2xl p-5 shadow-2xl z-[2001] animate-in fade-in slide-in-from-top-4 duration-200 overflow-y-auto max-h-[calc(100vh-6rem)]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-bold flex items-center gap-2 uppercase tracking-widest">
                <Filter size={14} className="text-orange-500" />
                Control Center
              </h3>
              <div className="text-[10px] font-bold text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded uppercase">v2.0</div>
            </div>
            
            <div className="space-y-6">
              {/* Search & Filters */}
              <div className="space-y-3">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Search & Filters</label>
                <div className="relative">
                  <Filter size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input 
                    type="text" 
                    placeholder="TOPIC OR SOURCE..." 
                    value={filterTopic}
                    onChange={(e) => setFilterTopic(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2 pl-9 pr-4 text-[11px] font-bold uppercase tracking-wider focus:outline-none focus:border-orange-500 transition-colors"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-2">
                  <select 
                    value={agencyFilter}
                    onChange={(e) => setAgencyFilter(e.target.value)}
                    className="bg-zinc-950 border border-zinc-800 rounded-lg py-2 px-3 text-[10px] font-bold uppercase tracking-wider focus:outline-none focus:border-orange-500 transition-colors appearance-none cursor-pointer"
                  >
                    <option value="all">All Sources</option>
                    {agencies.map(agency => (
                      <option key={agency} value={agency}>{agency}</option>
                    ))}
                  </select>

                  <select 
                    value={countryFilter}
                    onChange={(e) => setCountryFilter(e.target.value)}
                    className="bg-zinc-950 border border-zinc-800 rounded-lg py-2 px-3 text-[10px] font-bold uppercase tracking-wider focus:outline-none focus:border-orange-500 transition-colors appearance-none cursor-pointer"
                  >
                    <option value="all">All Nations</option>
                    {countries.map(code => (
                      <option key={code} value={code}>{getCountryName(code)}</option>
                    ))}
                  </select>
                  
                  <select 
                    value={timeFilter}
                    onChange={(e) => setTimeFilter(e.target.value as any)}
                    className="bg-zinc-950 border border-zinc-800 rounded-lg py-2 px-3 text-[10px] font-bold uppercase tracking-wider focus:outline-none focus:border-orange-500 transition-colors appearance-none cursor-pointer col-span-2"
                  >
                    <option value="1h">Last 1h</option>
                    <option value="6h">Last 6h</option>
                    <option value="24h">Last 24h</option>
                    <option value="48h">Last 48h</option>
                    <option value="7d">Last 7 Days</option>
                    <option value="custom">Custom Range</option>
                    <option value="all">All Time</option>
                  </select>

                  {timeFilter === 'custom' && (
                    <div className="col-span-2 space-y-2 pt-1">
                      <div className="flex justify-between text-[9px] uppercase font-bold text-zinc-400">
                        <span>Range</span>
                        <span className="text-orange-500">{customDays} Days</span>
                      </div>
                      <input 
                        type="range" 
                        min="1" 
                        max="30" 
                        value={customDays}
                        onChange={(e) => setCustomDays(parseInt(e.target.value))}
                        className="w-full accent-orange-500 h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-zinc-800">
                  {!showFlushConfirm ? (
                    <button
                      onClick={() => setShowFlushConfirm(true)}
                      className="w-full py-2 bg-red-950/30 hover:bg-red-900/50 text-red-500 text-[10px] font-bold uppercase tracking-widest rounded-lg border border-red-900/50 transition-all"
                    >
                      Flush Database
                    </button>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={flushDatabase}
                        className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all shadow-lg shadow-red-900/40"
                      >
                        Confirm Flush
                      </button>
                      <button
                        onClick={() => setShowFlushConfirm(false)}
                        className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-[10px] font-bold uppercase tracking-widest rounded-lg border border-zinc-700 transition-all"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Map Layers */}
              <div className="space-y-3">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Map Layers</label>
                <div className="grid grid-cols-3 gap-2">
                  <button 
                    onClick={() => setShowMarkers(!showMarkers)}
                    className={`flex flex-col items-center justify-center gap-2 p-3 rounded-xl border transition-all ${showMarkers ? 'bg-orange-600/10 border-orange-500 text-orange-500' : 'bg-zinc-950 border-zinc-800 text-zinc-600 hover:border-zinc-700'}`}
                  >
                    <MapIcon size={16} />
                    <span className="text-[9px] font-bold uppercase">Markers</span>
                  </button>
                  <button 
                    onClick={() => setShowCountryHeatmap(!showCountryHeatmap)}
                    className={`flex flex-col items-center justify-center gap-2 p-3 rounded-xl border transition-all ${showCountryHeatmap ? 'bg-orange-600/10 border-orange-500 text-orange-500' : 'bg-zinc-950 border-zinc-800 text-zinc-600 hover:border-zinc-700'}`}
                  >
                    <Layers size={16} />
                    <span className="text-[9px] font-bold uppercase">Countries</span>
                  </button>
                  <button 
                    onClick={() => setShowPointHeatmap(!showPointHeatmap)}
                    className={`flex flex-col items-center justify-center gap-2 p-3 rounded-xl border transition-all ${showPointHeatmap ? 'bg-orange-600/10 border-orange-500 text-orange-500' : 'bg-zinc-950 border-zinc-800 text-zinc-600 hover:border-zinc-700'}`}
                  >
                    <Layers size={16} />
                    <span className="text-[9px] font-bold uppercase">Heatmap</span>
                  </button>
                </div>
              </div>

              {/* Heatmap Precision */}
              <div className="space-y-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Heatmap Precision</label>
                <div>
                  <div className="flex justify-between text-[9px] uppercase font-bold text-zinc-400 mb-2">
                    <span>Radius</span>
                    <span className="text-orange-500">{heatmapRadius}px</span>
                  </div>
                  <input 
                    type="range" 
                    min="5" 
                    max="50" 
                    value={heatmapRadius}
                    onChange={(e) => setHeatmapRadius(parseInt(e.target.value))}
                    className="w-full accent-orange-500 h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer"
                  />
                </div>
                
                <div>
                  <div className="flex justify-between text-[9px] uppercase font-bold text-zinc-400 mb-2">
                    <span>Blur</span>
                    <span className="text-orange-500">{heatmapBlur}px</span>
                  </div>
                  <input 
                    type="range" 
                    min="5" 
                    max="50" 
                    value={heatmapBlur}
                    onChange={(e) => setHeatmapBlur(parseInt(e.target.value))}
                    className="w-full accent-orange-500 h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer"
                  />
                </div>
              </div>

              {/* Automation */}
              <div className="pt-4 border-t border-zinc-800">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-200">Auto-Zoom</span>
                    <span className="text-[9px] text-zinc-500 uppercase">Focus on new news</span>
                  </div>
                  <button 
                    onClick={() => setAutoZoomOnNew(!autoZoomOnNew)}
                    className={`w-10 h-5 rounded-full transition-colors relative ${autoZoomOnNew ? 'bg-orange-600' : 'bg-zinc-800'}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${autoZoomOnNew ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <div className="flex-1 relative">
          <Map 
            news={filteredNews} 
            onMarkerClick={(item) => setSelectedNewsId(item.id)}
            selectedNewsId={selectedNewsId}
            showCountryHeatmap={showCountryHeatmap}
            showPointHeatmap={showPointHeatmap}
            showMarkers={showMarkers}
            heatmapRadius={heatmapRadius}
            heatmapBlur={heatmapBlur}
          />
          
          {/* Country Heatmap Legend */}
          {showCountryHeatmap && (
            <div className="absolute bottom-6 left-6 bg-zinc-900/90 backdrop-blur-md border border-zinc-800 rounded-lg p-3 z-[1500] shadow-xl hidden sm:block">
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">News Density</h4>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-[#facc15] opacity-85" />
                  <span className="text-[10px] text-zinc-300">1-2 Items</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-[#f97316] opacity-85" />
                  <span className="text-[10px] text-zinc-300">3-5 Items</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-[#ef4444] opacity-85" />
                  <span className="text-[10px] text-zinc-300">6-10 Items</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-[#a855f7] opacity-85" />
                  <span className="text-[10px] text-zinc-300">10+ Items</span>
                </div>
              </div>
            </div>
          )}
        </div>
        
        <div className="w-full md:w-96 shrink-0 h-[40%] md:h-full border-t md:border-t-0 md:border-l border-zinc-800">
          <NewsFeed 
            news={filteredNews} 
            onItemClick={(item) => setSelectedNewsId(item.id)}
            selectedNewsId={selectedNewsId}
          />
        </div>
      </main>

      {/* Footer / Status */}
      <footer className="h-8 border-t border-zinc-800 bg-zinc-950 flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-4 text-[10px] text-zinc-500 uppercase tracking-widest font-bold">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isProcessing ? 'bg-orange-500 animate-pulse' : 'bg-green-500'}`} />
            {isProcessing ? 'Processing News' : 'System Online'}
          </span>
          <span>Source: Google News RSS</span>
          <span>Updated: {new Date(lastUpdated).toLocaleTimeString()}</span>
        </div>
        <div className="text-[10px] text-zinc-600">
          Built with Gemini & OpenStreetMap
        </div>
      </footer>
    </div>
  );
}
