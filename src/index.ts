import { config } from "./config";
import { scanMarkets } from "./market-scanner";
import { buildPlan, WindowPlan } from "./strategy";
import { executePlan } from "./trader";

// Tracks price levels already posted this session (survives across poll cycles).
// Bounded so a long-running process doesn't accumulate keys for closed windows
// that will never be scanned again.
const posted = new Set<string>();
const POSTED_MAX = 5000;

function prunePosted(): void {
  if (posted.size <= POSTED_MAX) return;
  const overflow = posted.size - POSTED_MAX;
  // Sets preserve insertion order, so the oldest keys come first.
  let i = 0;
  for (const key of posted) {
    if (i++ >= overflow) break;
    posted.delete(key);
  }
}

function banner(): void {
  const mode = config.dryRun ? "DRY-RUN" : "LIVE";
  console.log("=".repeat(60));
  console.log(`  Polymarket Reverse Bot  [${mode}]`);
  console.log(`  Markets : ${config.marketSlugPrefixes.join(", ")}`);
  console.log(
    `  Cheap   : ${config.cheapBuyMin}–${config.cheapBuyMax} @ $${config.cheapOrderUsdc}/level`
  );
  if (config.enableExpensiveHedge) {
    console.log(
      `  Hedge   : ${config.expensiveBuyMin}–${config.expensiveBuyMax} @ $${config.expensiveOrderUsdc}/level`
    );
  } else {
    console.log("  Hedge   : disabled");
  }
  console.log(`  Poll    : every ${config.pollIntervalMs / 1000}s`);
  console.log("=".repeat(60));
}

async function tick(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n[TICK] ${ts}`);

  let markets;
  try {
    markets = await scanMarkets();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] scanMarkets failed: ${msg}`);
    return;
  }

  if (markets.length === 0) {
    console.log("[TICK] No active markets in trading window.");
    return;
  }

  const plans: WindowPlan[] = [];
  for (const market of markets) {
    const plan = buildPlan(market, posted);
    if (plan) plans.push(plan);
  }

  if (plans.length === 0) {
    console.log("[TICK] All price levels already posted — nothing new.");
    return;
  }

  for (const plan of plans) {
    await executePlan(plan, posted);
  }

  prunePosted();
}

async function main(): Promise<void> {
  banner();

  // Run immediately, then on interval
  await tick();

  setInterval(async () => {
    try {
      await tick();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Unhandled tick error: ${msg}`);
    }
  }, config.pollIntervalMs);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
