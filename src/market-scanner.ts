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

interface GammaMarket {
  conditionId: string;
  slug: string;
  question: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{ tokenId: string; outcome: string }>;
}

interface ClobOrderBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

async function fetchActiveMarkets(): Promise<GammaMarket[]> {
  const prefixes = config.marketSlugPrefixes;
  const results: GammaMarket[] = [];

  for (const prefix of prefixes) {
    try {
      const resp = await axios.get<{ markets: GammaMarket[] }>(
        `${config.gammaApiUrl}/markets`,
        {
          params: { slug_prefix: prefix, active: true, closed: false },
          timeout: 10_000,
        }
      );
      const markets = resp.data?.markets ?? (resp.data as unknown as GammaMarket[]);
      const arr = Array.isArray(markets) ? markets : [];
      results.push(...arr);
    } catch (err) {
      console.error(`[scanner] Failed to fetch markets for prefix "${prefix}":`, err);
    }
  }

  return results;
}

async function fetchOrderBook(tokenId: string): Promise<ClobOrderBook | null> {
  try {
    const resp = await axios.get<ClobOrderBook>(
      `${config.clobApiUrl}/book`,
      {
        params: { token_id: tokenId },
        timeout: 8_000,
      }
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

function bestAsk(asks: OrderBookLevel[]): number {
  if (asks.length === 0) return 1;
  return Math.min(...asks.map((a) => a.price));
}

function windowBounds(market: GammaMarket): { start: Date; end: Date } {
  const start = new Date(market.startDate);
  const end = new Date(market.endDate);
  return { start, end };
}

function isInTradingWindow(start: Date, end: Date): boolean {
  const now = Date.now();
  const windowMs = end.getTime() - start.getTime();
  const elapsedMs = now - start.getTime();
  const elapsedMin = elapsedMs / 60_000;

  if (elapsedMs < 0 || now >= end.getTime()) return false;

  const min = config.minutesBeforeCloseMin;
  const max = config.minutesBeforeCloseMax;
  const windowMin = windowMs / 60_000;

  // Convert window-position config to elapsed-minutes filter
  // minutesBeforeCloseMin/Max describe how many minutes into the window we allow
  const tradeMin = windowMin - max;
  const tradeMax = windowMin - min;

  return elapsedMin >= Math.max(0, tradeMin) && elapsedMin <= tradeMax;
}

export async function scanMarkets(): Promise<MarketWindow[]> {
  const raw = await fetchActiveMarkets();
  const windows: MarketWindow[] = [];

  for (const m of raw) {
    if (!m.tokens || m.tokens.length !== 2) continue;

    const { start, end } = windowBounds(m);
    if (!isInTradingWindow(start, end)) continue;

    const [bookA, bookB] = await Promise.all([
      fetchOrderBook(m.tokens[0].tokenId),
      fetchOrderBook(m.tokens[1].tokenId),
    ]);

    if (!bookA || !bookB) continue;

    const tokenBooks: [TokenBook, TokenBook] = [
      {
        tokenId: m.tokens[0].tokenId,
        outcome: m.tokens[0].outcome,
        bids: parseLevels(bookA.bids),
        asks: parseLevels(bookA.asks),
        bestAsk: bestAsk(parseLevels(bookA.asks)),
      },
      {
        tokenId: m.tokens[1].tokenId,
        outcome: m.tokens[1].outcome,
        bids: parseLevels(bookB.bids),
        asks: parseLevels(bookB.asks),
        bestAsk: bestAsk(parseLevels(bookB.asks)),
      },
    ];

    windows.push({
      conditionId: m.conditionId,
      slug: m.slug,
      question: m.question,
      startTime: start,
      endTime: end,
      tokens: tokenBooks,
    });
  }

  return windows;
}
