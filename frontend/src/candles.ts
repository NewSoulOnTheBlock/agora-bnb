import { id as topicId, AbiCoder, type Log } from "ethers";
import { logProvider, TORII, BLOCK_SECONDS } from "./chain";
import { scanLogsBackwards, lastScanReachedWall } from "./history";
import { pairFor } from "./poolkey";

/**
 * Candles, built from the pair's own `Swap` events.
 *
 * ## Why not an API
 *
 * The same reason as on the other chain: an indexer only knows the pool from
 * the moment it started watching it, and a freshly graduated token returns one
 * candle. The pair, meanwhile, has emitted a `Swap` for every trade since the
 * first, from the same RPC everything else here uses, with no key.
 *
 * ## What is different on BNB, and it is not small
 *
 * PancakeSwap V2 emits amounts, not prices:
 *
 *   Swap(address indexed sender, uint amount0In, uint amount1In,
 *        uint amount0Out, uint amount1Out, address indexed to)
 *
 * There is no `sqrtPriceX96` to square. Each swap's price is derived from its
 * own legs — quote moved divided by token moved — which is the **executed**
 * price rather than the mid price after the trade. That is arguably the truer
 * candle, and it is the only one available here.
 *
 * ## The real limit
 *
 * Free BSC endpoints serve roughly 75 minutes of logs (see `history.ts`). So on
 * this chain the 1h and 1d buckets will usually be a single candle, and that is
 * the node's limit, not the token's. `readCandles` returns `reachedWall` so the
 * chart can say which it is rather than drawing a flat line and letting the
 * reader infer the wrong thing.
 *
 * ## Timestamps without a call per swap
 *
 * Logs carry a block number, not a time. Two real blocks are read — the first
 * and last in the range — and the rest interpolated. BSC blocks are 0.45s and
 * very regular, so the error inside a bucket is far smaller than the bucket.
 */
const SWAP_TOPIC = topicId("Swap(address,uint256,uint256,uint256,uint256,address)");

export type Candle = {
  /** Unix seconds at the start of the bucket. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** BNB that changed hands in the bucket. */
  v: number;
  trades: number;
};

export type Bucket = 60 | 300 | 3600 | 86400;

export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 60, label: "1m" },
  { id: 300, label: "5m" },
  { id: 3600, label: "1h" },
  { id: 86400, label: "1d" },
];

type Point = { block: number; price: number; ethVolume: number };

function decode(logs: Log[], tokenIsZero: boolean): Point[] {
  const abi = AbiCoder.defaultAbiCoder();
  const out: Point[] = [];

  for (const l of logs) {
    try {
      const d = abi.decode(["uint256", "uint256", "uint256", "uint256"], l.data);
      const a0In = BigInt(d[0]), a1In = BigInt(d[1]);
      const a0Out = BigInt(d[2]), a1Out = BigInt(d[3]);

      // Exactly one side is in and one is out on a V2 swap, so summing the two
      // per token gives the size of each leg without branching on direction.
      const token = tokenIsZero ? a0In + a0Out : a1In + a1Out;
      const quote = tokenIsZero ? a1In + a1Out : a0In + a0Out;
      if (token === 0n || quote === 0n) continue;

      // Executed price, in BNB per TORII. Both legs are 18 decimals on BSC.
      const price = Number(quote) / Number(token);
      if (!Number.isFinite(price) || price <= 0) continue;

      out.push({ block: l.blockNumber, price, ethVolume: Number(quote) / 1e18 });
    } catch {
      // A log we cannot decode is skipped rather than failing the series.
    }
  }
  return out;
}

/**
 * Read the pair's swap history and fold it into candles.
 *
 * `reachedWall` is true when the node refused part of the range, which on a
 * free BSC endpoint is the normal case rather than an error. The caller must
 * distinguish it from a quiet market.
 */
export type CandleSeries = { candles: Candle[]; reachedWall: boolean };

export async function readCandles(bucket: Bucket, maxChunks = 3): Promise<CandleSeries> {
  if (!TORII.token || TORII.token === "0x0000000000000000000000000000000000000000") {
    return { candles: [], reachedWall: false };
  }

  const pair = pairFor(TORII.token);

  const logs = await scanLogsBackwards({
    address: pair.address,
    topics: [SWAP_TOPIC],
    maxChunks,
    stopAfter: 20_000,
  });
  const reachedWall = lastScanReachedWall();
  if (!logs.length) return { candles: [], reachedWall };

  const pts = decode(logs, pair.tokenIsZero).sort((a, b) => a.block - b.block);
  if (!pts.length) return { candles: [], reachedWall };

  // Two real block reads anchor the interpolation; the measured chain-wide
  // block time is the fallback when a single-swap range gives nothing to
  // interpolate between.
  const first = pts[0].block;
  const last = pts[pts.length - 1].block;
  const [b0, b1] = await Promise.all([
    logProvider.getBlock(first).catch(() => null),
    logProvider.getBlock(last).catch(() => null),
  ]);
  if (!b0) return { candles: [], reachedWall };

  const span = Math.max(1, (b1?.number ?? b0.number) - b0.number);
  const secPerBlock = b1 && span > 0 ? (b1.timestamp - b0.timestamp) / span : BLOCK_SECONDS;
  const timeOf = (block: number) => b0.timestamp + (block - b0.number) * secPerBlock;

  const byBucket = new Map<number, Candle>();
  for (const pt of pts) {
    const t = Math.floor(timeOf(pt.block) / bucket) * bucket;
    const existing = byBucket.get(t);
    if (!existing) {
      byBucket.set(t, {
        t, o: pt.price, h: pt.price, l: pt.price, c: pt.price,
        v: pt.ethVolume, trades: 1,
      });
    } else {
      existing.h = Math.max(existing.h, pt.price);
      existing.l = Math.min(existing.l, pt.price);
      existing.c = pt.price;
      existing.v += pt.ethVolume;
      existing.trades++;
    }
  }

  return { candles: [...byBucket.values()].sort((a, b) => a.t - b.t), reachedWall };
}
