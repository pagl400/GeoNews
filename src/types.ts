export interface NewsItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  source: string;
  description?: string;
  locationName: string;
  countryCode?: string;
  countryName?: string;
  lat: number;
  lng: number;
  timestamp: number;
}
