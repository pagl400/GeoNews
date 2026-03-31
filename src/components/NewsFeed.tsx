import React from 'react';
import { NewsItem } from '../types';
import { formatDistanceToNow } from 'date-fns';
import { ExternalLink, MapPin } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface NewsFeedProps {
  news: NewsItem[];
  onItemClick: (item: NewsItem) => void;
  selectedNewsId?: string;
}

const NewsFeed: React.FC<NewsFeedProps> = ({ news, onItemClick, selectedNewsId }) => {
  return (
    <div className="flex flex-col h-full bg-zinc-950">
      <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
        <h2 className="text-zinc-100 font-semibold flex items-center gap-2">
          <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          Live News Feed
        </h2>
        <span className="text-zinc-500 text-xs">{news.length} items</span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <AnimatePresence initial={false}>
          {news.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={() => onItemClick(item)}
              className={`p-3 md:p-4 border-b border-zinc-900 cursor-pointer transition-colors hover:bg-zinc-900 ${
                selectedNewsId === item.id ? 'bg-zinc-900 border-l-4 border-l-orange-500' : ''
              }`}
            >
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1">
                  <h3 className="text-zinc-200 text-sm font-medium leading-tight mb-2">
                    {item.locationName && item.locationName !== 'Global' && (
                      <span className="text-orange-500 font-bold mr-1.5 uppercase text-[11px]">
                        [{item.locationName}]
                      </span>
                    )}
                    {item.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                    <span className="text-orange-500">{item.source}</span>
                    <span className="flex items-center gap-1">
                      <MapPin size={10} />
                      {item.locationName && item.locationName !== 'Global' ? (
                        (item.countryName && item.countryName !== 'Global' && !item.locationName.includes(item.countryName)) 
                          ? `${item.locationName}, ${item.countryName}` 
                          : item.locationName
                      ) : (
                        (item.countryName && item.countryName !== 'Global') ? item.countryName : 'Global'
                      )}
                    </span>
                    <span>{formatDistanceToNow(new Date(item.pubDate), { addSuffix: true })}</span>
                  </div>
                </div>
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-zinc-600 hover:text-zinc-400"
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {news.length === 0 && (
          <div className="p-8 text-center text-zinc-600 text-sm italic">
            Waiting for news updates...
          </div>
        )}
      </div>
    </div>
  );
};

export default NewsFeed;
