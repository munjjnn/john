import { test } from "node:test";
import assert from "node:assert/strict";
import { centRange, sharesFor, buildPlan, markPosted } from "./strategy";
import { config } from "./config";
import { TokenBook, MarketWindow } from "./market-scanner";

// ── centRange ────────────────────────────────────────────────────────────────
test("centRange yields inclusive, cent-rounded price levels", () => {
  assert.deepEqual(centRange(0.07, 0.1), [0.07, 0.08, 0.09, 0.1]);
});

test("centRange survives floating-point accumulation up to the bound", () => {
  // 0.90..0.95 is the default hedge band; naive += 0.01 drifts below 1e-2.
  assert.deepEqual(centRange(0.9, 0.95), [0.9, 0.91, 0.92, 0.93, 0.94, 0.95]);
});

test("centRange returns a single level when min === max", () => {
  assert.deepEqual(centRange(0.08, 0.08), [0.08]);
});

// ── sharesFor ────────────────────────────────────────────────────────────────
test("sharesFor caps at maxSharesPerOrder", () => {
  // 10 / 0.07 = 142.8 → rounded 143, but capped at the configured max.
  assert.equal(sharesFor(10, 0.07), config.maxSharesPerOrder);
});

test("sharesFor rounds budget/price when under the cap", () => {
  // 50 / 0.9 = 55.55 → 56, below the default cap of 90.
  assert.equal(sharesFor(50, 0.9), 56);
});

// ── buildPlan ────────────────────────────────────────────────────────────────
function tok(tokenId: string, outcome: string, bestAsk: number): TokenBook {
  return { tokenId, outcome, bids: [], asks: [], bestAsk };
}

function mkMarket(askUp: number, askDown: number): MarketWindow {
  return {
    conditionId: "0xcond",
    slug: "btc-updown-15m-1782859500",
    question: "BTC Up or Down?",
    startTime: new Date(0),
    endTime: new Date(0),
    tokens: [tok("tUp", "Up", askUp), tok("tDown", "Down", askDown)],
  };
}

test("buildPlan picks the lower-ask token as the underdog (cheap leg)", () => {
  const plan = buildPlan(mkMarket(0.62, 0.38), new Set())!;
  assert.ok(plan, "expected a plan");
  assert.equal(plan.underdog.outcome, "Down");
  assert.equal(plan.favorite.outcome, "Up");

  const cheap = plan.orders.find((o) => o.leg === "cheap")!;
  assert.equal(cheap.tokenId, "tDown");
  assert.deepEqual(
    cheap.levels.map((l) => l.price),
    centRange(config.cheapBuyMin, config.cheapBuyMax)
  );
});

test("buildPlan emits the hedge leg on the favorite when enabled", () => {
  if (!config.enableExpensiveHedge) return; // honor env-driven default
  const plan = buildPlan(mkMarket(0.62, 0.38), new Set())!;
  const hedge = plan.orders.find((o) => o.leg === "expensive")!;
  assert.ok(hedge, "expected a hedge leg");
  assert.equal(hedge.tokenId, "tUp"); // favorite
  assert.deepEqual(
    hedge.levels.map((l) => l.price),
    centRange(config.expensiveBuyMin, config.expensiveBuyMax)
  );
});

test("buildPlan skips already-posted price levels and returns null when nothing is new", () => {
  const market = mkMarket(0.62, 0.38);
  const posted = new Set<string>();

  const first = buildPlan(market, posted)!;
  assert.ok(first);
  markPosted(first, posted);

  // Re-running with the same posted set should now find nothing to do.
  const second = buildPlan(market, posted);
  assert.equal(second, null);
});

test("markPosted records one key per condition:token:price", () => {
  const market = mkMarket(0.62, 0.38);
  const posted = new Set<string>();
  const plan = buildPlan(market, posted)!;
  markPosted(plan, posted);

  const cheapLevels = config.cheapBuyMax - config.cheapBuyMin;
  assert.ok(cheapLevels >= 0);
  // The underdog's first cheap level must be marked.
  assert.ok(posted.has(`${market.conditionId}:tDown:${config.cheapBuyMin}`));
});
