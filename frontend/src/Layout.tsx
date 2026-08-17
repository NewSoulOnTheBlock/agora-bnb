import type { ReactNode } from "react";
import { Dot, Pill } from "./components";
import { shortAddr } from "./format";
import type { Wallet } from "./eth";

export type Tab = "about" | "floor" | "trade" | "stake" | "suits" | "redeem";

export const TABS: { id: Tab; label: string }[] = [
  // First, deliberately: a newcomer landing here should meet the explanation
  // before the dashboard.
  { id: "about", label: "What is this?" },
  { id: "floor", label: "Reserve" },
  { id: "trade", label: "Trade" },
  { id: "stake", label: "Stake" },
  { id: "suits", label: "Suits" },
  { id: "redeem", label: "Redeem" },
];

export default function Layout({
  tab, setTab, wallet, status, children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  wallet: Wallet;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="atmos" />
      <div className="rails" />
      <div className="shell">
        <nav className="nav">
          <div className="nav-inner">
            <a className="brand" href="#floor" aria-label="AGORA — home">
              <img
                className="mark"
                src="/logo.png"
                srcSet="/logo.png 1x, /logo-2x.png 2x"
                width={38}
                height={38}
                alt=""
                decoding="async"
              />
              AGORA <span>/ reserve</span>
            </a>
            <div className="nav-spacer" />
            <div className="tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {status}
            {wallet.account ? (
              <Pill>
                <Dot kind={wallet.onCorrectChain ? "ok" : "warn"} />
                {wallet.onCorrectChain ? shortAddr(wallet.account) : "wrong network"}
              </Pill>
            ) : (
              <button className="tab" onClick={wallet.connect} disabled={wallet.connecting}>
                {wallet.connecting ? "connecting…" : wallet.hasProvider ? "Connect" : "No wallet"}
              </button>
            )}
          </div>
        </nav>
        {children}
        <div className="foot">
          <span>chain 4663 · robinhood</span>
          <span>rpc rpc.mainnet.chain.robinhood.com</span>
          <span>treasury allocation is manual · no keeper moves corpus funds</span>
          <span>addresses verified 2026-08-17 · spec §14</span>
        </div>
      </div>

      {/* The frieze runs full-bleed beneath everything, outside `.shell` so it
          is not constrained by the content width. Decorative only — it carries
          no information, so it is empty-alt and aria-hidden. */}
      <footer className="frieze" aria-hidden="true">
        <picture>
          <source media="(max-width: 900px)" srcSet="/frieze-sm.jpg" />
          <img src="/frieze.jpg" alt="" loading="lazy" decoding="async" />
        </picture>
      </footer>
    </>
  );
}

/** Shown on any page whose contracts aren't deployed yet. */
export function AwaitingDeployment({
  what, why, phase,
}: {
  what: string;
  why: string;
  phase: string;
}) {
  return (
    <div className="notice">
      <b>{what} is not deployed.</b> {why} The interface below is fully wired against the
      contract ABI in <code>src/abis.ts</code> — filling in the address in <code>src/chain.ts</code>
      {" "}activates it with no other change. Build order: <b>{phase}</b>.
    </div>
  );
}
