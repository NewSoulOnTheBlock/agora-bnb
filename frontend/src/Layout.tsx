import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dot, Pill } from "./components";
import { shortAddr } from "./format";
import type { Wallet } from "./eth";
import { PixelIcon, type IconName } from "./win98/pixel";
import Dino from "./win98/Dino";
import { useDrag, withDrag } from "./win98/useDrag";
import TaxWatch from "./win98/TaxWatch";
import { SystemProperties, WindowsUpdate, PrintQueue } from "./win98/Windows";
import { MyComputer, NetworkNeighborhood, Notepad } from "./win98/Explorer";
import { Fortune } from "./win98/Fortune";
import { Gomoku } from "./win98/Gomoku";
import { Hongbao } from "./win98/Hongbao";
import { Penguin } from "./win98/Penguin";
import { Mahjong } from "./win98/Mahjong";
import { CURVE_TRADE_URL } from "./curve";
import { isEnabled as soundOn, setEnabled as setSoundOn, play } from "./win98/sound";
import { TORII, EXPLORER, GMGN_URL, RPC_URL } from "./chain";

/** The endpoint, as a hostname. Derived so the status bar cannot go stale. */
const RPC_HOST = (() => {
  try { return new URL(RPC_URL).host; } catch { return RPC_URL; }
})();

export type Tab = "about" | "floor" | "deployed" | "trade" | "stake" | "redeem";

/**
 * The tab list is unchanged from the previous theme — same ids, same order,
 * same "explain before you dashboard" reasoning. Only an icon was added.
 */
export const TABS: {
  id: Tab; label: string; icon: IconName; hanzi: string;
  disabled?: boolean; why?: string;
  /** Kept out of the UI entirely, rather than shown greyed. */
  hidden?: boolean;
}[] = [
  { id: "about", label: "What is this?", icon: "help", hanzi: "指南" },
  { id: "floor", label: "Reserve", icon: "coins", hanzi: "儲備" },
  { id: "deployed", label: "Deployed", icon: "harddrive", hanzi: "部署" },
  { id: "trade", label: "Trade", icon: "chart", hanzi: "交易" },
  { id: "stake", label: "Stake", icon: "lock", hanzi: "質押" },
  { id: "redeem", label: "Redeem", icon: "flame", hanzi: "贖回" },
];

/** Routes a user must not reach, because the underlying action cannot succeed. */
export const DISABLED_TABS = new Set(TABS.filter((t) => t.disabled).map((t) => t.id));

/** What the desktop, the tab strip and the Start menu actually offer. */
const VISIBLE_TABS = TABS.filter((t) => !t.hidden);

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
  "ＷＥＬＣＯＭＥ ＴＯ ＴＨＥ ＴＯＲＩＩ",
  "the tax never sleeps · 5% on every buy and every sell",
  "神社 · 儲備金 · 贖回",
  "burn it and the floor rises for everyone who stayed",
  "we are not a bank · we are a lacquer pot with a queue",
  "no keeper moves the corpus · every allocation is a signature",
  "SO LONG AND GOODNIGHT, MERCENARY LIQUIDITY",
  "chain 56 · bnb chain · verified on-chain",
  "the gate was always on brand · 神社",
];

const TITLES: Record<Tab, string> = {
  about: "What is this?",
  floor: "Reserve",
  deployed: "Deployed capital",
  trade: "Trade",
  stake: "Stake",
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
      <div className="boot-art chrome">ＴＯＲＩＩ</div>
      <div className="boot-hanzi hanzi">神社・儲備・系統啟動</div>
      <div className="boot-rule meander" />
      <div className="bright">TORII BIOS v5.6</div>
      <div>Copyright (C) 2026, Torii Collective</div>
      <br />
      <div>Chain . . . . . . . . 56 BNB Smart Chain</div>
      <div>Numeraire . . . . . . BNB, no oracle</div>
      <div>Launchpad . . . . . . Flap <b className="okc">OK</b></div>
      <div>Reserve . . . . . . . Treasury 0x2384…BE1a <b className="okc">OK</b></div>
      <div>Redemption. . . . . . Redeemer 0xcF48…3fb1 <b className="okc">OK</b></div>
      <div>Tax vault . . . . . . ToriiVault 0x0938…c9A4 <b className="okc">OK</b></div>
      <div>Yield sleeve. . . . . 0 bps, no adapters</div>
      <div>Marble. . . . . . . . loaded</div>
      <br />
      <div>Starting TORII 98<span className="cur">_</span></div>
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
    try { return sessionStorage.getItem("torii98:booted") !== "1"; } catch { return true; }
  });
  const [minimised, setMinimised] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "close" | "about" | "bin" | "copied">(null);
  const mainDrag = useDrag(!maximised);
  const gameDrag = useDrag();
  const padDrag = useDrag();

  const [gameOpen, setGameOpen] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [win, setWin] = useState<
    null | "sysprops" | "update" | "queue" | "mycomputer" | "network" | "notepad"
    | "fortune" | "gomoku" | "hongbao" | "penguin" | "mahjong"
  >(null);
  const [crt, setCrt] = useState(() => {
    try { return localStorage.getItem("torii98:crt") === "on"; } catch { return false; }
  });

  const toggleCrt = () => {
    setCrt((on) => {
      const next = !on;
      try { localStorage.setItem("torii98:crt", next ? "on" : "off"); } catch { /* private mode */ }
      play("click");
      return next;
    });
  };
  const [sound, setSound] = useState(soundOn);
  const [clock, setClock] = useState(() => new Date());
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!booting) return;
    try { sessionStorage.setItem("torii98:booted", "1"); } catch { /* private mode */ }
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
      "TORII — chain 56 (BNB Smart Chain)",
      `explorer     ${EXPLORER}`,
      `token        ${TORII.token}`,
      `curve        ${TORII.curve}`,
      `feeSink      ${TORII.feeSink}`,
      `treasury     ${TORII.treasury}`,
      `stakedAgora  ${TORII.stakedAgora}`,
      `redeemer     ${TORII.redeemer}`,
      `distributor  ${TORII.distributor}`,
    ].join("\n");

    navigator.clipboard?.writeText(lines).then(
      () => { play("ding"); setDialog("copied"); },
      () => { play("error"); }
    );
  };

  const time = clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div
      className={`desktop${crt ? " crt" : ""}`}
      onContextMenu={(e) => {
        // Only the desktop itself, so a right-click inside the window still
        // gets the browser's own menu.
        if ((e.target as HTMLElement).closest(".win, .taskbar, .start-menu")) return;
        e.preventDefault();
        play("click");
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      onClick={() => ctx && setCtx(null)}
    >
      {booting && <Boot />}

      {/* ---- the scene: moon, mountains, the 牌坊, lanterns ----
           Decorative only, so it is aria-hidden and takes no pointer events.

           The gate is a paifang rather than a torii on purpose. TORII names the
           Japanese gate, but the Japanese gate descends from this one, and the
           brief for this chain is Chinese — drawing the ancestor keeps the name
           true and puts the page in the right country at the same time.

           The plaque reads 神社・鳥居 — the token's own name and its symbol.
           `name()` on chain 56 returns 神社 (shénshè, "shrine") literally, so
           the plaque is quoting the contract rather than decorating around it.
           Set as text rather than baked into the SVG so it can be read,
           selected and translated. */}
      <div className="scene" aria-hidden="true">
        <div className="cn-clouds" />
        <div className="cn-moon" />
        <div className="cn-hills" />
        <div className="cn-gate">
          <div className="roof" />
          <div className="plaque">神社・鳥居</div>
          <div className="pillar left">
            <span className="cn-lion left" />
          </div>
          <div className="pillar right">
            <span className="cn-lion right" />
          </div>
          {/* 对联 — a matched couplet, right line read first, seven characters
              each. Both halves are literally true of the contracts: every trade
              is taxed into the pot, and every burn lifts the floor for whoever
              did not burn. */}
          <div className="cn-couplet right">每筆交易皆納稅</div>
          <div className="cn-couplet left">每次焚毀價更高</div>
        </div>
        <div className="cn-lantern l1" />
        <div className="cn-lantern l2" />
      </div>

      {/* ---- desktop icons ---- */}
      <div className="desk-icons">
        {VISIBLE_TABS.map((t) => (
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
              <span className="hanzi">{t.hanzi}</span>
            </span>
          </button>
        ))}

        {/* The one desktop icon that is not a tab. Burned supply really is a
            recycle bin here: redemption destroys TORII permanently. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("mycomputer"); }}
          title="My Computer"
        >
          <PixelIcon name="computer" size={32} />
          <span>
            My Computer
            <span className="hanzi">我的電腦</span>
          </span>
        </button>

        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("network"); }}
          title="Network Neighborhood"
        >
          <PixelIcon name="network" size={32} />
          <span>
            Network
            <span className="hanzi">網路芳鄰</span>
          </span>
        </button>

        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("notepad"); }}
          title="readme.txt"
        >
          <PixelIcon name="help" size={32} />
          <span>
            readme.txt
            <span className="hanzi">說明文件</span>
          </span>
        </button>

        {/* The NFT folder is built and works — it lists a wallet's tokens by
            sweeping every owner, because the collection is not enumerable — but
            there is no collection on BNB Chain to point it at. So the icon
            stays as a marker and does nothing when clicked, rather than opening
            a folder that can only ever be empty.

            `disabled` rather than hidden: an inert icon that says "soon" is a
            statement about the roadmap; a missing one is just an absence. */}
        <button
          className="desk-icon soon"
          disabled
          aria-disabled="true"
          title="NFTs — not on BNB Chain yet"
        >
          <PixelIcon name="folder" size={32} />
          <span>
            NFTs <span className="soon-tag">soon</span>
            <span className="hanzi">即將推出</span>
          </span>
        </button>

        <button className="desk-icon" onClick={() => { play("click"); setDialog("bin"); }} title="Recycle Bin">
          <PixelIcon name="recycle" size={32} />
          <span>Recycle Bin</span>
        </button>

        <button
          className="desk-icon"
          onClick={() => { play("open"); setPadOpen(true); }}
          title="Launchpad"
        >
          <PixelIcon name="rocket" size={32} />
          <span>
            Launchpad
            <span className="hanzi">發射台</span>
          </span>
        </button>

        {/* 求籤 — divination at a shrine, which is what this token is named
            after. The draw comes off a real block hash, so it is the one toy
            here whose randomness can be checked. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("fortune"); }}
          title="求籤 — draw a fortune stick"
        >
          <PixelIcon name="sticks" size={32} />
          <span>
            Fortune
            <span className="hanzi">求籤</span>
          </span>
        </button>

        {/* 五子棋 — the game people actually play on paper. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("gomoku"); }}
          title="五子棋 — five in a row"
        >
          <PixelIcon name="gomoku" size={32} />
          <span>
            Gomoku
            <span className="hanzi">五子棋</span>
          </span>
        </button>

        {/* 紅包 — the pot, in the most legible wrapper there is. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("hongbao"); }}
          title="紅包 — the red envelope"
        >
          <PixelIcon name="hongbao" size={32} />
          <span>
            Red Envelope
            <span className="hanzi">紅包</span>
          </span>
        </button>

        {/* 企鵝 — the messenger every machine of this era had open. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("penguin"); }}
          title="企鵝 — ask the shrine"
        >
          <PixelIcon name="penguin" size={32} />
          <span>
            Messenger
            <span className="hanzi">企鵝</span>
          </span>
        </button>

        {/* 上海麻將 — the one game that is both a Windows classic and Chinese. */}
        <button
          className="desk-icon"
          onClick={() => { play("open"); setWin("mahjong"); }}
          title="上海麻將 — Mahjong solitaire"
        >
          <PixelIcon name="mahjong" size={32} />
          <span>
            Mahjong
            <span className="hanzi">上海麻將</span>
          </span>
        </button>

        <button
          className="desk-icon"
          onClick={() => { play("open"); setGameOpen(true); }}
          title="No Internet"
        >
          <PixelIcon name="dino" size={32} />
          <span>
            No Internet
            <span className="hanzi">恐龍跑酷</span>
          </span>
        </button>

        {/* A shortcut off the desktop, the way a browser bookmark sat on one.
            GMGN is where the chart actually lives now that TORII has graduated. */}
        {/* Flap — where TORII is actually traded while it is still on the
            curve. The Trade tab can price the curve but cannot send an order to
            it yet, so this is the honest route out. Cut to a circle, which also
            crops the watermark that sat in the corner of the supplied file. */}
        <a
          className="desk-icon"
          href={CURVE_TRADE_URL}
          target="_blank"
          rel="noreferrer"
          title="Buy and sell TORII on Flap"
          onClick={() => play("click")}
        >
          <img className="round-icon" src="/flap-64.png" width={32} height={32} alt="" />
          <span>
            Flap
            <span className="hanzi">交易所</span>
          </span>
        </a>

        <a
          className="desk-icon"
          href={GMGN_URL}
          target="_blank"
          rel="noreferrer"
          title="TORII on GMGN"
          onClick={() => play("click")}
        >
          <img src="/GMGN_logo.svg" width={32} height={32} alt="" />
          <span>
            TORII chart
            <span className="hanzi">行情圖</span>
          </span>
        </a>
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
              : { transform: withDrag(mainDrag.offset) }
          }
        >
          <div
            className="titlebar"
            {...mainDrag.handleProps}
            onDoubleClick={() => { play("click"); mainDrag.reset(); }}
            title="Drag to move · double-click to recentre"
          >
            <PixelIcon name="computer" size={16} />
            <span className="t-text">
              <span className="chrome">ＴＯＲＩＩ ９８</span>
              <span className="hanzi" style={{ margin: "0 6px", opacity: 0.8 }}>神社</span>
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
                { kind: "item", label: crt ? "CRT mode: On" : "CRT mode: Off", onClick: toggleCrt },
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
                  label: "Switch to chain 56",
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
                { kind: "item", label: "Windows Update…", onClick: () => setWin("update") },
                { kind: "item", label: "Redemption Queue…", onClick: () => setWin("queue") },
                { kind: "item", label: "System Properties…", onClick: () => setWin("sysprops") },
                { kind: "sep" },
                { kind: "item", label: "About TORII 98…", onClick: () => setDialog("about") },
              ]}
            />
          </div>

          {/* ---- tab control ---- */}
          <div className="tabstrip" role="tablist">
            {VISIBLE_TABS.map((t) => (
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
                <span className="hanzi">{t.hanzi}</span>
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
              {RPC_HOST}
            </div>
            <div className="status-pane" title="鏈上核驗 — verified on chain 56">
              <span className="seal">鏈上<br />核驗</span>
            </div>
          </div>
        </div>
      )}

      {/* ---- dialogs ---- */}
      {dialog === "close" && (
        <Dialog title="TORII 98" icon="error" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            This program cannot be closed. It is a web page.
          </p>
          <p style={{ margin: "8px 0 0" }}>
            The reserve keeps accruing whether or not anyone is looking at it.
          </p>
        </Dialog>
      )}

      {dialog === "about" && (
        <Dialog title="About TORII 98" icon="info" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            <b>TORII 98</b><br />
            A 5% trade tax funding a reserve on BNB Chain.
          </p>
          <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
            Every buy and sell pays 5%. Part of it pays people who stake; the rest sits in the
            reserve, and any holder may burn TORII for a share of it.
          </p>
          <p style={{ margin: "8px 0 0", color: "#505050" }}>
            The interface is a tribute. The contracts are real — addresses verified on chain 56.
          </p>
        </Dialog>
      )}

      {dialog === "bin" && (
        <Dialog title="Recycle Bin" icon="recycle" onClose={() => setDialog(null)}>
          <p style={{ margin: 0 }}>
            <b>Empty — and it cannot be restored.</b>
          </p>
          <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
            Redeeming TORII burns it at the moment you ask, not when you collect. The supply is
            fixed at launch and there is no mint function, so nothing that goes in here
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

      {gameOpen && (
        <div
          className="win win-game"
          style={{ top: 130, left: "50%", transform: withDrag(gameDrag.offset, "translateX(-50%)") }}
        >
          <div className="titlebar" {...gameDrag.handleProps} onDoubleClick={gameDrag.reset}>
            <PixelIcon name="dino" size={16} />
            <span className="t-text">No Internet — 恐龍跑酷</span>
            <span className="t-btns">
              <button
                className="tbtn close"
                aria-label="Close"
                onClick={() => { play("close"); setGameOpen(false); }}
              />
            </span>
          </div>
          <div className="client" style={{ padding: 10 }}>
            <Dino />
          </div>
        </div>
      )}

      {padOpen && (
        <div
          className="win win-game"
          style={{ top: 150, left: "50%", transform: withDrag(padDrag.offset, "translateX(-50%)") }}
        >
          <div className="titlebar" {...padDrag.handleProps} onDoubleClick={padDrag.reset}>
            <PixelIcon name="rocket" size={16} />
            <span className="t-text">Launchpad — 發射台</span>
            <span className="t-btns">
              <button
                className="tbtn close"
                aria-label="Close"
                onClick={() => { play("close"); setPadOpen(false); }}
              />
            </span>
          </div>
          <div className="client" style={{ padding: 16 }}>
            <div className="dialog-body">
              <PixelIcon name="rocket" size={32} />
              <div>
                <p style={{ margin: 0 }}>
                  <b>There are already a hundred launchpads on BNB Chain.</b>
                </p>
                <p style={{ margin: "8px 0 0", lineHeight: 1.5 }}>
                  So we did not build another one. TORII launched on Flap like everything else, and
                  the interesting part was never the launch — it was what happens to the tax
                  afterwards.
                </p>
                <p style={{ margin: "8px 0 0", color: "#4a3a5e", lineHeight: 1.5 }}>
                  Every buy and sell still pays 5%. That is the whole product. A launchpad would
                  have been a hundred-and-first way to start; the reserve is a way to keep going.
                </p>
              </div>
            </div>
            <div className="dialog-btns">
              <button className="btn primary" onClick={() => { play("close"); setPadOpen(false); }}>
                Fair enough
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ---- desktop context menu ---- */}
      {ctx && (
        <div
          className="menu-pop ctx-menu"
          role="menu"
          style={{ left: Math.min(ctx.x, window.innerWidth - 190), top: ctx.y }}
        >
          <button role="menuitem" onClick={() => { setCtx(null); play("click"); }}>Arrange Icons</button>
          <button role="menuitem" onClick={() => { setCtx(null); window.location.reload(); }}>Refresh</button>
          <div className="sep" />
          <button role="menuitem" onClick={() => { setCtx(null); toggleCrt(); }}>
            {crt ? "CRT mode: On" : "CRT mode: Off"}
          </button>
          <button role="menuitem" onClick={() => { setCtx(null); setWin("update"); play("open"); }}>
            Windows Update…
          </button>
          <div className="sep" />
          <button role="menuitem" onClick={() => { setCtx(null); setWin("sysprops"); play("open"); }}>
            <b>Properties</b>
          </button>
        </div>
      )}

      {win === "sysprops" && <SystemProperties onClose={() => { play("close"); setWin(null); }} />}
      {win === "update" && <WindowsUpdate onClose={() => { play("close"); setWin(null); }} />}
      {win === "queue" && <PrintQueue onClose={() => { play("close"); setWin(null); }} />}
      {win === "mycomputer" && <MyComputer onClose={() => { play("close"); setWin(null); }} />}
      {win === "network" && <NetworkNeighborhood onClose={() => { play("close"); setWin(null); }} />}
      {win === "notepad" && <Notepad onClose={() => { play("close"); setWin(null); }} />}
      {win === "fortune" && (
        <Fortune account={wallet.account} onClose={() => { play("close"); setWin(null); }} />
      )}
      {win === "gomoku" && <Gomoku onClose={() => { play("close"); setWin(null); }} />}
      {win === "hongbao" && <Hongbao onClose={() => { play("close"); setWin(null); }} />}
      {win === "penguin" && <Penguin onClose={() => { play("close"); setWin(null); }} />}
      {win === "mahjong" && <Mahjong onClose={() => { play("close"); setWin(null); }} />}

      {/* ---- start menu ---- */}
      {startOpen && (
        <div className="start-menu" role="menu">
          <div className="start-banner">
            TORII<b>98</b>
          </div>
          <div className="start-items">
            {VISIBLE_TABS.map((t) => (
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
            <button role="menuitem" onClick={() => { play("open"); setWin("mycomputer"); setStartOpen(false); }}>
              <PixelIcon name="computer" size={24} />
              My Computer
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("network"); setStartOpen(false); }}>
              <PixelIcon name="network" size={24} />
              Network Neighborhood
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("fortune"); setStartOpen(false); }}>
              <PixelIcon name="sticks" size={24} />
              求籤 Fortune
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("gomoku"); setStartOpen(false); }}>
              <PixelIcon name="gomoku" size={24} />
              五子棋 Gomoku
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("hongbao"); setStartOpen(false); }}>
              <PixelIcon name="hongbao" size={24} />
              紅包 Red Envelope
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("mahjong"); setStartOpen(false); }}>
              <PixelIcon name="mahjong" size={24} />
              上海麻將 Mahjong
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("penguin"); setStartOpen(false); }}>
              <PixelIcon name="penguin" size={24} />
              企鵝 Messenger
            </button>
            <button role="menuitem" disabled aria-disabled="true">
              <PixelIcon name="folder" size={24} />
              NFTs <span className="soon-tag">soon</span>
            </button>
            <button role="menuitem" onClick={() => { play("open"); setWin("notepad"); setStartOpen(false); }}>
              <PixelIcon name="help" size={24} />
              readme.txt
            </button>
            <button role="menuitem" onClick={() => { play("open"); setPadOpen(true); setStartOpen(false); }}>
              <PixelIcon name="rocket" size={24} />
              Launchpad
            </button>
            <button role="menuitem" onClick={() => { play("open"); setGameOpen(true); setStartOpen(false); }}>
              <PixelIcon name="dino" size={24} />
              No Internet
            </button>
            <button role="menuitem" onClick={() => { play("click"); setDialog("bin"); setStartOpen(false); }}>
              <PixelIcon name="recycle" size={24} />
              Recycle Bin
            </button>
            <a
              role="menuitem"
              href={CURVE_TRADE_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => { play("click"); setStartOpen(false); }}
            >
              <img className="round-icon" src="/flap-64.png" width={24} height={24} alt="" />
              Trade on Flap
            </a>
            <a
              role="menuitem"
              href={GMGN_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => { play("click"); setStartOpen(false); }}
            >
              <img src="/GMGN_logo.svg" width={24} height={24} alt="" />
              TORII chart on GMGN
            </a>
            <div className="sep" />
            <button role="menuitem" onClick={() => { play("click"); setDialog("about"); setStartOpen(false); }}>
              <PixelIcon name="info" size={24} />
              About TORII 98…
            </button>
          </div>
        </div>
      )}

      {/* Announcements from the chain, and the idle takeover. Both sit above
          the desktop and outside every window. */}
      <TaxWatch enabled={!booting} />

      {/* ---- taskbar ---- */}
      <div className="taskbar">
        <button
          className="start-btn"
          aria-expanded={startOpen}
          aria-haspopup="menu"
          onClick={() => { play("click"); setStartOpen(!startOpen); setOpenMenu(null); }}
        >
          <PixelIcon name="computer" size={18} />
          Start<span className="gloss">開始</span>
        </button>
        <div className="task-sep" />

        <div className="task-btns">
          <button
            className="task-btn"
            aria-pressed={!minimised}
            onClick={() => { play("click"); setMinimised(minimised ? false : true); }}
          >
            <PixelIcon name="computer" size={16} />
            TORII 98 — {TITLES[tab]}
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
