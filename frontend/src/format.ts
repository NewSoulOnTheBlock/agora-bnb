import { formatEther, formatUnits } from "ethers";

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

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) =>
  String(n).split("").map((d) => SUBSCRIPTS[Number(d)]).join("");

/**
 * Very small numbers (a fresh memecoin's ETH price) need significant digits,
 * not fixed decimals — 0.00 tells the reader nothing.
 *
 * ## Two things this had to fix
 *
 * **It was printing wrong numbers.** The previous implementation ended with
 * `.toPrecision(sig).replace(/0+$/, "")`. On a small value `toPrecision` returns
 * scientific notation — `"2.064e-10"` — and that trailing-zero strip then ate
 * the zero *in the exponent*, rendering it as `2.064e-1`. The floor was being
 * displayed nine orders of magnitude too large. This never touches an exponent
 * because it never produces one.
 *
 * **Scientific notation is unreadable here anyway.** `7.392e-9 ETH` asks the
 * reader to count zeros in their head. A run of four or more leading zeros is
 * compressed into a subscript count instead — `0.0₈7392` — which is the
 * convention DEX interfaces settled on for exactly this problem, and which
 * keeps the unit honestly in ETH rather than silently switching to gwei.
 *
 * Everything is computed from the exact decimal string that `formatEther`
 * produces, so no float rounding enters on the way.
 */
export function fmtSig(v: bigint | null | undefined, sig = 4): string {
  if (v === null || v === undefined) return DASH;

  let s: string;
  try {
    s = formatEther(BigInt(v));
  } catch {
    return DASH;
  }

  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const sign = neg ? "-" : "";

  const [int, frac = ""] = s.split(".");

  // At or above 1: keep `sig` decimal places, rounded, and group the integer.
  if (int !== "0") {
    const [ri, rf] = roundFraction(int, frac, sig);
    const whole = BigInt(ri).toLocaleString("en-US");
    const d = rf.replace(/0+$/, "");
    return sign + (d ? `${whole}.${d}` : whole);
  }

  let zeros = (frac.match(/^0*/)?.[0] ?? "").length;
  const rest = frac.slice(zeros).replace(/0+$/, "");
  if (!rest) return "0";

  let digits = rest.slice(0, sig);
  if (Number(rest[sig] ?? "0") >= 5) {
    const bumped = (BigInt(digits) + 1n).toString();
    if (bumped.length > digits.length) {
      // 0.00009999 → 0.0001: rounding up carried into the zero run, so the run
      // is one shorter. Missing this prints a value ten times too small.
      zeros -= 1;
      digits = bumped.slice(0, sig);
    } else {
      digits = bumped.padStart(digits.length, "0");
    }
  }
  digits = digits.replace(/0+$/, "") || "0";

  // Four or more leading zeros is where a plain decimal stops being countable.
  if (zeros >= 4) return `${sign}0.0${subscript(zeros)}${digits}`;
  return `${sign}0.${"0".repeat(zeros)}${digits}`;
}

/** Round `int.frac` to `decimals` places, carrying into the integer if needed. */
function roundFraction(int: string, frac: string, decimals: number): [string, string] {
  const padded = frac.padEnd(decimals + 1, "0");
  const keep = padded.slice(0, decimals);
  if (Number(padded[decimals]) < 5) return [int, keep];

  const bumped = (BigInt(keep === "" ? "0" : keep) + 1n).toString();
  if (bumped.length > decimals) {
    return [(BigInt(int) + 1n).toString(), decimals ? bumped.slice(1) : ""];
  }
  return [int, bumped.padStart(decimals, "0")];
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

/**
 * A token amount with its own decimals — Beefy legs are not all 18dp (USDG is
 * 6), so formatting them through `formatEther` would be off by a factor of a
 * trillion.
 */
export function fmtUnits(v: bigint | null | undefined, decimals: number, sig = 4): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(formatUnits(v, decimals));
  if (!Number.isFinite(n)) return DASH;
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: sig });
  return n.toPrecision(sig).replace(/e[-+]\d+$/, "");
}
