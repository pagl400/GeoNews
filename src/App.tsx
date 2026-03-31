import { useEffect, useState, useRef } from 'react';
import Map from './components/Map';
import NewsFeed from './components/NewsFeed';
import { NewsItem } from './types';
import { Layers, Map as MapIcon, Filter, Loader2 } from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";

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
  const processedIds = useRef<Set<string>>(new Set());
  const processedTitles = useRef<Set<string>>(new Set());

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const processNewsItem = async (rawItem: any) => {
    const normalizedTitle = rawItem.title.trim().toLowerCase();
    if (processedIds.current.has(rawItem.id) || processedTitles.current.has(normalizedTitle)) return null;
    
    const maxRetries = 3;
    let retryCount = 0;
    let locationResult = null;

    while (retryCount <= maxRetries) {
      try {
        // 1. Extract location with Gemini
        locationResult = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: `Extract the most specific geographic location (City, State/Region, Country) mentioned in this news headline and description: 
          Title: "${rawItem.title}"
          Description: "${rawItem.description || ''}"
          
          If a specific city or region is mentioned, return it in the "location" field. 
          If ONLY a country is mentioned, return the country name in the "location" field AND the "countryName" field.
          If no location or country is mentioned at all, return "Global" for both.
          
          NEVER return "Global" if a country is mentioned.
          
          Also provide the ISO 3166-1 alpha-3 country code AND the full English country name.
          Return as JSON.`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                location: { type: Type.STRING },
                countryCode: { type: Type.STRING, description: "ISO 3166-1 alpha-3 code" },
                countryName: { type: Type.STRING, description: "Full country name" }
              },
              required: ["location", "countryCode", "countryName"]
            }
          }
        });
        // If successful, break the retry loop
        break;
      } catch (error: any) {
        const is503 = error?.message?.includes("503") || error?.status === 503 || error?.error?.code === 503;
        
        if (is503 && retryCount < maxRetries) {
          retryCount++;
          const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          console.warn(`Gemini API busy (503). Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        console.error("Error processing news item with Gemini:", error);
        return null; // Give up after retries or if it's not a 503
      }
    }

    if (!locationResult) return null;

    try {
      let locationName = "Global";
      let countryCode = "";
      let countryName = "";
      try {
        const parsed = JSON.parse(locationResult.text);
        locationName = parsed.location || "Global";
        countryCode = parsed.countryCode || "";
        countryName = parsed.countryName || "";
      } catch (e) {
        console.error("Failed to parse Gemini response", e);
      }

      // If location is Global but we have a country, use the country for geocoding
      const geocodeQuery = (locationName === "Global" && countryName && countryName !== "Global") 
        ? countryName 
        : locationName;

      if (!geocodeQuery || geocodeQuery === "Global") {
        processedIds.current.add(rawItem.id);
        return null;
      }

      // 2. Geocode with backend
      const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(geocodeQuery)}`);
      
      if (geoRes.status === 404) {
        console.log(`Location not found for "${geocodeQuery}", marking as processed.`);
        processedIds.current.add(rawItem.id);
        return null;
      }

      if (!geoRes.ok) {
        console.warn(`Geocoding temporary failure for "${geocodeQuery}" (Status: ${geoRes.status}). Will retry later.`);
        return null;
      }

      const geo = await geoRes.json();
      
      // Use the geocoder's display name if it's more descriptive, but keep it concise
      let descriptiveLocation = (locationName && locationName !== "Global") ? locationName : (countryName && countryName !== "Global" ? countryName : (geo.displayName || "Global"));
      
      if (geo.displayName && locationName && locationName !== "Global") {
        const parts = geo.displayName.split(',').map((p: string) => p.trim());
        // If the geocoder returned more info than just the country, use it
        if (parts.length > 1) {
          // Take up to 3 parts (e.g., City, State, Country)
          descriptiveLocation = parts.slice(0, 3).join(', ');
        }
      }

      const enrichedItem: NewsItem = {
        ...rawItem,
        locationName: descriptiveLocation,
        countryCode,
        countryName,
        lat: geo.lat,
        lng: geo.lng,
        timestamp: new Date(rawItem.pubDate).getTime()
      };

      processedIds.current.add(rawItem.id);
      processedTitles.current.add(normalizedTitle);
      return enrichedItem;
    } catch (error) {
      console.error("Error processing news item:", error);
      return null;
    }
  };

  const autoZoomRef = useRef(autoZoomOnNew);
  useEffect(() => {
    autoZoomRef.current = autoZoomOnNew;
  }, [autoZoomOnNew]);

  const isProcessingRef = useRef(false);

  const fetchAndProcessNews = async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setIsProcessing(true);
    
    try {
      // 1. Fetch fresh RSS
      const res = await fetch('/api/news-rss');
      const rawItems = await res.json();
      
      const newItems: NewsItem[] = [];
      // Filter for items not in cache (by ID or Title)
      const unprocessed = rawItems.filter((item: any) => {
        const normalizedTitle = item.title.trim().toLowerCase();
        return !processedIds.current.has(item.id) && !processedTitles.current.has(normalizedTitle);
      }).slice(0, 50);
      
      for (const item of unprocessed) {
        const enriched = await processNewsItem(item);
        if (enriched) newItems.push(enriched);
        // Small delay to avoid hitting rate limits too hard (Nominatim 1 req/sec)
        await new Promise(resolve => setTimeout(resolve, 1100));
      }

      if (newItems.length > 0) {
        // 2. Save new items to backend cache
        await fetch('/api/news', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newItems)
        });

        setNews(prev => {
          const combined = [...newItems, ...prev];
          const unique = combined.filter((item, index, self) => 
            index === self.findIndex((t) => t.id === item.id || t.title.trim().toLowerCase() === item.title.trim().toLowerCase())
          );
          
          // Increase limit to 5000 to keep more history
          return unique.slice(0, 5000);
        });

        if (autoZoomRef.current && newItems.length > 0) {
          setSelectedNewsId(newItems[0].id);
        }
        setLastUpdated(Date.now());
      }
    } catch (error) {
      console.error("Failed to fetch/process news:", error);
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
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
        }
      } catch (e) {
        console.error("Initial fetch failed", e);
      }
      // After initial cache fetch, do a fresh RSS check
      fetchAndProcessNews();
    };
    initFetch();

    const interval = setInterval(fetchAndProcessNews, 60000);
    return () => clearInterval(interval);
  }, []);

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

  const filteredNews = news.filter(item => {
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
  });

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
              Live Processing
            </div>
          )}
          
          <div className="h-8 w-[1px] bg-zinc-800 mx-2" />

          <button 
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold uppercase tracking-wider transition-all border ${showSettings ? 'bg-orange-600 border-orange-500 text-white shadow-lg shadow-orange-900/40' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'}`}
          >
            <Filter size={14} />
            {showSettings ? 'Close Controls' : 'Control Center'}
          </button>
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
