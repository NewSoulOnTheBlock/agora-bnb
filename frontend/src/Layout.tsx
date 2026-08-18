import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dot, Pill } from "./components";
import { shortAddr } from "./format";
import type { Wallet } from "./eth";
import { PixelIcon, type IconName } from "./win98/pixel";
import { isEnabled as soundOn, setEnabled as setSoundOn, play } from "./win98/sound";
import { AGORA, EXPLORER, SUITS_STAKING_ENABLED } from "./chain";

export type Tab = "about" | "floor" | "trade" | "stake" | "suits" | "redeem";

/**
 * The tab list is unchanged from the previous theme — same ids, same order,
 * same "explain before you dashboard" reasoning. Only an icon was added.
 */
export const TABS: {
  id: Tab; label: string; icon: IconName; kana: string;
  disabled?: boolean; why?: string;
}[] = [
  { id: "about", label: "What is this?", icon: "help", kana: "ガイド" },
  { id: "floor", label: "Reserve", icon: "coins", kana: "リザーブ" },
  { id: "trade", label: "Trade", icon: "chart", kana: "トレード" },
  { id: "stake", label: "Stake", icon: "lock", kana: "ステーク" },
  {
    id: "suits", label: "Suits", icon: "tie", kana: "スーツ",
    disabled: !SUITS_STAKING_ENABLED,
    why: "Suits staking is unavailable: the collection only permits allowlisted operators to move tokens, and this vault is not on that list.",
  },
  { id: "redeem", label: "Redeem", icon: "flame", kana: "リディーム" },
];

/** Routes a user must not reach, because the underlying action cannot succeed. */
export const DISABLED_TABS = new Set(TABS.filter((t) => t.disabled).map((t) => t.id));

/**
 * Status-bar ticker.
 *
 * The brief asked for My Chemical Romance lyrics. Those are copyrighted, and
 * reproducing song lyrics inside a shipped product is not something to do
 * casually — so these are original lines written to the same register, mixed
 * with facts that are actually true of the contracts. The protocol lines are
 * the ones worth reading; the rest is set dressing.
 */
const TICKER = [
  "ＷＥＬＣＯＭＥ ＴＯ ＴＨＥ ＡＧＯＲＡ",
  "the tax never sleeps · 4% on every buy and every sell",
  "アゴラ · 準備金 · 償還",
  "burn it and the floor rises for everyone who stayed",
  "we are not a bank · we are a marble pot with a queue",
  "no keeper moves the corpus · every allocation is a signature",
  "SO LONG AND GOODNIGHT, MERCENARY LIQUIDITY",
  "chain 4663 · robinhood · verified on-chain",
  "the columns were always on brand",
];

const TITLES: Record<Tab, string> = {
  about: "What is this?",
  floor: "Reserve",
  trade: "Trade",
  stake: "Stake",
  suits: "Suits",
  redeem: "Redeem",
};

/* ==========================================================================
   Boot splash
   A DOS-style POST screen on first load only. Held in sessionStorage so it
   does not replay every time the hash route changes — a startup sequence you
   cannot get past is a novelty the second time and an obstacle the third.
   ========================================================================== */
function Boot() {
  return (
    <div className="boot" aria-hidden="true">
      <div className="boot-art chrome">ＡＧＯＲＡ</div>
      <div className="boot-kana kana">アゴラ・準備金・システム起動</div>
      <div className="boot-rule meander" />
      <div className="bright">AGORA BIOS v4.663</div>
      <div>Copyright (C) 2026, Agora Collective</div>
      <br />
      <div>Chain . . . . . . . . 4663 Robinhood (Arbitrum Orbit)</div>
      <div>Numeraire . . . . . . ETH, no oracle</div>
      <div>Reserve . . . . . . . Treasury 0x7A3B…6C5c <b className="okc">OK</b></div>
      <div>Redemption. . . . . . Redeemer 0x6315…84C0 <b className="okc">OK</b></div>
      <div>Yield sleeve. . . . . 0 bps, no adapters</div>
      <div>Marble. . . . . . . . loaded</div>
      <br />
      <div>Starting AGORA 98<span className="cur">_</span></div>
    </div>
  );
}

/* ==========================================================================
   Dropdown menu
   ========================================================================== */
type MenuEntry =
  | { kind: "item"; label: string; onClick?: () => void; disabled?: boolean; accel?: string }
  | { kind: "sep" };

function Menu({
  label, accessKey, entries, open, setOpen,
}: {
  label: string;
  accessKey: string;
  entries: MenuEntry[];
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const idx = label.toLowerCase().indexOf(accessKey.toLowerCase());
  return (
    <div style={{ position: "relative" }}>
      <button
        className="menu-item"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => { play("click"); setOpen(!open); }}
        onMouseEnter={(e) => {
          // Win98 behaviour: once one menu is open, hovering the next opens it.
          if (!open && (e.currentTarget.parentElement?.parentElement?.querySelector('[aria-expanded="true"]'))) {
            setOpen(true);
          }
        }}
      >
        {idx >= 0 ? (
          <>
            {label.slice(0, idx)}
            <u>{label[idx]}</u>
            {label.slice(idx + 1)}
          </>
        ) : label}
      </button>

      {open && (
        <div className="menu-pop" role="menu" style={{ top: "100%", left: 0 }}>
          {entries.map((e, i) =>
            e.kind === "sep" ? (
              <div className="sep" key={i} />
            ) : (
              <button
                key={i}
                role="menuitem"
                disabled={e.disabled}
                onClick={() => { play("click"); e.onClick?.(); setOpen(false); }}
              >
                <span>{e.label}</span>
                {e.accel && <span className="accel">{e.accel}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Modal dialog
   ========================================================================== */
function Dialog({
  title, icon, children, onClose,
}: {
  title: string;
  icon: IconName;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="win dialog">
        <div className="titlebar">
          <span className="t-text">{title}</span>
          <span className="t-btns">
            <button className="tbtn close" aria-label="Close" onClick={onClose} />
          </span>
        </div>
        <div className="client">
          <div className="dialog-body">
            <PixelIcon name={icon} size={32} />
            <div>{children}</div>
          </div>
          <div className="dialog-btns">
            <button className="btn primary" onClick={onClose} autoFocus>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   Layout
   The prop signature is deliberately unchanged from the previous theme, so
   `App.tsx` did not need editing — the whole desktop lives in here.
   ========================================================================== */
export default function Layout({
  tab, setTab, wallet, status, children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  wallet: Wallet;
  status?: ReactNode;
  children: ReactNode;
}) {
  const [booting, setBooting] = useState(() => {
    try { return sessionStorage.getItem("agora98:booted") !== "1"; } catch { return true; }
  });
  const [minimised, setMinimised] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "close" | "about" | "bin" | "copied">(null);
  const [sound, setSound] = useState(soundOn);
  const [clock, setClock] = useState(() => new Date());
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!booting) return;
    try { sessionStorage.setItem("agora98:booted", "1"); } catch { /* private mode */ }
    const t = setTimeout(() => setBooting(false), 2100);
    return () => clearTimeout(t);
  }, [booting]);

  // Win98's clock ticked minutes, not seconds.
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 20_000);
    return () => clearInterval(t);
  }, []);

  // Any click outside a popup dismisses it, which is the one behaviour that
  // makes menus feel native rather than like toggles.
  useEffect(() => {
    if (!startOpen && !openMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".start-menu, .start-btn, .menu-pop, .menu-item")) return;
      setStartOpen(false);
      setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [startOpen, openMenu]);

  const go = (t: Tab) => {
    // A disabled route is unreachable from every entry point, not just the tab
    // strip — the desktop icon and the Start menu call through here too.
    if (DISABLED_TABS.has(t)) { play("error"); return; }
    play("click");
    setTab(t);
    setMinimised(false);
    setStartOpen(false);
    setOpenMenu(null);
    // Returning to the top matches opening a fresh window rather than
    // silently landing halfway down the previous page's scroll.
    shellRef.current?.scrollTo({ top: 0 });
  };

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundOn(next); // plays a confirmation ding when switched on
  };

  /** Every deployed address, as pasteable text. The explorer base is included
   *  so the list is useful somewhere other than this page. */
  const copyAddresses = () => {
    const lines = [
      "AGORA — chain 4663 (Robinhood)",
      `explorer     ${EXPLORER}`,
      `token        ${AGORA.token}`,
      `curve        ${AGORA.curve}`,
      `feeSink      ${AGORA.feeSink}`,
      `treasury     ${AGORA.treasury}`,
      `stakedAgora  ${AGORA.stakedAgora}`,
      `redeemer     ${AGORA.redeemer}`,
      `stakedSuits  ${AGORA.stakedSuits}`,
      `distributor  ${AGORA.distributor}`,
    ].join("\n");

    navigator.clipboard?.writeText(lines).then(
      () => { play("ding"); setDialog("copied"); },
      () => { play("error"); }
    );
  };

  const time = clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="desktop">
      {booting && <Boot />}

      {/* ---- the scene: sun, grid, horizon, frieze, columns ----
           Decorative only, so it is aria-hidden and takes no pointer events. */}
      <div className="scene" aria-hidden="true">
        <div className="vw-sun" />
        <div className="vw-grid" />
        <div className="vw-horizon" />
        <div className="frieze-band">
          <picture>
            <source media="(max-width: 900px)" srcSet="/frieze-sm.jpg" />
            <img src="/frieze.jpg" alt="" loading="eager" decoding="async" />
          </picture>
        </div>
        <div className="column left">
          <div className="cap" />
          <div className="shaft" />
          <div className="base" />
        </div>
        <div className="column right">
          <div className="cap" />
          <div className="shaft" />
          <div className="base" />
        </div>
      </div>

      {/* ---- desktop icons ---- */}
      <div className="desk-icons">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="desk-icon"
            aria-current={tab === t.id && !minimised}
            onClick={() => go(t.id)}
            disabled={t.disabled}
            title={t.why ?? t.label}
          >
            <PixelIcon name={t.icon} size={32} />
            <span>
              {t.label}
              <span className="kana">{t.kana}</span>
            </span>
          </button>
        ))}

        {/* The one desktop icon that is not a tab. Burned supply really is a
            recycle bin here: redemption destroys AGORA permanently. */}
        <button className="desk-icon" onClick={() => { play("click"); setDialog("bin"); }} title="Recycle Bin">
          <PixelIcon name="recycle" size={32} />
          <span>Recycle Bin</span>
        </button>
      </div>

      {/* ---- the application window ---- */}
      {!minimised && (
        <div
          className="win win-main"
          style={
            maximised
              ? {
                  top: 0, left: 0, right: 0,
                  bottom: "var(--taskbar-h)",
                  // The window is content-height by default; maximising has to
                  // clear that cap or it stays short.
                  maxHeight: "none",
                  width: "100%",
                  margin: 0,
                }
              : undefined
          }
        >
          <div className="titlebar">
            <PixelIcon name="computer" size={16} />
            <span className="t-text">
              <span className="chrome">ＡＧＯＲＡ ９８</span>
              <span className="kana" style={{ margin: "0 6px", opacity: 0.8 }}>アゴラ</span>
              — {TITLES[tab]}
            </span>
            <span className="t-btns">
              <button
                className="tbtn min"
                aria-label="Minimise"
                onClick={() => { play("close"); setMinimised(true); }}
              />
              <button
                className="tbtn max"
                aria-label={maximised ? "Restore" : "Maximise"}
                onClick={() => { play("click"); setMaximised(!maximised); }}
              />
              <button
                className="tbtn close"
                aria-label="Close"
                onClick={() => { play("error"); setDialog("close"); }}
              />
            </span>
          </div>

          <div className="menubar" onMouseLeave={() => setOpenMenu(null)}>
            <Menu
              label="File" accessKey="F"
              open={openMenu === "file"} setOpen={(v) => setOpenMenu(v ? "file" : null)}
              entries={[
                { kind: "item", label: "Open Reserve", onClick: () => go("floor") },
                { kind: "item", label: "Open Trade", onClick: () => go("trade") },
                { kind: "sep" },
                { kind: "item", label: "Copy addresses", onClick: copyAddresses },
                { kind: "sep" },
                { kind: "item", label: "Close", onClick: () => setDialog("close") },
              ]}
            />
            <Menu
              label="View" accessKey="V"
              open={openMenu === "view"} setOpen={(v) => setOpenMenu(v ? "view" : null)}
              entries={[
                { kind: "item", label: maximised ? "Restore window" : "Maximise window", onClick: () => setMaximised(!maximised) },
                { kind: "item", label: "Minimise window", onClick: () => setMinimised(true) },
                { kind: "sep" },
                { kind: "item", label: sound ? "Sounds: On" : "Sounds: Off", onClick: toggleSound },
              ]}
            />
            <Menu
              label="Wallet" accessKey="W"
              open={openMenu === "wallet"} setOpen={(v) => setOpenMenu(v ? "wallet" : null)}
              entries={[
                {
                  kind: "item",
                  label: wallet.account ? shortAddr(wallet.account) : "Connect…",
                  disabled: !!wallet.account || !wallet.hasProvider,
                  onClick: wallet.connect,
                },
                {
                  kind: "item",
                  label: "Switch to chain 4663",
                  disabled: !wallet.account || wallet.onCorrectChain,
                  onClick: wallet.switchChain,
                },
              ]}
            />
            <Menu
              label="Help" accessKey="H"
              open={openMenu === "help"} setOpen={(v) => setOpenMenu(v ? "help" : null)}
              entries={[
                { kind: "item", label: "What is this?", onClick: () => go("about") },
                { kind: "sep" },
                { kind: "item", label: "About AGORA 98…", onClick: () => setDialog("about") },
              ]}
            />
          </div>

          {/* ---- tab control ---- */}
          <div className="tabstrip" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="tab"
                role="tab"
                aria-selected={tab === t.id}
                disabled={t.disabled}
                title={t.why}
                onClick={() => go(t.id)}
              >
                <PixelIcon name={t.icon} size={16} />
                {t.label}
                <span className="kana">{t.kana}</span>
              </button>
            ))}
          </div>

          <div className="client" ref={shellRef} role="tabpanel">
            <div className="page">{children}</div>
          </div>

          {/* ---- status bar ---- */}
          <div className="statusbar">
            <div className="status-pane grow">
              {status ?? (
                <div className="marquee">
                  <span>{TICKER.join("　　◆　　")}</span>
                </div>
              )}
            </div>
            <div className="status-pane">
              {wallet.account ? (
                <Pill>
                  <Dot kind={wallet.onCorrectChain ? "ok" : "warn"} />
                  {wallet.onCorrectChain ? shortAddr(wallet.account) : "wrong network"}
                </Pill>
              ) : (
                <button className="btn ghost" onClick={wallet.connect} disabled={wallet.connecting}>
                  {wallet.connecting ? "connecting…" : wallet.hasProvider ? "Connect" : "No wallet"}
                </button>
              )}
            </div>
            <div className="status-pane mono">
              <PixelIcon name="globe" size={16} />
              rpc.mainnet.chain.robinhood.com
            </div>
          </div>
        </div>
      )}

      {/* ---- dialogs ---- */}
      {dialog === "close" && (
        <Dialog title="AGORA 98" icon="error" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            This program cannot be closed. It is a web page.
          </p>
          <p style={{ margin: "8px 0 0" }}>
            The reserve keeps accruing whether or not anyone is looking at it.
          </p>
        </Dialog>
      )}

      {dialog === "about" && (
        <Dialog title="About AGORA 98" icon="info" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            <b>AGORA 98</b><br />
            A 4% trade tax funding a reserve on Robinhood Chain.
          </p>
          <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
            Every buy and sell pays 4%. Part of it pays people who stake; the rest sits in the
            reserve, and any holder may burn AGORA for a share of it.
          </p>
          <p style={{ margin: "8px 0 0", color: "#505050" }}>
            The interface is a tribute. The contracts are real — addresses verified on chain 4663.
          </p>
        </Dialog>
      )}

      {dialog === "bin" && (
        <Dialog title="Recycle Bin" icon="recycle" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            <b>Empty — and it cannot be restored.</b>
          </p>
          <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
            Redeeming AGORA burns it at the moment you ask, not when you collect. The supply is
            fixed by the Pons factory and there is no mint function, so nothing that goes in here
            ever comes back.
          </p>
          <p style={{ margin: "8px 0 0", color: "#4a5a50" }}>
            That is what makes each redemption raise the floor for everyone who stayed.
          </p>
        </Dialog>
      )}

      {dialog === "copied" && (
        <Dialog title="Copy addresses" icon="floppy" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>Every deployed address copied to the clipboard.</p>
          <p style={{ margin: "8px 0 0", color: "#4a5a50" }}>
            Token, curve, fee sink, treasury, staking, redeemer and distributor — with the
            explorer base, so the list is useful away from this page.
          </p>
        </Dialog>
      )}

      {/* ---- start menu ---- */}
      {startOpen && (
        <div className="start-menu" role="menu">
          <div className="start-banner">
            AGORA<b>98</b>
          </div>
          <div className="start-items">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="menuitem"
                disabled={t.disabled}
                title={t.why}
                onClick={() => go(t.id)}
              >
                <PixelIcon name={t.icon} size={24} />
                {t.label}
              </button>
            ))}
            <div className="sep" />
            <button role="menuitem" onClick={() => { play("click"); toggleSound(); setStartOpen(false); }}>
              <PixelIcon name="computer" size={24} />
              {sound ? "Turn sounds off" : "Turn sounds on"}
            </button>
            <button role="menuitem" onClick={() => { play("click"); setDialog("about"); setStartOpen(false); }}>
              <PixelIcon name="info" size={24} />
              About AGORA 98…
            </button>
          </div>
        </div>
      )}

      {/* ---- taskbar ---- */}
      <div className="taskbar">
        <button
          className="start-btn"
          aria-expanded={startOpen}
          aria-haspopup="menu"
          onClick={() => { play("click"); setStartOpen(!startOpen); setOpenMenu(null); }}
        >
          <PixelIcon name="computer" size={18} />
          Start
        </button>
        <div className="task-sep" />

        <div className="task-btns">
          <button
            className="task-btn"
            aria-pressed={!minimised}
            onClick={() => { play("click"); setMinimised(minimised ? false : true); }}
          >
            <PixelIcon name="computer" size={16} />
            AGORA 98 — {TITLES[tab]}
          </button>
        </div>

        <div className="tray">
          <button
            onClick={toggleSound}
            aria-pressed={sound}
            title={sound ? "Sounds on — click to mute" : "Sounds off — click to enable"}
          >
            <span className={`spk ${sound ? "on" : "off"}`} />
          </button>
          <Dot kind={wallet.account ? (wallet.onCorrectChain ? "ok" : "warn") : "off"} />
          <span className="clock">{time}</span>
        </div>
      </div>
    </div>
  );
}

/** Shown on any page whose contracts aren't deployed yet. Unchanged in substance. */
export function AwaitingDeployment({
  what, why, phase,
}: {
  what: string;
  why: string;
  phase: string;
}) {
  return (
    <div className="notice">
      <div>
        <b>{what} is not deployed.</b> {why} The interface below is fully wired against the
        contract ABI in <code>src/abis.ts</code> — filling in the address in <code>src/chain.ts</code>
        {" "}activates it with no other change. Build order: <b>{phase}</b>.
      </div>
    </div>
  );
}
