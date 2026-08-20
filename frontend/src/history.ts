import { Contract, id as topicId, Interface, type Log } from "ethers";
import { logProvider, MAX_LOG_SPAN, MAX_LOG_DEPTH, HAS_ARCHIVE, TORII, ZERO } from "./chain";
import { TREASURY_ABI } from "./abis";

/**
 * Chunked backwards log scanner, and the wall it runs into on BSC.
 *
 * On Robinhood Chain this walked ~500k blocks per request across several
 * chunks, covering days. BNB Chain gives far less, and the numbers were
 * measured rather than assumed (2026-08-20, eight public endpoints):
 *
 *   - Most public BSC RPCs refuse `eth_getLogs` outright. `bsc-dataseed.*`,
 *     `1rpc.io`, `blastapi`, `blockrazor` all decline; `meowrpc` answers
 *     "method not supported".
 *   - The one that serves it, `bsc-rpc.publicnode.com`, is **not an archive
 *     node**: past roughly **9,960 blocks** it answers "Archive requests
 *     require a personal token".
 *   - Its other limit is by *result count*, not block span — "query exceeds
 *     max results 20000" — which only bites on very busy contracts.
 *
 * BSC blocks are 0.45 seconds, so ~9,960 blocks is about **75 minutes**. Every
 * log-backed view on this chain sees a little over an hour of history and no
 * more, until `VITE_BSC_LOG_RPC_URL` points at an archive endpoint.
 *
 * `reachedWall` reports that rather than hiding it. A caller must be able to
 * tell "no trades happened" from "the node would not say", because rendering
 * the second as the first is how an empty chart starts looking like a fact.
 */
let lastScanRefused = 0;
let lastScanChunks = 0;
let lastScanClamped = false;

/**
 * Whether the last scan hit the archive wall.
 *
 * Deliberately a module-level reading rather than part of the return value:
 * every caller already destructures a `Log[]`, and threading a second field
 * through all of them to answer one question would be worse than one honest
 * global read immediately after the call.
 */
export function lastScanReachedWall(): boolean {
  return lastScanChunks > 0 && (lastScanRefused > 0 || lastScanClamped);
}

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

  const head = await logProvider.getBlockNumber();

  // The ranges are a pure function of `head`, so they do not need to be walked
  // one at a time. The previous version awaited each chunk before computing the
  // next, which made the Reserve page pay `maxChunks` sequential round-trips of
  // a 450k-block getLogs — and the page fires two of these scans at once, so
  // the wait was up to ten heavy queries end to end. Issuing them together
  // collapses that to a single wave.
  // Never request a range the endpoint has already said it will not serve.
  // See `MAX_LOG_DEPTH`: without this, most chunks came back 403 every load.
  const floor = Math.max(0, head - MAX_LOG_DEPTH);

  const ranges: { from: number; to: number }[] = [];
  let to = head;
  for (let i = 0; i < maxChunks && to >= floor; i++) {
    const from = Math.max(floor, to - spanPerChunk + 1);
    ranges.push({ from, to });
    if (from === floor) break;
    to = from - 1;
  }

  // A rejected chunk (rate limit, span too wide) contributes nothing rather
  // than discarding the chunks that did succeed.
  let refused = 0;
  const settled = await Promise.all(
    ranges.map(({ from, to: hi }) =>
      logProvider
        .getLogs({ address, topics, fromBlock: from, toBlock: hi })
        .catch(() => {
          refused++;
          return [] as Log[];
        })
    )
  );
  lastScanRefused = refused;
  lastScanChunks = ranges.length;
  // Truncated on purpose is still truncated: a caller charting this needs to
  // know the window was capped even when every request succeeded.
  lastScanClamped = !HAS_ARCHIVE && floor > 0;

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

/**
 * `ToriiVault` recognises tax by balance delta and says so.
 *
 *   RevenueRecognized(uint256 amount, uint256 baseline)
 *
 * Non-indexed, both words in `data`. `baseline` is the vault balance the delta
 * was measured against; it is read here only to keep the decode honest about
 * the event's real shape.
 */
const T_REVENUE = topicId("RevenueRecognized(uint256,uint256)");

/** `Converted(uint256 tokensIn, uint256 quoteOut)` — the TORII leg being sold. */
const T_CONVERTED = topicId("Converted(uint256,uint256)");

/**
 * Tax history, read from the vault rather than from a pool hook.
 *
 * ## Why the currency filter is gone
 *
 * On Pons this function existed mostly to *filter*: the hook emitted
 * `HookFeeCollected` for both legs of every swap, and summing across them added
 * ether to token units — a bug that once printed ~8.8M "ETH". Flap's vault has
 * no such ambiguity. `RevenueRecognized` is BNB, always, because the vault's
 * quote token is native BNB.
 *
 * The TORII leg is a separate event, `Converted`, and it is genuinely separate:
 * post-graduation tax arrives as TORII, which the Treasury marks at zero, so it
 * is not revenue until it has been sold. Keeping the two apart is the same
 * lesson the currency filter taught, expressed in the contract instead of in
 * the reader.
 *
 * `_pid` is ignored — the vault is per-token, not per-pool — and kept only so
 * `useReads` calls the same shape on both chains.
 */
export async function readTaxHistory(
  _pid: string,
  _currency: string = ZERO,
  maxChunks = 4
): Promise<TaxEvent[]> {
  if (!deployed(TORII.feeSink)) return [];

  const logs = await scanLogsBackwards({
    address: TORII.feeSink,
    topics: [T_REVENUE],
    maxChunks,
  });

  let running = 0n;
  const out: TaxEvent[] = [];
  for (const l of logs) {
    try {
      // Two uint256 words: amount, then baseline.
      const amount = BigInt("0x" + l.data.slice(2, 66));
      running += amount;
      out.push({
        block: l.blockNumber,
        currency: ZERO,
        feeAmount: amount,
        taxAmount: amount,
        cumulativeTax: running,
      });
    } catch {
      // One malformed entry must not void the series.
    }
  }
  return out;
}

/**
 * The two legs, separated: BNB recognised directly, and TORII sold into BNB.
 *
 * Keyed by the asset the tax *arrived* as, which is the distinction that
 * matters — `Converted` output is already counted in `RevenueRecognized`, so
 * these are reported side by side rather than summed.
 */
export async function readTaxByCurrency(
  _pid: string,
  maxChunks = 4
): Promise<Map<string, { count: number; total: bigint }>> {
  const m = new Map<string, { count: number; total: bigint }>();
  if (!deployed(TORII.feeSink)) return m;

  const [revenue, converted] = await Promise.all([
    scanLogsBackwards({ address: TORII.feeSink, topics: [T_REVENUE], maxChunks }),
    scanLogsBackwards({ address: TORII.feeSink, topics: [T_CONVERTED], maxChunks }),
  ]);

  const add = (key: string, v: bigint) => {
    const e = m.get(key) ?? { count: 0, total: 0n };
    e.count += 1;
    e.total += v;
    m.set(key, e);
  };

  for (const l of revenue) {
    try { add(ZERO, BigInt("0x" + l.data.slice(2, 66))); } catch { /* skip */ }
  }
  for (const l of converted) {
    // tokensIn is the first word — the TORII actually sold.
    try { add(TORII.token, BigInt("0x" + l.data.slice(2, 66))); } catch { /* skip */ }
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
  if (!TORII.treasury || TORII.treasury === ZERO) return [];
  const logs = await scanLogsBackwards({
    address: TORII.treasury,
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

/** The tax vault, for anyone who wants to read it directly. */
export const VAULT_CONTRACT = () =>
  new Contract(
    TORII.feeSink,
    [
      "function pendingQuote() view returns (uint256)",
      "function pendingTaxToken() view returns (uint256)",
      "function cumulativeForwarded() view returns (uint256)",
      "function cumulativeConverted() view returns (uint256)",
    ],
    logProvider
  );

// ---------------------------------------------------------------------------
// Income history — what stakers have actually been paid, and over what window
// ---------------------------------------------------------------------------

export type IncomeHistory = {
  /** Every `IncomeDistributed` amount, summed. */
  total: bigint;
  /** How many distributions have happened. */
  count: number;
  /** Seconds between the first and the last one. */
  windowSec: number;
};

/**
 * Reads the distribution history so the Stake page can state a **measured**
 * return rather than a projected one.
 *
 * The distinction matters and the repo already took a side on it: the Stake
 * page's own copy says no projected APY is shown because "a forecast would be
 * fiction". A trailing figure is not a forecast — it is arithmetic on events
 * that already happened — so long as the window is stated next to it and never
 * annualised. Eighteen hours of launch volume extrapolated to a year is exactly
 * the fiction that rule exists to prevent.
 */
export async function readIncomeHistory(maxChunks = 5): Promise<IncomeHistory | null> {
  if (!deployed(TORII.treasury)) return null;

  const logs = await scanLogsBackwards({
    address: TORII.treasury,
    topics: [topicId("IncomeDistributed(uint256)")],
    maxChunks,
  });
  if (!logs.length) return null;

  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber);
  let total = 0n;
  for (const l of sorted) {
    try {
      total += BigInt(l.data);
    } catch {
      // A malformed entry should not void the series.
    }
  }

  let windowSec = 0;
  if (sorted.length > 1) {
    const [a, b] = await Promise.all([
      logProvider.getBlock(sorted[0].blockNumber).catch(() => null),
      logProvider.getBlock(sorted[sorted.length - 1].blockNumber).catch(() => null),
    ]);
    if (a && b) windowSec = Math.max(0, b.timestamp - a.timestamp);
  }

  return { total, count: sorted.length, windowSec };
}

function deployed(a: string): boolean {
  return !!a && a !== ZERO;
}
