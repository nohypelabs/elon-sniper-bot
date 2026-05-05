/**
 * Multi-Account Tweet Monitor
 *
 * Polls multiple CT whale accounts via Nitter RSS (rotating instances).
 * Elon is polled every cycle; other accounts rotate one-per-cycle.
 * Each tweet is deduplicated and filtered for meme keywords before emitting.
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
  author: string;
  authorLabel: string;
}

// Tier 1 — polled every cycle (highest impact accounts)
const TIER1_ACCOUNTS = [
  { username: 'elonmusk',       label: 'Elon Musk' },
  { username: 'realDonaldTrump', label: 'Donald Trump' },
  { username: 'sama',           label: 'Sam Altman' },
];

// Tier 2 — round-robin, one per cycle (CT whales)
const TIER2_ACCOUNTS = [
  { username: 'blknoiz06',      label: 'ansem' },
  { username: 'MustStopMurad',  label: 'Murad' },
  { username: 'cobie',          label: 'cobie' },
  { username: 'nikitabier',     label: 'Nikita Bier' },
  { username: 'cz_binance',     label: 'CZ' },
  { username: 'DegenSpartan',   label: 'DegenSpartan' },
  { username: 'gainzy222',      label: 'gainzy' },
];

type TweetCallback = (tweet: Tweet) => void;

export class TweetMonitor {
  private seenTweetIds: Set<string> = new Set();
  private callbacks: TweetCallback[] = [];
  private running = false;
  private nitterIndex = 0;
  private tier2Index = 0;
  private lastTweetTime: Map<string, number> = new Map();

  onNewTweet(callback: TweetCallback): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    this.running = true;
    const allAccounts = [...TIER1_ACCOUNTS, ...TIER2_ACCOUNTS];
    logger.info('🐦 Tweet monitor started');
    logger.info(`   Tier 1 (every cycle): ${TIER1_ACCOUNTS.map(a => a.label).join(', ')}`);
    logger.info(`   Tier 2 (round-robin): ${TIER2_ACCOUNTS.map(a => a.label).join(', ')}`);
    logger.info(`   Polling every ${CONFIG.TWEET_POLL_INTERVAL_MS / 1000}s | Nitter instances: ${CONFIG.NITTER_INSTANCES.length}`);

    // Pre-warm seen IDs to avoid firing on startup
    for (const account of allAccounts) {
      await this.pollAccount(account.username, account.label, true);
    }

    while (this.running) {
      try {
        // Tier 1: poll every cycle
        for (const account of TIER1_ACCOUNTS) {
          await this.pollAccount(account.username, account.label, false);
        }

        // Tier 2: one account per cycle (round-robin)
        const t2 = TIER2_ACCOUNTS[this.tier2Index % TIER2_ACCOUNTS.length];
        this.tier2Index++;
        await this.pollAccount(t2.username, t2.label, false);

      } catch (error) {
        logger.debug(`Poll cycle error: ${error}`);
      }
      await this.sleep(CONFIG.TWEET_POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    this.running = false;
    logger.info('Tweet monitor stopped');
  }

  private async pollAccount(username: string, label: string, warmup: boolean): Promise<void> {
    const tweets = await this.fetchFromNitter(username);

    for (const tweet of tweets) {
      if (this.seenTweetIds.has(tweet.id)) continue;
      this.seenTweetIds.add(tweet.id);

      const lastSeen = this.lastTweetTime.get(username) ?? 0;

      // On warmup or first poll: just record timestamps, don't fire
      if (warmup || lastSeen === 0) {
        this.lastTweetTime.set(username, Math.max(lastSeen, tweet.timestamp));
        continue;
      }

      if (tweet.timestamp <= lastSeen) continue;
      this.lastTweetTime.set(username, Math.max(lastSeen, tweet.timestamp));

      tweet.keywords = extractMemeKeywords(tweet.text);

      if (tweet.keywords.length > 0) {
        logger.info(`🔥 NEW TWEET from ${label} (@${username}) with meme keywords!`);
        logger.info(`   Text: ${tweet.text.slice(0, 120)}`);
        logger.info(`   Keywords: ${tweet.keywords.join(', ')}`);

        for (const cb of this.callbacks) {
          try { cb(tweet); } catch (e) { logger.error(`Callback error: ${e}`); }
        }
      } else {
        logger.debug(`[${label}] Tweet (no keywords): ${tweet.text.slice(0, 80)}`);
      }
    }

    // Cap seen IDs to prevent memory leak
    if (this.seenTweetIds.size > 2000) {
      const arr = Array.from(this.seenTweetIds);
      this.seenTweetIds = new Set(arr.slice(-1000));
    }
  }

  private async fetchFromNitter(username: string): Promise<Tweet[]> {
    const instances = CONFIG.NITTER_INSTANCES;
    if (instances.length === 0) return [];

    const instance = instances[this.nitterIndex % instances.length];
    this.nitterIndex++;

    try {
      const resp = await axios.get(`${instance}/${username}/rss`, {
        timeout: 8_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      });
      return this.parseRss(resp.data as string, username);
    } catch {
      // Try next instance silently
      const next = instances[(this.nitterIndex) % instances.length];
      try {
        const resp = await axios.get(`${next}/${username}/rss`, {
          timeout: 8_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
        });
        return this.parseRss(resp.data as string, username);
      } catch {
        return [];
      }
    }
  }

  private parseRss(xml: string, username: string): Tweet[] {
    const tweets: Tweet[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
      const linkMatch  = item.match(/<link>(.*?)<\/link>/);
      const dateMatch  = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const descMatch  = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);

      if (!titleMatch) continue;

      const text = this.stripHtml(descMatch?.[1] || titleMatch[1]);
      const link = linkMatch?.[1] || '';
      const idMatch = link.match(/status\/(\d+)/);
      const id = idMatch?.[1] || `nitter_${username}_${Date.now()}_${Math.random()}`;
      const timestamp = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();

      if (text.startsWith('RT @') || text.startsWith('R to @')) continue;

      tweets.push({ id, text, timestamp, keywords: [], author: username, authorLabel: username });
    }

    return tweets;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
