import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config";
import { WindowPlan, OrderIntent, PriceLevel } from "./strategy";

const CHAIN_ID = 137; // Polygon mainnet

let _client: ClobClient | null = null;
let _clientPromise: Promise<ClobClient> | null = null;

// Posting orders requires L2 (API-key) auth. Build a signer-only client first,
// derive/create the API key from the wallet signature, then rebuild the client
// with those creds so it can sign + post orders.
async function buildClient(): Promise<ClobClient> {
  const pk = (config.privateKey.startsWith("0x")
    ? config.privateKey
    : `0x${config.privateKey}`) as `0x${string}`;

  const account = privateKeyToAccount(pk);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });

  const temp = new ClobClient({ host: config.clobApiUrl, chain: CHAIN_ID, signer });
  const creds = await temp.createOrDeriveApiKey();

  return new ClobClient({
    host: config.clobApiUrl,
    chain: CHAIN_ID,
    signer,
    creds,
    // SignatureTypeV2 is a numeric enum; pass the configured value directly.
    signatureType: config.signatureType as any,
    funderAddress: config.funderAddress,
  });
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

    // Newer CLOB protocol requires the market's tick size and neg-risk flag.
    // Fetch them per token where available; fall back to sane defaults.
    let tickSize: "0.1" | "0.01" | "0.001" | "0.0001" = "0.01";
    let negRisk = false;
    try {
      tickSize = (await client.getTickSize(intent.tokenId)) as typeof tickSize;
    } catch {
      /* fall back to 0.01 */
    }
    try {
      negRisk = await client.getNegRisk(intent.tokenId);
    } catch {
      /* fall back to false */
    }

    const resp: any = await client.createAndPostOrder(
      {
        tokenID: intent.tokenId,
        price: level.price,
        size: level.shares,
        side: Side.BUY,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );

    const orderId = resp?.orderID ?? resp?.orderId;
    const ok = resp?.success === true || Boolean(orderId);
    if (ok) {
      console.log(`  [TRADE] Placed BUY ${label} → orderId=${orderId} status=${resp?.status ?? "?"}`);
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
