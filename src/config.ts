import dotenv from "dotenv";
dotenv.config();

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${key}`);
  return v;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v.toLowerCase() !== "false" && v !== "0";
}

export const config = {
  privateKey: env("PRIVATE_KEY", "0x" + "0".repeat(64)),
  funderAddress: env(
    "FUNDER_ADDRESS",
    "0xe2511c9e41c5e762887e538b1d6e7221807aa237"
  ),
  signatureType: envInt("SIGNATURE_TYPE", 2),

  dryRun: envBool("DRY_RUN", true),

  // Cheap (reversal) leg
  cheapBuyMin: envFloat("CHEAP_BUY_MIN", 0.07),
  cheapBuyMax: envFloat("CHEAP_BUY_MAX", 0.10),
  cheapOrderUsdc: envFloat("CHEAP_ORDER_USDC", 10),

  // Expensive (hedge) leg
  enableExpensiveHedge: envBool("ENABLE_EXPENSIVE_HEDGE", true),
  expensiveBuyMin: envFloat("EXPENSIVE_BUY_MIN", 0.90),
  expensiveBuyMax: envFloat("EXPENSIVE_BUY_MAX", 0.95),
  expensiveOrderUsdc: envFloat("EXPENSIVE_ORDER_USDC", 50),

  maxSharesPerOrder: envInt("MAX_SHARES_PER_ORDER", 90),

  marketSlugPrefixes: env("MARKET_SLUG_PREFIXES", "btc-updown-15m,eth-updown-15m")
    .split(",")
    .map((s) => s.trim()),

  pollIntervalMs: envInt("POLL_INTERVAL_MS", 5000),

  minutesBeforeCloseMin: envInt("MINUTES_BEFORE_CLOSE_MIN", 0),
  minutesBeforeCloseMax: envInt("MINUTES_BEFORE_CLOSE_MAX", 15),

  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
};

export type Config = typeof config;
