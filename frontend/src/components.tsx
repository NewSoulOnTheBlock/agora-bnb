import type { ReactNode } from "react";
import { formatUnits } from "ethers";
import { DASH, fmtGrouped } from "./format";

/**
 * The "balance …" line above an amount input, made clickable.
 *
 * Typing out 10,000,000 by hand to unstake everything is a real cost and a real
 * source of off-by-a-digit mistakes. Clicking the figure fills the field with
 * the **exact** balance — `formatUnits`, not the grouped display string — so
 * the value that goes back through `parseUnits` is bit-for-bit what the wallet
 * holds and "max" never leaves dust behind.
 *
 * `decimals` is required rather than defaulted: the one balance on this site
 * that is not 18dp is stTORII, and that is precisely the field where a wrong
 * default would be least visible.
 */
export function Balance({
  label = "balance", value, decimals, unit, frac = 2, onPick,
}: {
  label?: string;
  value: bigint | null;
  decimals: number;
  unit: string;
  frac?: number;
  onPick?: (exact: string) => void;
}) {
  const usable = value !== null && value > 0n && !!onPick;
  const text = (
    <>
      {label} <b>{value !== null ? fmtGrouped(value, frac, decimals) : DASH}</b> {unit}
    </>
  );

  if (!usable) return <span className="bal">{text}</span>;

  return (
    <button
      type="button"
      className="bal pick"
      title={`Use the full balance — ${formatUnits(value, decimals)} ${unit}`}
      onClick={() => onPick(formatUnits(value, decimals))}
    >
      {text}
      <span className="maxtag">MAX</span>
    </button>
  );
}

export function Panel({
  label, id, children, tight, right,
}: {
  label?: string;
  id?: string;
  children: ReactNode;
  tight?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className="panel">
      <div className={`panel-inner${tight ? " tight" : ""}`}>
        {label && (
          <p className="label">
            {label}
            {id && <span className="id">{id}</span>}
            {right && <><span style={{ flex: 1 }} />{right}</>}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * A stat that knows the difference between "zero" and "not known yet".
 * Passing `value={null}` renders an explicit unavailable state — never a 0 that
 * a reader could mistake for a measurement.
 */
export function Stat({
  k, value, note, unit, usd,
}: {
  k: string;
  value: string | null;
  note?: string;
  unit?: string;
  /** Optional dollar line under the readout. Display only — never a source of
   *  truth, because the rate behind it is a spot DEX price. */
  usd?: string | null;
}) {
  const na = value === null || value === DASH;
  return (
    <Panel tight>
      <div className="stat">
        <div className="k">{k}</div>
        <div className={`v${na ? " na" : ""}`}>
          {na ? "unavailable" : value}
          {!na && unit && <span className="unit">{unit}</span>}
        </div>
        {usd && <div className="usd">≈ {usd}</div>}
        {note && <div className="note">{note}</div>}
      </div>
    </Panel>
  );
}

export function Row({
  k, children, na,
}: {
  k: string;
  children: ReactNode;
  na?: boolean;
}) {
  return (
    <div className="row">
      <span className="rk">{k}</span>
      <span className={`rv${na ? " na" : ""}`}>{children}</span>
    </div>
  );
}

export function Dot({ kind }: { kind: "live" | "ok" | "warn" | "off" }) {
  return <span className={`dot ${kind}`} />;
}

export function Pill({
  children, warn,
}: {
  children: ReactNode;
  warn?: boolean;
}) {
  return <span className={`pill${warn ? " warn" : ""}`}>{children}</span>;
}
