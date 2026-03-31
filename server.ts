import express from "express";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import { parseStringPromise } from "xml2js";
import fs from "fs/promises";
import Database from "better-sqlite3";

const PORT = 3000;
const DB_FILE = path.join(process.cwd(), "news.db");
const CACHE_FILE = path.join(process.cwd(), "news_cache.json");
const LOG_LEVEL: string = 'debug';

const logger = {
  debug: (msg: string, ...args: any[]) => { if (LOG_LEVEL === 'debug') console.log(`[DEBUG] ${msg}`, ...args); },
  info: (msg: string, ...args: any[]) => { if (LOG_LEVEL === 'debug' || LOG_LEVEL === 'info') console.log(`[INFO] ${msg}`, ...args); },
  warn: (msg: string, ...args: any[]) => { if (LOG_LEVEL !== 'error') console.warn(`[WARN] ${msg}`, ...args); },
  error: (msg: string, ...args: any[]) => { console.error(`[ERROR] ${msg}`, ...args); },
};

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const httpServer = createServer(app);

  // Initialize SQLite Database
  const db = new Database(DB_FILE);
  
  // Create table
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      title TEXT,
      link TEXT,
      pubDate TEXT,
      source TEXT,
      lat REAL,
      lng REAL,
      timestamp INTEGER,
      locationName TEXT,
      countryCode TEXT,
      countryName TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON news(timestamp);
  `);

  // Migration: Add columns if they don't exist
  const columns = [
    { name: "countryCode", type: "TEXT" },
    { name: "countryName", type: "TEXT" },
    { name: "locationName", type: "TEXT" }
  ];

  for (const col of columns) {
    try {
      db.exec(`ALTER TABLE news ADD COLUMN ${col.name} ${col.type};`);
    } catch (e) {
      // Column might already exist
    }
  }

  // Migration from news_cache.json if it exists
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    const news = JSON.parse(data);
    logger.info(`Migrating ${news.length} items from JSON cache to SQLite...`);
    
    const insert = db.prepare(`
      INSERT OR IGNORE INTO news (id, title, link, pubDate, source, lat, lng, timestamp, locationName, countryCode, countryName)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const transaction = db.transaction((items) => {
      for (const item of items) {
        insert.run(
          item.id,
          item.title,
          item.link,
          item.pubDate,
          item.source,
          item.lat,
          item.lng,
          item.timestamp,
          item.locationName || null,
          item.countryCode || null,
          item.countryName || null
        );
      }
    });
    
    transaction(news);
    await fs.unlink(CACHE_FILE);
    logger.info("Migration complete. JSON cache deleted.");
  } catch (error) {
    // If file doesn't exist, ignore
  }

  app.get("/api/news", (req, res) => {
    try {
      // Fetch all news, limit to 5000 for performance
      const news = db.prepare("SELECT * FROM news ORDER BY timestamp DESC LIMIT 5000").all();
      res.json(news);
    } catch (error) {
      logger.error("Error reading database:", error);
      res.status(500).json({ error: "Failed to read news database" });
    }
  });

  app.post("/api/news", (req, res) => {
    try {
      const newItems = req.body;
      if (!Array.isArray(newItems)) return res.status(400).json({ error: "Invalid data" });

      const insert = db.prepare(`
        INSERT OR IGNORE INTO news (id, title, link, pubDate, source, lat, lng, timestamp, locationName, countryCode, countryName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const transaction = db.transaction((items) => {
        let addedCount = 0;
        for (const item of items) {
          const result = insert.run(
            item.id,
            item.title,
            item.link,
            item.pubDate,
            item.source,
            item.lat,
            item.lng,
            item.timestamp,
            item.locationName || null,
            item.countryCode || null,
            item.countryName || null
          );
          if (result.changes > 0) addedCount++;
        }
        return addedCount;
      });

      const added = transaction(newItems);
      res.json({ success: true, added });
    } catch (error) {
      logger.error("Error updating database:", error);
      res.status(500).json({ error: "Failed to update news database" });
    }
  });

  app.post("/api/news/flush", (req, res) => {
    try {
      db.prepare("DELETE FROM news").run();
      logger.info("Database flushed.");
      res.json({ success: true });
    } catch (error) {
      logger.error("Error flushing database:", error);
      res.status(500).json({ error: "Failed to flush news database" });
    }
  });

  app.get("/api/news-rss", async (req, res) => {
    const sources = [
      { name: "Google News", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" },
      { name: "BBC News", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
      { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
      { name: "NY Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
      { name: "CNN", url: "http://rss.cnn.com/rss/edition_world.rss" }
    ];

    try {
      const allItems: any[] = [];
      
      const fetchPromises = sources.map(async (source) => {
        try {
          const response = await axios.get(source.url, { timeout: 5000 });
          const result = await parseStringPromise(response.data);
          const channel = result?.rss?.channel?.[0];
          if (!channel || !channel.item) {
            logger.warn(`No items found for ${source.name}`);
            return [];
          }

          const items = channel.item.map((item: any) => {
            // Extract potential location info from various RSS extensions
            const georss = item['georss:point']?.[0];
            const geoLat = item['geo:lat']?.[0];
            const geoLong = item['geo:long']?.[0];
            const rssLocation = item['location']?.[0];
            
            return {
              id: item.guid?.[0]?._ || item.guid?.[0] || item.link?.[0],
              title: item.title?.[0] || "No Title",
              description: item.description?.[0] || "",
              link: item.link?.[0] || "#",
              pubDate: item.pubDate?.[0] || new Date().toUTCString(),
              source: source.name,
              categories: item.category ? item.category.map((c: any) => typeof c === 'string' ? c : c._ || c.term).filter(Boolean) : [],
              rssLocation: rssLocation || null,
              geoPoint: georss ? { lat: parseFloat(georss.split(' ')[0]), lng: parseFloat(georss.split(' ')[1]) } : 
                        (geoLat && geoLong ? { lat: parseFloat(geoLat), lng: parseFloat(geoLong) } : null)
            };
          }).filter((item: any) => item.title !== "No Title");
          return items;
        } catch (err: any) {
          logger.error(`Failed to fetch from ${source.name}:`, err.message);
          return [];
        }
      });

      const results = await Promise.all(fetchPromises);
      results.forEach(items => allItems.push(...items));
      
      // Sort by date and remove duplicates
      const uniqueItems = allItems
        .filter(item => !isNaN(new Date(item.pubDate).getTime()))
        .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
        .filter((item, index, self) => 
          index === self.findIndex((t) => t.id === item.id || t.title === item.title)
        );

      res.json(uniqueItems);
    } catch (error) {
      logger.error("Error fetching RSS feeds:", error);
      res.status(500).json({ error: "Failed to fetch news RSS" });
    }
  });

  app.get("/api/geocode", async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Missing query" });

    try {
      const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
        params: {
          q,
          format: "json",
          limit: 1
        },
        headers: {
          "User-Agent": "GeoNewsApp/1.0 (Pagl400@gmail.com)"
        }
      });

      if (geoResponse.data && geoResponse.data.length > 0) {
        const geo = geoResponse.data[0];
        res.json({
          lat: parseFloat(geo.lat),
          lng: parseFloat(geo.lon),
          displayName: geo.display_name
        });
      } else {
        res.status(404).json({ error: "Location not found" });
      }
    } catch (error: any) {
      if (error.response) {
        logger.error(`Geocoding error for "${q}": ${error.response.status} ${error.response.statusText}`);
        res.status(error.response.status).json({ error: "Geocoding failed" });
      } else {
        logger.error(`Geocoding error for "${q}":`, error.message);
        res.status(500).json({ error: "Geocoding failed" });
      }
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
