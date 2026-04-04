/**
 * Elon Tweet Monitor
 *
 * Polls @elonmusk tweets via multiple sources for reliability:
 * 1. Nitter RSS (free, rotating instances)
 * 2. Twitter embed endpoint (no auth needed)
 * 3. DexScreener social feed fallback
 *
 * Extracts unique/meme-worthy keywords and emits events.
 */

import axios from 'axios';
import { logger } from '../utils/logger';
import { CONFIG } from '../config';
import { extractMemeKeywords } from './keyword.extractor';

export interface Tweet {
  id: string;
  text: string;
  timestamp: number;
  keywords: string[];
}

type TweetCallback = (tweet: Tweet) => void;

export class TweetMonitor {
  private seenTweetIds: Set<string> = new Set();
  private callbacks: TweetCallback[] = [];
  private running = false;
  private pollInterval: number;
  private nitterIndex = 0;
  private lastTweetTime = 0;

  constructor() {
    this.pollInterval = CONFIG.TWEET_POLL_INTERVAL_MS;
  }

  onNewTweet(callback: TweetCallback): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info('🐦 Tweet monitor started');
    logger.info(`   Polling every ${this.pollInterval / 1000}s`);
    logger.info(`   Nitter instances: ${CONFIG.NITTER_INSTANCES.length}`);

    while (this.running) {
      try {
        await this.poll();
      } catch (error) {
        logger.debug(`Poll cycle error: ${error}`);
      }
      await this.sleep(this.pollInterval);
    }
  }

  stop(): void {
    this.running = false;
    logger.info('Tweet monitor stopped');
  }

  private async poll(): Promise<void> {
    // Try multiple sources in order of reliability
    let tweets: Tweet[] = [];

    tweets = await this.fetchFromNitter();
    if (tweets.length === 0) {
      tweets = await this.fetchFromTwitterEmbed();
    }

    // Process new tweets
    for (const tweet of tweets) {
      if (this.seenTweetIds.has(tweet.id)) continue;

      this.seenTweetIds.add(tweet.id);

      // Skip old tweets on first load
      if (this.lastTweetTime === 0) {
        this.lastTweetTime = tweet.timestamp;
        continue;
      }

      // Only process tweets newer than what we've seen
      if (tweet.timestamp <= this.lastTweetTime) continue;
      this.lastTweetTime = Math.max(this.lastTweetTime, tweet.timestamp);

      // Extract keywords
      tweet.keywords = extractMemeKeywords(tweet.text);

      if (tweet.keywords.length > 0) {
        logger.info(`🔥 NEW ELON TWEET with meme keywords!`);
        logger.info(`   Text: ${tweet.text.slice(0, 120)}...`);
        logger.info(`   Keywords: ${tweet.keywords.join(', ')}`);

        for (const cb of this.callbacks) {
          try {
            cb(tweet);
          } catch (e) {
            logger.error(`Callback error: ${e}`);
          }
        }
      } else {
        logger.debug(`Tweet (no meme keywords): ${tweet.text.slice(0, 80)}...`);
      }
    }

    // Cap seen IDs to prevent memory leak
    if (this.seenTweetIds.size > 1000) {
      const arr = Array.from(this.seenTweetIds);
      this.seenTweetIds = new Set(arr.slice(-500));
    }
  }

  /**
   * Fetch tweets from Nitter RSS feed (rotating instances)
   */
  private async fetchFromNitter(): Promise<Tweet[]> {
    const instances = CONFIG.NITTER_INSTANCES;
    if (instances.length === 0) return [];

    // Rotate through instances
    const instance = instances[this.nitterIndex % instances.length];
    this.nitterIndex++;

    try {
      const url = `${instance}/elonmusk/rss`;
      const resp = await axios.get(url, {
        timeout: 10_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        },
      });

      const xml = resp.data as string;
      return this.parseRss(xml);
    } catch (error) {
      logger.debug(`Nitter ${instance} failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Fallback: fetch from Twitter syndication/embed endpoint (no auth)
   */
  private async fetchFromTwitterEmbed(): Promise<Tweet[]> {
    try {
      // Twitter syndication timeline endpoint (public, no auth)
      const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/elonmusk`;
      const resp = await axios.get(url, {
        timeout: 10_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
      });

      const html = resp.data as string;
      return this.parseEmbedHtml(html);
    } catch (error) {
      logger.debug(`Twitter embed fallback failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Parse Nitter RSS XML into tweets
   */
  private parseRss(xml: string): Tweet[] {
    const tweets: Tweet[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];

      const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);

      if (!titleMatch) continue;

      const text = this.stripHtml(descMatch?.[1] || titleMatch[1]);
      const link = linkMatch?.[1] || '';
      const idMatch = link.match(/status\/(\d+)/);
      const id = idMatch?.[1] || `nitter_${Date.now()}_${Math.random()}`;
      const timestamp = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();

      // Skip retweets
      if (text.startsWith('RT @') || text.startsWith('R to @')) continue;

      tweets.push({ id, text, timestamp, keywords: [] });
    }

    return tweets;
  }

  /**
   * Parse Twitter syndication embed HTML
   */
  private parseEmbedHtml(html: string): Tweet[] {
    const tweets: Tweet[] = [];

    // Extract tweet text from timeline-Tweet-text spans
    const tweetRegex = /data-tweet-id="(\d+)"[\s\S]*?<p[^>]*class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    let match;

    while ((match = tweetRegex.exec(html)) !== null) {
      const id = match[1];
      const text = this.stripHtml(match[2]);

      tweets.push({
        id,
        text,
        timestamp: Date.now(), // Embed doesn't always have timestamps
        keywords: [],
      });
    }

    // Fallback: try simpler pattern
    if (tweets.length === 0) {
      const simpleRegex = /"tweet_id":"(\d+)"[\s\S]*?"text":"([\s\S]*?)"/g;
      while ((match = simpleRegex.exec(html)) !== null) {
        tweets.push({
          id: match[1],
          text: match[2].replace(/\\n/g, ' ').replace(/\\"/g, '"'),
          timestamp: Date.now(),
          keywords: [],
        });
      }
    }

    return tweets;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
