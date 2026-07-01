import { test } from "node:test";
import assert from "node:assert/strict";
import {
  intervalSeconds,
  windowSlugs,
  isInTradingWindow,
  parseStringArray,
  bestAsk,
  assembleWindow,
  GammaEvent,
  ClobOrderBook,
} from "./market-scanner";
import { config } from "./config";

// ── intervalSeconds ──────────────────────────────────────────────────────────
test("intervalSeconds maps known suffixes", () => {
  assert.equal(intervalSeconds("btc-updown-5m"), 300);
  assert.equal(intervalSeconds("btc-updown-15m"), 900);
  assert.equal(intervalSeconds("eth-updown-1h"), 3600);
  assert.equal(intervalSeconds("eth-updown-60m"), 3600);
});

test("intervalSeconds defaults to 15m for unknown suffixes", () => {
  assert.equal(intervalSeconds("sol-updown-weird"), 900);
});

// ── windowSlugs ──────────────────────────────────────────────────────────────
test("windowSlugs returns the current and next aligned windows", () => {
  const slugs = windowSlugs("btc-updown-15m");
  assert.equal(slugs.length, 2);

  const interval = 900;
  for (const w of slugs) {
    // start is aligned to the interval boundary
    assert.equal(w.start % interval, 0);
    assert.equal(w.end - w.start, interval);
    assert.equal(w.slug, `btc-updown-15m-${w.start}`);
  }
  // second window is exactly one interval after the first
  assert.equal(slugs[1].start - slugs[0].start, interval);
});

// ── isInTradingWindow ────────────────────────────────────────────────────────
test("isInTradingWindow rejects windows that have not opened or have closed", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // window entirely in the future
  assert.equal(isInTradingWindow(nowSec + 1000, nowSec + 1900), false);
  // window entirely in the past
  assert.equal(isInTradingWindow(nowSec - 1900, nowSec - 1000), false);
});

test("isInTradingWindow accepts the live window under the default 0–15m filter", () => {
  // Default config: MIN=0, MAX=15 → the whole 15m window is tradable.
  const interval = 900;
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - 60; // opened a minute ago
  const end = start + interval;

  const expected =
    config.minutesBeforeCloseMin === 0 && config.minutesBeforeCloseMax >= 15;
  assert.equal(isInTradingWindow(start, end), expected);
});

// ── parseStringArray ─────────────────────────────────────────────────────────
test("parseStringArray handles JSON-string and array inputs from Gamma", () => {
  assert.deepEqual(parseStringArray('["Up","Down"]'), ["Up", "Down"]);
  assert.deepEqual(parseStringArray(["Up", "Down"]), ["Up", "Down"]);
});

test("parseStringArray returns [] for undefined or malformed input", () => {
  assert.deepEqual(parseStringArray(undefined), []);
  assert.deepEqual(parseStringArray("not json"), []);
  assert.deepEqual(parseStringArray("{}"), []); // object, not array
});

// ── bestAsk ──────────────────────────────────────────────────────────────────
test("bestAsk returns the lowest ask price", () => {
  assert.equal(
    bestAsk([
      { price: 0.42, size: 10 },
      { price: 0.39, size: 5 },
      { price: 0.5, size: 20 },
    ]),
    0.39
  );
});

test("bestAsk returns 1 (worst case) for an empty book", () => {
  assert.equal(bestAsk([]), 1);
});

// ── assembleWindow ───────────────────────────────────────────────────────────
const EVENT: GammaEvent = {
  slug: "btc-updown-15m-1782859500",
  title: "Bitcoin Up or Down?",
  markets: [
    {
      conditionId: "0xcond",
      clobTokenIds: '["tUp","tDown"]',
      outcomes: '["Up","Down"]',
      question: "Will BTC be up?",
    },
  ],
};

const BOOK_UP: ClobOrderBook = {
  bids: [{ price: "0.60", size: "100" }],
  asks: [
    { price: "0.63", size: "50" },
    { price: "0.62", size: "20" },
  ],
};

const BOOK_DOWN: ClobOrderBook = {
  bids: [{ price: "0.36", size: "80" }],
  asks: [{ price: "0.39", size: "40" }],
};

test("assembleWindow maps Gamma event + books into a two-outcome window", () => {
  const w = assembleWindow(
    "btc-updown-15m-1782859500",
    1782859500,
    1782860400,
    EVENT,
    BOOK_UP,
    BOOK_DOWN
  )!;
  assert.ok(w, "expected a window");
  assert.equal(w.conditionId, "0xcond");
  assert.equal(w.question, "Bitcoin Up or Down?"); // event title preferred
  assert.equal(w.startTime.getTime(), 1782859500 * 1000);
  assert.equal(w.endTime.getTime(), 1782860400 * 1000);

  const [up, down] = w.tokens;
  assert.equal(up.tokenId, "tUp");
  assert.equal(up.outcome, "Up");
  assert.equal(up.bestAsk, 0.62); // lowest of the two asks
  assert.equal(down.tokenId, "tDown");
  assert.equal(down.bestAsk, 0.39);
});

test("assembleWindow falls back to slug when conditionId is absent", () => {
  const event: GammaEvent = {
    slug: "s",
    markets: [{ clobTokenIds: '["a","b"]', outcomes: '["Up","Down"]' }],
  };
  const w = assembleWindow("the-slug", 1, 901, event, BOOK_UP, BOOK_DOWN)!;
  assert.equal(w.conditionId, "the-slug");
});

test("assembleWindow returns null for non-two-outcome or empty markets", () => {
  assert.equal(
    assembleWindow("s", 1, 2, { slug: "s", markets: [] }, BOOK_UP, BOOK_DOWN),
    null
  );
  const oneToken: GammaEvent = {
    slug: "s",
    markets: [{ clobTokenIds: '["only"]', outcomes: '["Up"]' }],
  };
  assert.equal(assembleWindow("s", 1, 2, oneToken, BOOK_UP, BOOK_DOWN), null);
});
