import { formatEther } from "ethers";

export const DASH = "—";

export function shortAddr(a?: string | null): string {
  if (!a) return DASH;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** WAD bigint → trimmed decimal string. */
export function fmt(v: bigint | number | string | null | undefined, maxFrac = 6): string {
  if (v === null || v === undefined) return DASH;
  const s = formatEther(BigInt(v));
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

/** WAD bigint → grouped decimal with fixed places, e.g. 1,234.56 */
export function fmtGrouped(v: bigint | null | undefined, frac = 2): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(formatEther(v));
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

/**
 * Very small numbers (a fresh memecoin's ETH price) need significant digits,
 * not fixed decimals — 0.00 tells the reader nothing.
 */
export function fmtSig(v: bigint | null | undefined, sig = 4): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(formatEther(v));
  if (!Number.isFinite(n) || n === 0) return n === 0 ? "0" : DASH;
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: sig });
  return n.toPrecision(sig).replace(/0+$/, "").replace(/\.$/, "");
}

export function bpsToPct(bps: bigint | number | null | undefined): string {
  if (bps === null || bps === undefined) return DASH;
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

/** Signed percentage from a ratio, e.g. premium of price over floor. */
export function signedPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function eqAddr(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function timeAgo(tsSeconds: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
