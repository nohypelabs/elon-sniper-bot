/**
 * Keyword Extractor
 *
 * Extracts meme-worthy / unique keywords from Elon's tweets that are
 * likely to become token names on Solana.
 *
 * Strategy:
 * 1. Filter out common English stop words
 * 2. Detect unusual/unique words, made-up words, slang
 * 3. Detect ALL CAPS words (emphasis = meme potential)
 * 4. Detect hashtags and @mentions that could be token names
 * 5. Detect emojis mapped to common crypto terms (🚀 = rocket, 🐕 = doge)
 * 6. Generate variations (singular/plural, with/without spaces)
 */

// Common words that would NOT become tokens
const STOP_WORDS = new Set([
  // Articles & prepositions
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'under', 'over',
  // Pronouns
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'it', 'its', 'they', 'them', 'their', 'this', 'that',
  'these', 'those', 'who', 'what', 'which', 'where', 'when', 'how', 'why',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'shall', 'must', 'need', 'get', 'got', 'go', 'going', 'went',
  'come', 'came', 'make', 'made', 'take', 'took', 'give', 'gave', 'know',
  'think', 'say', 'said', 'see', 'look', 'want', 'use', 'find', 'tell',
  'let', 'keep', 'put', 'seem', 'leave', 'call', 'try', 'ask', 'work',
  'run', 'move', 'live', 'believe', 'happen', 'bring', 'begin', 'show',
  'hear', 'play', 'feel', 'provide', 'hold', 'stand', 'turn', 'follow',
  'set', 'just', 'really', 'very', 'much', 'many', 'about',
  // Conjunctions
  'and', 'but', 'or', 'so', 'if', 'then', 'than', 'because', 'while',
  'although', 'though', 'unless', 'until', 'whether', 'nor', 'yet',
  // Common adjectives
  'good', 'great', 'new', 'old', 'big', 'small', 'long', 'high', 'low',
  'right', 'wrong', 'true', 'real', 'best', 'last', 'first', 'next',
  'same', 'different', 'other', 'most', 'some', 'all', 'any', 'each',
  'every', 'no', 'not', 'only', 'own', 'more', 'less', 'also', 'back',
  'even', 'still', 'well', 'too', 'here', 'there', 'now', 'today',
  // Common nouns (too generic)
  'people', 'time', 'year', 'day', 'way', 'thing', 'man', 'woman',
  'child', 'world', 'life', 'hand', 'part', 'place', 'case', 'week',
  'company', 'system', 'program', 'question', 'number', 'night', 'point',
  'home', 'water', 'room', 'mother', 'area', 'money', 'story', 'fact',
  'month', 'lot', 'country', 'right', 'study', 'book', 'eye', 'job',
  'word', 'business', 'issue', 'side', 'kind', 'head', 'house', 'far',
  'service', 'friend', 'father', 'power', 'hour', 'game', 'line', 'end',
  'member', 'law', 'car', 'city', 'community', 'name',
  // Tech/Elon common words (too frequent from him)
  'tesla', 'spacex', 'twitter', 'tweet', 'like', 'post', 'video',
  'http', 'https', 'www', 'com', 'pic', 'amp',
]);

// Emoji → potential token name mappings
const EMOJI_MAP: Record<string, string[]> = {
  '🚀': ['rocket', 'rocketship'],
  '🐕': ['doge', 'dog', 'shiba'],
  '🐶': ['doge', 'dog', 'puppy'],
  '🌙': ['moon', 'lunar'],
  '💎': ['diamond', 'gem'],
  '🔥': ['fire', 'burn'],
  '⚡': ['lightning', 'bolt', 'thunder'],
  '🤖': ['robot', 'bot', 'ai'],
  '👽': ['alien', 'ufo'],
  '🦍': ['ape', 'gorilla'],
  '🐸': ['pepe', 'frog'],
  '🎮': ['game', 'gamer'],
  '💀': ['skull', 'dead'],
  '🌈': ['rainbow'],
  '🦁': ['lion'],
  '🐱': ['cat', 'kitty'],
  '🐻': ['bear'],
  '🐂': ['bull'],
  '🦅': ['eagle'],
  '🐍': ['snake'],
  '🐳': ['whale'],
  '🍌': ['banana'],
  '🍕': ['pizza'],
  '🌮': ['taco'],
  '🧠': ['brain'],
  '👑': ['king', 'crown'],
  '🗡️': ['sword'],
  '🛸': ['ufo'],
  '🌍': ['earth', 'world'],
  '☀️': ['sun', 'solar'],
  '🌊': ['wave', 'tsunami'],
  '🎪': ['circus', 'clown'],
  '🤡': ['clown'],
};

// Known meme-adjacent words that often become tokens
const MEME_BOOSTERS = new Set([
  'inu', 'coin', 'token', 'moon', 'rocket', 'doge', 'pepe', 'chad',
  'based', 'wojak', 'meme', 'pump', 'ape', 'frog', 'cat', 'dog',
  'elon', 'musk', 'grok', 'mars', 'kek', 'wagmi', 'ngmi', 'ser',
  'anon', 'fren', 'gm', 'wen', 'lambo',
]);

/**
 * Extract meme-worthy keywords from tweet text.
 * Returns array of potential token search terms, ordered by meme potential.
 */
export function extractMemeKeywords(text: string): string[] {
  const keywords: Map<string, number> = new Map(); // keyword -> score

  // 1. Extract ALL CAPS words (high meme potential)
  const capsWords = text.match(/\b[A-Z]{2,}\b/g) || [];
  for (const word of capsWords) {
    const lower = word.toLowerCase();
    if (!STOP_WORDS.has(lower) && word.length >= 2 && word.length <= 20) {
      addKeyword(keywords, lower, 10);
      addKeyword(keywords, word, 10); // Keep original casing too
    }
  }

  // 2. Extract hashtags
  const hashtags = text.match(/#(\w+)/g) || [];
  for (const tag of hashtags) {
    const clean = tag.replace('#', '').toLowerCase();
    if (!STOP_WORDS.has(clean) && clean.length >= 2) {
      addKeyword(keywords, clean, 8);
    }
  }

  // 3. Extract quoted words or phrases (often meme-worthy)
  const quoted = text.match(/[""]([^""]+)[""]|"([^"]+)"/g) || [];
  for (const q of quoted) {
    const clean = q.replace(/["""]/g, '').trim().toLowerCase();
    if (clean.length >= 2 && clean.length <= 30 && !STOP_WORDS.has(clean)) {
      addKeyword(keywords, clean, 9);
      // Also add without spaces as potential ticker
      const noSpace = clean.replace(/\s+/g, '');
      if (noSpace !== clean) {
        addKeyword(keywords, noSpace, 7);
      }
    }
  }

  // 4. Extract emoji-based keywords
  for (const [emoji, names] of Object.entries(EMOJI_MAP)) {
    if (text.includes(emoji)) {
      for (const name of names) {
        addKeyword(keywords, name, 6);
      }
    }
  }

  // 5. Extract unusual/unique words (not in stop words, not too common)
  const words = text
    .replace(/https?:\/\/\S+/g, '') // Remove URLs
    .replace(/[^\w\s'-]/g, ' ')     // Keep only word chars
    .split(/\s+/)
    .filter(w => w.length >= 3 && w.length <= 20);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;

    // Boost meme-adjacent words
    if (MEME_BOOSTERS.has(lower)) {
      addKeyword(keywords, lower, 8);
      continue;
    }

    // Unusual words (mixed case in middle, numbers mixed in, etc.)
    const hasUnusualPattern = /[A-Z].*[a-z].*[A-Z]/.test(word) || /\d/.test(word);
    if (hasUnusualPattern) {
      addKeyword(keywords, lower, 5);
      addKeyword(keywords, word, 5);
    }

    // Any remaining non-stop word gets a base score
    addKeyword(keywords, lower, 2);
  }

  // 6. Generate compound keywords (adjacent unique words)
  const cleanWords = words
    .map(w => w.toLowerCase())
    .filter(w => !STOP_WORDS.has(w) && w.length >= 3);

  for (let i = 0; i < cleanWords.length - 1; i++) {
    const compound = cleanWords[i] + cleanWords[i + 1];
    if (compound.length <= 15) {
      addKeyword(keywords, compound, 4);
    }
  }

  // Sort by score, return top keywords
  const sorted = Array.from(keywords.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([kw]) => kw)
    .slice(0, 15); // Top 15 keywords

  return sorted;
}

function addKeyword(map: Map<string, number>, keyword: string, score: number): void {
  const existing = map.get(keyword) || 0;
  map.set(keyword, existing + score);
}

/**
 * Check if a tweet is likely meme-relevant (quick filter before full extraction).
 */
export function isMemeRelevant(text: string): boolean {
  const lower = text.toLowerCase();

  // Quick checks for high-signal patterns
  if (/[A-Z]{3,}/.test(text)) return true;          // ALL CAPS word
  if (lower.includes('lol') || lower.includes('lmao')) return true;
  if (lower.includes('haha') || lower.includes('🤣')) return true;
  if (text.match(/[🚀🐕🐶🌙💎🔥🐸🦍🤡🎪]/)) return true;  // Meme emojis
  if (lower.includes('#')) return true;               // Hashtags
  if (/[""].*[""]/.test(text)) return true;           // Quoted phrases

  // Check for meme-adjacent words
  for (const booster of MEME_BOOSTERS) {
    if (lower.includes(booster)) return true;
  }

  return false;
}
