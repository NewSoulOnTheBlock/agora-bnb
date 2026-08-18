import { id as topicId, AbiCoder, type Log } from "ethers";
import { readProvider, V4, AGORA } from "./chain";
import { scanLogsBackwards } from "./history";
import { ponsPoolKey, poolId } from "./poolkey";

/**
 * Candles, built from the pool's own `Swap` events.
 *
 * ## Why not an API
 *
 * GeckoTerminal does cover this chain and does serve OHLCV, and it is the
 * obvious answer — except it only has data from the moment it started indexing
 * the pool. Asked today it returns **one** candle, because the pool is under an
 * hour old. DexScreener knows the pair but publishes no OHLCV endpoint at all.
 *
 * The PoolManager, meanwhile, has emitted a `Swap` for every trade since the
 * first one, each carrying `sqrtPriceX96`. That is a complete price history,
 * available from the same RPC everything else on this page uses, with no key
 * and no third party. 212 swaps came back in 0.25s on the first run.
 *
 * ## Timestamps without a call per swap
 *
 * Logs carry a block number, not a time. Fetching a block per swap would be
 * hundreds of round-trips, so two real blocks are read — the first and last in
 * the range — and the rest are interpolated at the measured block time. On this
 * chain that is ~0.1s per block and very regular, so the error inside a bucket
 * is far smaller than the bucket.
 */

const SWAP_TOPIC = topicId("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const Q96 = 2 ** 96;

export type Candle = {
  /** Unix seconds at the start of the bucket. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** ETH that changed hands in the bucket. */
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

function decode(logs: Log[], agoraIsCurrency1: boolean): Point[] {
  const abi = AbiCoder.defaultAbiCoder();
  const out: Point[] = [];

  for (const l of logs) {
    try {
      const d = abi.decode(
        ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
        l.data
      );
      const amount0 = BigInt(d[0]);
      const sqrtPriceX96 = BigInt(d[2]);

      const sqrt = Number(sqrtPriceX96) / Q96;
      const p = sqrt * sqrt; // currency1 per currency0

      // AGORA is currency1 against native ETH, so its price is the reciprocal.
      const price = agoraIsCurrency1 ? 1 / p : p;
      if (!Number.isFinite(price) || price <= 0) continue;

      // amount0 is the ETH leg, signed by direction; size is what matters.
      const eth = Number(amount0 < 0n ? -amount0 : amount0) / 1e18;

      out.push({ block: l.blockNumber, price, ethVolume: eth });
    } catch {
      // A log we cannot decode is skipped rather than failing the series.
    }
  }
  return out;
}

/**
 * Read the pool's swap history and fold it into candles.
 *
 * `maxChunks` bounds the scan; at ~0.1s blocks a 450k-block chunk is roughly
 * 12 hours, so three chunks cover a day and a half.
 */
export async function readCandles(bucket: Bucket, maxChunks = 3): Promise<Candle[]> {
  const key = ponsPoolKey(AGORA.token);
  const pid = poolId(key);

  const logs = await scanLogsBackwards({
    address: V4.poolManager,
    topics: [SWAP_TOPIC, pid],
    maxChunks,
    stopAfter: 20_000,
  });
  if (!logs.length) return [];

  const agoraIsCurrency1 =
    key.currency1.toLowerCase() === AGORA.token.toLowerCase();
  const pts = decode(logs, agoraIsCurrency1).sort((a, b) => a.block - b.block);
  if (!pts.length) return [];

  // Two real block reads anchor the interpolation.
  const first = pts[0].block;
  const last = pts[pts.length - 1].block;
  const [b0, b1] = await Promise.all([
    readProvider.getBlock(first).catch(() => null),
    readProvider.getBlock(last).catch(() => null),
  ]);
  if (!b0 || !b1) return [];

  const span = Math.max(1, b1.number - b0.number);
  const secPerBlock = (b1.timestamp - b0.timestamp) / span;
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

  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}
