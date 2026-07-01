import axios from "axios";
import { config } from "./config";

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface TokenBook {
  tokenId: string;
  outcome: string;  // "Up" | "Down"
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestAsk: number;  // lowest ask price, or 1 if no asks
}

export interface MarketWindow {
  conditionId: string;
  slug: string;
  question: string;
  startTime: Date;
  endTime: Date;
  tokens: [TokenBook, TokenBook];  // exactly two outcomes
}

export interface GammaEventMarket {
  conditionId?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  question?: string;
}

export interface GammaEvent {
  slug: string;
  title?: string;
  markets?: GammaEventMarket[];
}

export interface ClobOrderBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

// Each scan prefix like "btc-updown-15m" encodes an interval in its suffix.
// The recurring crypto Up/Down markets are NOT in the general market search;
// each window is a separate event whose slug is the prefix plus the Unix
// timestamp of the window's start, rounded down to the interval boundary:
//   <prefix>-<floor(now / intervalSec) * intervalSec>
export function intervalSeconds(prefix: string): number {
  if (prefix.endsWith("-5m")) return 300;
  if (prefix.endsWith("-15m")) return 900;
  if (prefix.endsWith("-1h") || prefix.endsWith("-60m")) return 3600;
  return 900;
}

export function windowSlugs(prefix: string): { slug: string; start: number; end: number }[] {
  const interval = intervalSeconds(prefix);
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / interval) * interval;
  // current open window, plus the next one (often already tradable)
  return [current, current + interval].map((start) => ({
    slug: `${prefix}-${start}`,
    start,
    end: start + interval,
  }));
}

export function parseStringArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchEvent(slug: string): Promise<GammaEvent | null> {
  try {
    const resp = await axios.get<GammaEvent>(
      `${config.gammaApiUrl}/events/slug/${slug}`,
      { timeout: 10_000 }
    );
    return resp.data ?? null;
  } catch {
    return null;
  }
}

async function fetchOrderBook(tokenId: string): Promise<ClobOrderBook | null> {
  try {
    const resp = await axios.get<ClobOrderBook>(
      `${config.clobApiUrl}/book`,
      { params: { token_id: tokenId }, timeout: 8_000 }
    );
    return resp.data;
  } catch {
    return null;
  }
}

function parseLevels(raw: Array<{ price: string; size: string }>): OrderBookLevel[] {
  return (raw ?? []).map((l) => ({
    price: parseFloat(l.price),
    size: parseFloat(l.size),
  }));
}

export function bestAsk(asks: OrderBookLevel[]): number {
  if (asks.length === 0) return 1;
  return Math.min(...asks.map((a) => a.price));
}

function toTokenBook(tokenId: string, outcome: string, book: ClobOrderBook): TokenBook {
  const asks = parseLevels(book.asks);
  return {
    tokenId,
    outcome,
    bids: parseLevels(book.bids),
    asks,
    bestAsk: bestAsk(asks),
  };
}

// Pure assembly of a MarketWindow from an already-fetched event and its two
// order books. Kept separate from the network fetch so it can be tested with
// fixtures. Returns null if the event does not describe a two-outcome market.
export function assembleWindow(
  slug: string,
  start: number,
  end: number,
  event: GammaEvent,
  bookA: ClobOrderBook,
  bookB: ClobOrderBook
): MarketWindow | null {
  const market = event?.markets?.[0];
  if (!market) return null;

  const tokenIds = parseStringArray(market.clobTokenIds);
  const outcomes = parseStringArray(market.outcomes);
  if (tokenIds.length !== 2 || outcomes.length !== 2) return null;

  const tokens: [TokenBook, TokenBook] = [
    toTokenBook(tokenIds[0], outcomes[0], bookA),
    toTokenBook(tokenIds[1], outcomes[1], bookB),
  ];

  return {
    conditionId: market.conditionId ?? slug,
    slug,
    question: event.title ?? market.question ?? slug,
    startTime: new Date(start * 1000),
    endTime: new Date(end * 1000),
    tokens,
  };
}

export function isInTradingWindow(startSec: number, endSec: number): boolean {
  const now = Date.now();
  const start = startSec * 1000;
  const end = endSec * 1000;
  if (now < start || now >= end) return false;

  const windowMin = (end - start) / 60_000;
  const elapsedMin = (now - start) / 60_000;

  const tradeMin = windowMin - config.minutesBeforeCloseMax;
  const tradeMax = windowMin - config.minutesBeforeCloseMin;

  return elapsedMin >= Math.max(0, tradeMin) && elapsedMin <= tradeMax;
}

export async function scanMarkets(): Promise<MarketWindow[]> {
  const windows: MarketWindow[] = [];

  for (const prefix of config.marketSlugPrefixes) {
    for (const { slug, start, end } of windowSlugs(prefix)) {
      if (!isInTradingWindow(start, end)) continue;

      const event = await fetchEvent(slug);
      const market = event?.markets?.[0];
      if (!event || !market) continue;

      const tokenIds = parseStringArray(market.clobTokenIds);
      if (tokenIds.length !== 2) continue;

      const [bookA, bookB] = await Promise.all([
        fetchOrderBook(tokenIds[0]),
        fetchOrderBook(tokenIds[1]),
      ]);
      if (!bookA || !bookB) continue;

      const window = assembleWindow(slug, start, end, event, bookA, bookB);
      if (window) windows.push(window);
    }
  }

  return windows;
}
