import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import MarkerClusterGroup from 'react-leaflet-cluster';

// Import MarkerCluster CSS
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

// Fix for leaflet.heat - it expects L to be globally available
(window as any).L = L;
import 'leaflet.heat';

import { NewsItem } from '../types';

// Fix for default marker icons in Leaflet with React
import icon from 'leaflet/dist/images/marker-icon.png';
import iconRetina from 'leaflet/dist/images/marker-icon-2x.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
    iconUrl: icon,
    iconRetinaUrl: iconRetina,
    shadowUrl: iconShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    tooltipAnchor: [16, -28],
    shadowSize: [41, 41]
});

// Set the default icon for all markers globally as a fallback
L.Marker.prototype.options.icon = DefaultIcon;

interface MapProps {
  news: NewsItem[];
  onMarkerClick: (item: NewsItem) => void;
  selectedNewsId?: string;
  showCountryHeatmap: boolean;
  showPointHeatmap: boolean;
  showMarkers: boolean;
  heatmapRadius: number;
  heatmapBlur: number;
}

// Component to handle map centering, zooming and heatmap
const MapController: React.FC<{ 
  selectedNews?: NewsItem; 
  news: NewsItem[]; 
  showPointHeatmap: boolean;
  heatmapRadius: number;
  heatmapBlur: number;
  geoData: any;
}> = ({ selectedNews, news, showPointHeatmap, heatmapRadius, heatmapBlur, geoData }) => {
  const map = useMap();
  const heatmapLayerRef = useRef<L.Layer | null>(null);
  
  useEffect(() => {
    if (selectedNews) {
      // Try to find the country feature to zoom to its bounds
      let zoomed = false;
      if (geoData && selectedNews.countryCode) {
        const feature = geoData.features.find((f: any) => f.id === selectedNews.countryCode);
        if (feature) {
          const bounds = L.geoJSON(feature).getBounds();
          if (bounds.isValid()) {
            map.fitBounds(bounds, { 
              padding: [50, 50],
              maxZoom: 6, // Don't zoom in too much for small countries
              animate: true 
            });
            zoomed = true;
          }
        }
      }

      // Fallback if country bounds not found or invalid
      if (!zoomed) {
        map.setView([selectedNews.lat, selectedNews.lng], 4, {
          animate: true
        });
      }
    }
  }, [selectedNews, map, geoData]);

  useEffect(() => {
    if (heatmapLayerRef.current) {
      map.removeLayer(heatmapLayerRef.current);
      heatmapLayerRef.current = null;
    }

    if (showPointHeatmap && news.length > 0) {
      const points: [number, number, number][] = news.map(item => [item.lat, item.lng, 1]);
      
      // Gradient: transparent -> yellow -> orange -> red -> purple
      const gradient = {
        0.4: '#facc15', // yellow-400
        0.6: '#f97316', // orange-500
        0.8: '#ef4444', // red-500
        1.0: '#a855f7'  // purple-500
      };

      // @ts-ignore
      heatmapLayerRef.current = (L as any).heatLayer(points, {
        radius: heatmapRadius,
        blur: heatmapBlur,
        maxZoom: 10,
        gradient: gradient,
        minOpacity: 0.5
      }).addTo(map);
    }

    return () => {
      if (heatmapLayerRef.current) {
        map.removeLayer(heatmapLayerRef.current);
      }
    };
  }, [news, showPointHeatmap, heatmapRadius, heatmapBlur, map]);

  return null;
};

const Map: React.FC<MapProps> = ({ news, onMarkerClick, selectedNewsId, showMarkers, showCountryHeatmap, showPointHeatmap, heatmapRadius, heatmapBlur }) => {
  const selectedNews = news.find(n => n.id === selectedNewsId);
  const [geoData, setGeoData] = useState<any>(null);

  useEffect(() => {
    console.log(`[MAP] Rendering with ${news.length} news items. showMarkers: ${showMarkers}`);
    if (news.length > 0) {
      const invalidCoords = news.filter(n => isNaN(n.lat) || isNaN(n.lng));
      if (invalidCoords.length > 0) {
        console.warn(`[MAP] Found ${invalidCoords.length} items with invalid coordinates:`, invalidCoords);
      }
    }
  }, [news, showMarkers]);

  // Fetch country GeoJSON
  useEffect(() => {
    fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
      .then(res => res.json())
      .then(data => setGeoData(data))
      .catch(err => console.error("Failed to load GeoJSON", err));
  }, []);

  // Calculate news counts per country
  const countryCounts = news.reduce((acc, item) => {
    if (item.countryCode) {
      acc[item.countryCode] = (acc[item.countryCode] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const getColor = (count: number) => {
    if (count === 0) return 'transparent';
    if (count <= 2) return '#facc15'; // yellow
    if (count <= 5) return '#f97316'; // orange
    if (count <= 10) return '#ef4444'; // red
    return '#a855f7'; // purple
  };

  const style = (feature: any) => {
    const count = countryCounts[feature.id] || 0;
    return {
      fillColor: getColor(count),
      weight: 1.5,
      opacity: 0.5,
      color: '#52525b', // zinc-600
      fillOpacity: count > 0 ? 0.85 : 0
    };
  };

  return (
    <div className="w-full h-full bg-zinc-900">
      <MapContainer 
        center={[20, 0]} 
        zoom={2} 
        scrollWheelZoom={true}
        className="w-full h-full"
        style={{ background: '#18181b' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        
        {showCountryHeatmap && geoData && (
          <GeoJSON 
            data={geoData} 
            style={style}
            onEachFeature={(feature, layer) => {
              const count = countryCounts[feature.id] || 0;
              if (count > 0) {
                layer.bindPopup(`<strong>${feature.properties.name}</strong>: ${count} news items`);
              }
            }}
          />
        )}

        {showMarkers && (
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={50}
            spiderfyOnMaxZoom={true}
            showCoverageOnHover={false}
          >
            {news.map((item) => (
              <Marker 
                key={item.id} 
                position={[item.lat, item.lng]}
                icon={DefaultIcon}
                eventHandlers={{
                  click: () => onMarkerClick(item),
                }}
              >
                <Popup>
                  <div className="p-1 max-w-[200px] text-zinc-900">
                    <h3 className="m-0 mb-1 text-sm font-bold leading-tight">{item.title}</h3>
                    {(item.locationName || item.countryName) && (
                      <p className="m-0 mb-1 text-[10px] font-bold text-orange-600 uppercase tracking-wider">
                        {item.locationName && item.locationName !== 'Global' ? (
                          (item.countryName && item.countryName !== 'Global' && !item.locationName.includes(item.countryName)) 
                            ? `${item.locationName}, ${item.countryName}` 
                            : item.locationName
                        ) : (
                          (item.countryName && item.countryName !== 'Global') ? item.countryName : 'Global'
                        )}
                      </p>
                    )}
                    <p className="m-0 mb-2 text-xs text-zinc-600">
                      {item.source} • {(() => {
                        try {
                          const date = new Date(item.pubDate);
                          return isNaN(date.getTime()) ? 'Recent' : date.toLocaleDateString();
                        } catch (e) {
                          return 'Recent';
                        }
                      })()}
                    </p>
                    <a 
                      href={item.link} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-orange-600 text-xs font-bold no-underline hover:underline"
                    >
                      Read Full Article →
                    </a>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MarkerClusterGroup>
        )}

        <MapController 
          selectedNews={selectedNews} 
          news={news} 
          showPointHeatmap={showPointHeatmap} 
          heatmapRadius={heatmapRadius}
          heatmapBlur={heatmapBlur}
          geoData={geoData}
        />
      </MapContainer>
    </div>
  );
};

export default Map;
