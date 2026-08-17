import type { ReactNode } from "react";
import { DASH } from "./format";

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
  k, value, note, unit,
}: {
  k: string;
  value: string | null;
  note?: string;
  unit?: string;
}) {
  const na = value === null || value === DASH;
  return (
    <Panel tight>
      <div className="stat">
        <div className="k">{k}</div>
        <div className={`v${na ? " na" : ""}`}>
          {na ? "not deployed" : value}
          {!na && unit && <span className="unit">{unit}</span>}
        </div>
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
