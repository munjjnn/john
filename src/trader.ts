import { ClobClient, Side, SignatureType, OrderType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { config } from "./config";
import { WindowPlan, OrderIntent, PriceLevel } from "./strategy";

let _client: ClobClient | null = null;

function sigType(n: number): SignatureType {
  switch (n) {
    case 0: return SignatureType.EOA;
    case 1: return SignatureType.POLY_PROXY;
    case 2: return SignatureType.POLY_GNOSIS_SAFE;
    default: return SignatureType.EOA;
  }
}

function getClient(): ClobClient {
  if (_client) return _client;

  const wallet = new ethers.Wallet(config.privateKey);

  _client = new ClobClient(
    config.clobApiUrl,
    137,            // Polygon mainnet
    wallet,
    undefined,      // creds (API key) — derived from wallet
    sigType(config.signatureType),
    config.funderAddress
  );

  return _client;
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
    const client = getClient();

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
