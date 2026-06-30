import { ClobClient, Side, SignatureType, OrderType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { config } from "./config";
import { WindowPlan, OrderIntent, PriceLevel } from "./strategy";

let _client: ClobClient | null = null;
let _clientPromise: Promise<ClobClient> | null = null;

function sigType(n: number): SignatureType {
  switch (n) {
    case 0: return SignatureType.EOA;
    case 1: return SignatureType.POLY_PROXY;
    case 2: return SignatureType.POLY_GNOSIS_SAFE;
    default: return SignatureType.EOA;
  }
}

// Posting orders requires L2 (API-key) auth. The CLOB client throws
// L2_AUTH_NOT_AVAILABLE unless it was constructed with creds, so we first
// build an L1-only client, derive/create the API key from the wallet
// signature, then rebuild the client with those creds.
async function buildClient(): Promise<ClobClient> {
  const wallet = new ethers.Wallet(config.privateKey);

  const l1 = new ClobClient(
    config.clobApiUrl,
    137,            // Polygon mainnet
    wallet,
    undefined,
    sigType(config.signatureType),
    config.funderAddress
  );

  const creds = await l1.createOrDeriveApiKey();

  return new ClobClient(
    config.clobApiUrl,
    137,
    wallet,
    creds,
    sigType(config.signatureType),
    config.funderAddress
  );
}

async function getClient(): Promise<ClobClient> {
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = buildClient().then((c) => {
      _client = c;
      return c;
    });
  }
  return _clientPromise;
}

async function submitLevel(
  conditionId: string,
  intent: OrderIntent,
  level: PriceLevel
): Promise<void> {
  const priceStr = level.price.toFixed(2);
  const label = `[${intent.leg.toUpperCase()} ${intent.outcome} @ $${priceStr} × ${level.shares}]`;

  if (config.dryRun) {
    console.log(`  [DRY-RUN] Would BUY ${label}`);
    return;
  }

  try {
    const client = await getClient();

    const signed = await client.createOrder({
      tokenID: intent.tokenId,
      price: level.price,
      size: level.shares,
      side: Side.BUY,
    });

    const resp = await client.postOrder(signed, OrderType.GTC);

    if (resp?.success) {
      console.log(`  [TRADE] Placed BUY ${label} → orderId=${resp.orderID ?? resp.orderId}`);
    } else {
      const reason = resp?.errorMsg ?? resp?.error ?? JSON.stringify(resp);
      console.warn(`  [TRADE] Rejected ${label}: ${reason}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [TRADE] Error posting ${label}: ${msg}`);
  }
}

export async function executePlan(plan: WindowPlan): Promise<void> {
  const { market, underdog, favorite, orders } = plan;

  console.log(
    `\n[PLAN] ${market.slug}` +
    ` | underdog=${underdog.outcome}@${underdog.bestAsk.toFixed(3)}` +
    ` | favorite=${favorite.outcome}@${favorite.bestAsk.toFixed(3)}`
  );

  for (const intent of orders) {
    console.log(
      `  → ${intent.leg === "cheap" ? "CHEAP" : "HEDGE"} leg: ` +
      `${intent.levels.length} price level(s) on ${intent.outcome}`
    );

    for (const level of intent.levels) {
      await submitLevel(market.conditionId, intent, level);

      // brief pause between submissions to respect rate limits
      if (!config.dryRun) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
}
