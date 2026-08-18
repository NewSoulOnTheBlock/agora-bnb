import { Contract, id as topicId, Interface, type Log } from "ethers";
import { readProvider, MAX_LOG_SPAN, PONS, AGORA, ZERO } from "./chain";
import { MEME_HOOK_ABI, TREASURY_ABI } from "./abis";

/**
 * Chunked backwards log scanner.
 *
 * The public Robinhood RPC accepts ~500k-block eth_getLogs spans (1M fails), and
 * the chain produces blocks fast enough that 500k is well under two days. So a
 * "last N days" view means several sequential requests — hence the chunking and
 * the hard `maxChunks` ceiling, which keeps a curious user from accidentally
 * firing hundreds of requests at a public endpoint.
 *
 * The Alchemy endpoint cannot do this at all: its free tier caps getLogs at a
 * 10-block range.
 */
export async function scanLogsBackwards(opts: {
  address: string;
  topics: (string | null)[];
  maxChunks?: number;
  spanPerChunk?: number;
  stopAfter?: number;
  onProgress?: (chunk: number, found: number) => void;
}): Promise<Log[]> {
  const {
    address, topics,
    maxChunks = 6,
    spanPerChunk = MAX_LOG_SPAN,
    stopAfter = 5000,
    onProgress,
  } = opts;

  if (!address || address === ZERO) return [];

  const head = await readProvider.getBlockNumber();

  // The ranges are a pure function of `head`, so they do not need to be walked
  // one at a time. The previous version awaited each chunk before computing the
  // next, which made the Reserve page pay `maxChunks` sequential round-trips of
  // a 450k-block getLogs — and the page fires two of these scans at once, so
  // the wait was up to ten heavy queries end to end. Issuing them together
  // collapses that to a single wave.
  const ranges: { from: number; to: number }[] = [];
  let to = head;
  for (let i = 0; i < maxChunks && to >= 0; i++) {
    const from = Math.max(0, to - spanPerChunk + 1);
    ranges.push({ from, to });
    if (from === 0) break;
    to = from - 1;
  }

  // A rejected chunk (rate limit, span too wide) contributes nothing rather
  // than discarding the chunks that did succeed.
  const settled = await Promise.all(
    ranges.map(({ from, to: hi }) =>
      readProvider
        .getLogs({ address, topics, fromBlock: from, toBlock: hi })
        .catch(() => [] as Log[])
    )
  );

  // Ranges were built newest-first, so reverse to get overall ascending order.
  const out: Log[] = [];
  for (let i = settled.length - 1; i >= 0; i--) out.push(...settled[i]);

  onProgress?.(ranges.length, out.length);

  // `stopAfter` used to end the walk early. With the chunks in flight together
  // there is nothing left to stop, so it now bounds what is returned — keeping
  // the most recent events, which is what every caller charts.
  return out.length > stopAfter ? out.slice(out.length - stopAfter) : out;
}

// ---------------------------------------------------------------------------
// Cumulative tax history — available TODAY, with no contract of ours.
// HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)
// ---------------------------------------------------------------------------

export type TaxEvent = {
  block: number;
  currency: string;
  feeAmount: bigint;
  taxAmount: bigint;
  /** Running total of taxAmount up to and including this event, per currency. */
  cumulativeTax: bigint;
};

const HOOK_IFACE = new Interface(MEME_HOOK_ABI);
const T_HOOK_FEE = topicId("HookFeeCollected(bytes32,address,uint256,uint256)");

/**
 * Tax history for one pool, in ONE currency.
 *
 * The `currency` filter is not optional in spirit: the hook emits
 * HookFeeCollected for BOTH legs of a swap — native ETH on one side and the
 * memecoin on the other. Measured over 100k blocks on chain 4663, the same hook
 * produced 1,397 native-ETH events alongside hundreds of token-denominated ones.
 * Summing across currencies adds ether to token units and yields a meaningless
 * number (it read as ~8.8M "ETH" before this filter existed).
 *
 * Pons's sweepPoolFees() later converts the memecoin leg to quote before
 * crediting the creator, so the ETH series is the one that maps to corpus inflow.
 */
export async function readTaxHistory(
  pid: string,
  currency: string = ZERO,
  maxChunks = 4
): Promise<TaxEvent[]> {
  const logs = await scanLogsBackwards({
    address: PONS.memeHook,
    topics: [T_HOOK_FEE, pid],
    maxChunks,
  });

  const want = currency.toLowerCase();
  let running = 0n;
  const out: TaxEvent[] = [];
  for (const l of logs) {
    try {
      const p = HOOK_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      if (!p) continue;
      const cur = String(p.args.currency);
      if (cur.toLowerCase() !== want) continue;
      const taxAmount = BigInt(p.args.taxAmount);
      running += taxAmount;
      out.push({
        block: l.blockNumber,
        currency: cur,
        feeAmount: BigInt(p.args.feeAmount),
        taxAmount,
        cumulativeTax: running,
      });
    } catch {
      // Skip any log we can't decode rather than failing the whole series.
    }
  }
  return out;
}

/** Per-currency totals, for the Proof page — makes the two legs explicit. */
export async function readTaxByCurrency(
  pid: string,
  maxChunks = 4
): Promise<Map<string, { count: number; total: bigint }>> {
  const logs = await scanLogsBackwards({
    address: PONS.memeHook,
    topics: [T_HOOK_FEE, pid],
    maxChunks,
  });
  const m = new Map<string, { count: number; total: bigint }>();
  for (const l of logs) {
    try {
      const p = HOOK_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      if (!p) continue;
      const cur = String(p.args.currency);
      const e = m.get(cur) ?? { count: 0, total: 0n };
      e.count += 1;
      e.total += BigInt(p.args.taxAmount);
      m.set(cur, e);
    } catch { /* ignore */ }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Floor history — the ratchet chart's data source. Needs Treasury deployed.
//
// This is why the spec asks Treasury to emit FloorUpdated on every state change:
// NAV is a view function with no history, and the monotonic floor line is the
// product's whole argument. One event removes any need for an indexer.
// ---------------------------------------------------------------------------

export type FloorPoint = {
  block: number;
  nav: bigint;
  eligibleSupply: bigint;
  timestamp: number;
  floorWad: bigint;
};

const TREASURY_IFACE = new Interface(TREASURY_ABI);
const T_FLOOR = topicId("FloorUpdated(uint256,uint256,uint256)");
const WAD = 10n ** 18n;

export async function readFloorHistory(maxChunks = 6): Promise<FloorPoint[]> {
  if (!AGORA.treasury || AGORA.treasury === ZERO) return [];
  const logs = await scanLogsBackwards({
    address: AGORA.treasury,
    topics: [T_FLOOR],
    maxChunks,
  });

  const out: FloorPoint[] = [];
  for (const l of logs) {
    try {
      const p = TREASURY_IFACE.parseLog({ topics: [...l.topics], data: l.data });
      if (!p) continue;
      const nav = BigInt(p.args.nav);
      const eligibleSupply = BigInt(p.args.eligibleSupply);
      out.push({
        block: l.blockNumber,
        nav,
        eligibleSupply,
        timestamp: Number(p.args.timestamp),
        floorWad: eligibleSupply > 0n ? (nav * WAD) / eligibleSupply : 0n,
      });
    } catch {
      // ignore undecodable
    }
  }
  return out;
}

/**
 * Dev assertion for the spec's central invariant: floorPerToken must never
 * decrease. Returns the offending points so a regression is visible in the UI
 * rather than buried. A non-empty result on mainnet is a serious bug.
 */
export function findFloorRegressions(points: FloorPoint[]): FloorPoint[] {
  const bad: FloorPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].floorWad < points[i - 1].floorWad) bad.push(points[i]);
  }
  return bad;
}

/** Unused-but-exported guard so the hook ABI stays wired for the sweep event. */
export const HOOK_CONTRACT = () =>
  new Contract(PONS.memeHook, MEME_HOOK_ABI, readProvider);
