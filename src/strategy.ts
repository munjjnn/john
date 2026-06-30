import { TokenBook, MarketWindow } from "./market-scanner";
import { config } from "./config";

export interface PriceLevel {
  price: number;   // e.g. 0.08
  shares: number;
}

export interface OrderIntent {
  tokenId: string;
  outcome: string;
  leg: "cheap" | "expensive";
  levels: PriceLevel[];
}

export interface WindowPlan {
  market: MarketWindow;
  underdog: TokenBook;
  favorite: TokenBook;
  orders: OrderIntent[];
}

function centRange(min: number, max: number, step = 0.01): number[] {
  const prices: number[] = [];
  for (let p = min; p <= max + 1e-9; p += step) {
    prices.push(Math.round(p * 100) / 100);
  }
  return prices;
}

function sharesFor(usdcBudget: number, price: number): number {
  const raw = usdcBudget / price;
  return Math.min(Math.round(raw), config.maxSharesPerOrder);
}

export function buildPlan(market: MarketWindow, posted: Set<string>): WindowPlan | null {
  const [tokenA, tokenB] = market.tokens;

  const underdog = tokenA.bestAsk <= tokenB.bestAsk ? tokenA : tokenB;
  const favorite = underdog === tokenA ? tokenB : tokenA;

  const orders: OrderIntent[] = [];

  // ── Cheap (reversal) leg ──────────────────────────────────────────────────
  const cheapPrices = centRange(config.cheapBuyMin, config.cheapBuyMax)
    .filter((p) => {
      const key = `${market.conditionId}:${underdog.tokenId}:${p}`;
      return !posted.has(key);
    });

  if (cheapPrices.length > 0) {
    orders.push({
      tokenId: underdog.tokenId,
      outcome: underdog.outcome,
      leg: "cheap",
      levels: cheapPrices.map((p) => ({
        price: p,
        shares: sharesFor(config.cheapOrderUsdc, p),
      })),
    });
  }

  // ── Expensive (hedge) leg ─────────────────────────────────────────────────
  if (config.enableExpensiveHedge) {
    const expPrices = centRange(config.expensiveBuyMin, config.expensiveBuyMax)
      .filter((p) => {
        const key = `${market.conditionId}:${favorite.tokenId}:${p}`;
        return !posted.has(key);
      });

    if (expPrices.length > 0) {
      orders.push({
        tokenId: favorite.tokenId,
        outcome: favorite.outcome,
        leg: "expensive",
        levels: expPrices.map((p) => ({
          price: p,
          shares: sharesFor(config.expensiveOrderUsdc, p),
        })),
      });
    }
  }

  if (orders.length === 0) return null;

  return { market, underdog, favorite, orders };
}

export function markPosted(plan: WindowPlan, posted: Set<string>): void {
  for (const order of plan.orders) {
    for (const level of order.levels) {
      posted.add(`${plan.market.conditionId}:${order.tokenId}:${level.price}`);
    }
  }
}
