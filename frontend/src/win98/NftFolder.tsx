import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PixelIcon } from "./pixel";
import { Frame } from "./Frame";
import { play } from "./sound";
import {
  readSuitsInventory, forgetSuitsInventory, readSuitMeta, loadImage, gatewayUrl,
  type Suit, type SuitMeta,
} from "../nft";
import {
  AGORA, ZERO, SUITS_NFT, SUITS_SUPPLY, SUITS_MARKET, SUITS_STAKING_ENABLED,
  explorerAddr, EXPLORER,
} from "../chain";
import { approveSuitsForStaking, stakeSuits, unstakeSuits } from "../vault";
import type { Wallet } from "../eth";

/**
 * My Suits — the wallet's NFTs, as a Windows 98 folder.
 *
 * ## Why a folder is the right metaphor and not just a joke
 *
 * A folder already has every affordance this needs: select one item or several,
 * right-click for the actions that apply to the selection, switch between icons
 * and details, read Properties. Staking NFTs is a multi-select operation —
 * `StakedSuits.stake` takes an array — and the existing Suits page asks holders
 * to *type* "1, 4, 22-25" because the collection is not enumerable. Clicking
 * files is a better answer to the same problem.
 *
 * ## Two honesty rules it keeps
 *
 * **An empty folder must mean the chain said so.** The sweep reads with
 * `aggregate3Strict`, so an RPC failure throws and renders as an error rather
 * than as "you own nothing" — the same mistake the Beefy sweep shipped once.
 *
 * **Thumbnails are opt-in.** Art lives on IPFS behind public gateways that took
 * five seconds cold when measured, and each image is a 1.28 MB PNG. Icon view
 * needs no network at all and is what a Win98 folder looked like anyway, so
 * that is the default and images are something the reader turns on.
 */

type View = "icons" | "details" | "thumbs";

export function NftFolder({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const [suits, setSuits] = useState<Suit[] | null>(null);
  const [approved, setApproved] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>("icons");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [props, setProps] = useState<number | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);


  const account = wallet.account;
  const vaultLive = AGORA.stakedSuits !== ZERO;
  /** How many thumbnails have finished, so the status bar can say so. */
  const [done, setDone] = useState(0);
  useEffect(() => { setDone(0); }, [view, account]);
  const tileDone = useCallback(() => setDone((n) => n + 1), []);

  const scan = useCallback(async (fresh = false) => {
    if (!account) { setSuits(null); return; }
    if (fresh) forgetSuitsInventory(account);
    setScanning(true);
    setError(null);
    try {
      const inv = await readSuitsInventory(account, { fresh });
      setSuits(inv.suits);
      setApproved(inv.approved);
    } catch (e: any) {
      // Never fall through to an empty list: a failed read is not a finding.
      setSuits(null);
      setError(e?.shortMessage ?? e?.message ?? "the registry could not be read");
    } finally {
      setScanning(false);
    }
  }, [account]);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => { setSel(new Set()); }, [account]);

  const yours = useMemo(() => suits?.filter((s) => s.state === "yours") ?? [], [suits]);
  const staked = useMemo(() => suits?.filter((s) => s.state === "staked") ?? [], [suits]);

  const selected = useMemo(
    () => (suits ?? []).filter((s) => sel.has(s.id)),
    [suits, sel]
  );
  const selStakeable = selected.filter((s) => s.state === "yours").map((s) => BigInt(s.id));
  const selUnstakeable = selected.filter((s) => s.state === "staked").map((s) => BigInt(s.id));

  /* ---- selection ---- */
  const lastClicked = useRef<number | null>(null);

  const click = (id: number, e: React.MouseEvent) => {
    play("click");
    setSel((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastClicked.current !== null && suits) {
        const ids = suits.map((s) => s.id);
        const a = ids.indexOf(lastClicked.current);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
          return next;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }
      return new Set([id]);
    });
    lastClicked.current = id;
  };

  const contextMenu = (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    // Right-clicking outside the selection selects that item first, the way
    // Explorer does — otherwise the menu acts on something you cannot see.
    if (!sel.has(id)) { setSel(new Set([id])); lastClicked.current = id; }
    setCtx({ x: e.clientX, y: e.clientY });
    play("click");
  };

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctx]);

  /* ---- transactions ---- */
  const run = async (label: string, fn: (signer: any) => Promise<string>) => {
    setErr(null); setTx(null); setBusy(label); setCtx(null);
    try {
      if (!wallet.onCorrectChain) await wallet.switchChain();
      const hash = await fn(await wallet.getSigner());
      setTx(hash);
      play("ding");
      setSel(new Set());
      // The wallet's holdings just changed, so the cached sweep is wrong.
      await scan(true);
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.reason ?? e?.message ?? "Transaction failed.");
      play("error");
    } finally {
      setBusy(null);
    }
  };

  const canStake = SUITS_STAKING_ENABLED && vaultLive && !busy && selStakeable.length > 0;
  const canUnstake = SUITS_STAKING_ENABLED && vaultLive && !busy && selUnstakeable.length > 0;
  const needsApproval = approved === false;

  /* ---- render ---- */
  const count = suits?.length ?? 0;

  return (
    <Frame title="My Suits" icon="folder" onClose={onClose} width={620}>
      <div className="explorer">
        <div className="notepad-menu">
          <span><u>F</u>ile</span>
          <span><u>E</u>dit</span>
          <span><u>V</u>iew</span>
          <span><u>H</u>elp</span>
        </div>

        <div className="exp-bar">
          <span className="exp-addr">
            <PixelIcon name="folder" size={14} />
            <a className="link" href={explorerAddr(SUITS_NFT)} target="_blank" rel="noreferrer">
              \\SUITS\{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "…"}
            </a>
          </span>
          <span style={{ flex: 1 }} />
          <div className="swapdir">
            <button className="mini" aria-selected={view === "icons"} onClick={() => setView("icons")}>Icons</button>
            <button className="mini" aria-selected={view === "details"} onClick={() => setView("details")}>Details</button>
            <button className="mini" aria-selected={view === "thumbs"} onClick={() => { setView("thumbs"); play("open"); }}>Thumbnails</button>
          </div>
          <button className="mini" disabled={scanning || !account} onClick={() => { play("click"); void scan(true); }}>
            {scanning ? "…" : "Refresh"}
          </button>
        </div>

        <div className="exp-body">
          {!account ? (
            <div className="exp-empty">
              <PixelIcon name="key" size={32} />
              <p>Connect a wallet to list its Suits.</p>
              <button className="btn" onClick={wallet.connect} disabled={wallet.connecting}>
                {wallet.connecting ? "Connecting…" : wallet.hasProvider ? "Connect wallet" : "No wallet found"}
              </button>
            </div>
          ) : error ? (
            <div className="exp-empty">
              <PixelIcon name="error" size={32} />
              <p><b>Could not read the collection</b> — {error}</p>
              <p className="sub" style={{ textAlign: "center" }}>
                This is a failed read, not an empty wallet. Nothing here says you own no Suits;
                it says the chain did not answer. Refresh to try again.
              </p>
            </div>
          ) : scanning && suits === null ? (
            <div className="exp-empty">
              <PixelIcon name="hourglass" size={32} />
              <p>Reading all {SUITS_SUPPLY} tokens…</p>
              <p className="sub" style={{ textAlign: "center" }}>
                Suits is not enumerable, so every owner is read directly. Three requests, about a
                second and a half.
              </p>
            </div>
          ) : count === 0 ? (
            <div className="exp-empty">
              <PixelIcon name="folder" size={32} />
              <p>This folder is empty.</p>
              <p className="sub" style={{ textAlign: "center" }}>
                All {SUITS_SUPPLY} tokens were read and none belong to this wallet.
              </p>
              <a className="btn" href={SUITS_MARKET} target="_blank" rel="noreferrer">
                Buy a Suit on OpenSea
              </a>
            </div>
          ) : view === "details" ? (
            <table className="exp-table">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Status</th><th>Token ID</th></tr>
              </thead>
              <tbody>
                {suits!.map((s) => (
                  <tr
                    key={s.id}
                    className={sel.has(s.id) ? "on" : undefined}
                    onClick={(e) => click(s.id, e)}
                    onContextMenu={(e) => contextMenu(s.id, e)}
                  >
                    <td><PixelIcon name="tie" size={14} /> Suits #{s.id}</td>
                    <td>ERC-721</td>
                    <td>{s.state === "staked" ? "Staked" : "In wallet"}</td>
                    <td>{s.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="exp-grid">
              {suits!.map((s) => (
                <SuitTile
                  key={s.id}
                  suit={s}
                  selected={sel.has(s.id)}
                  thumb={view === "thumbs"}
                  onClick={(e) => click(s.id, e)}
                  onContextMenu={(e) => contextMenu(s.id, e)}
                  onSettled={tileDone}
                />
              ))}
            </div>
          )}
        </div>

        <div className="exp-status">
          <span>
            {suits === null ? "—" : `${count} object(s)`}
            {staked.length > 0 && ` · ${staked.length} staked`}
          </span>
          <span>
            {view === "thumbs" && count > 0 && done < count
              ? `building thumbnails… ${done} of ${count}`
              : sel.size > 0
                ? `${sel.size} selected`
                : "right-click to stake"}
          </span>
        </div>
      </div>

      {/* ---- action bar: the same actions as the menu, for people who never
              right-click anything ---- */}
      {count > 0 && (
        <div className="dialog-btns" style={{ justifyContent: "flex-start", marginTop: 10 }}>
          {needsApproval ? (
            <button
              className="btn"
              disabled={!!busy || !vaultLive}
              onClick={() => run("approve", approveSuitsForStaking)}
            >
              {busy === "approve" ? "Approving…" : "Approve the vault (once)"}
            </button>
          ) : (
            <button className="btn" disabled={!canStake} onClick={() => run("stake", (s) => stakeSuits(s, selStakeable))}>
              {busy === "stake" ? "Staking…" : `Stake${selStakeable.length ? ` ${selStakeable.length}` : ""}`}
            </button>
          )}
          <button className="btn ghost" disabled={!canUnstake} onClick={() => run("unstake", (s) => unstakeSuits(s, selUnstakeable))}>
            {busy === "unstake" ? "Unstaking…" : `Unstake${selUnstakeable.length ? ` ${selUnstakeable.length}` : ""}`}
          </button>
          <button className="btn ghost" disabled={!suits} onClick={() => setSel(new Set(suits!.map((s) => s.id)))}>
            Select all
          </button>
        </div>
      )}

      {err && <div className="err">{err}</div>}
      {tx && <div className="txnote">Confirmed · {tx.slice(0, 18)}…</div>}

      {yours.length > 0 && needsApproval && (
        <p className="sub">
          Staking moves the token into <code>StakedSuits</code>, so the vault needs a one-time
          <code> setApprovalForAll</code> before it can. That approval only lets the vault move
          Suits, and only into and out of itself — you can revoke it any time from the collection.
        </p>
      )}

      {/* ---- the right-click menu ---- */}
      {ctx && (
        <div
          className="menu-pop pinned"
          role="menu"
          style={{
            left: Math.min(ctx.x, window.innerWidth - 200),
            top: Math.min(ctx.y, window.innerHeight - 220),
          }}
        >
          {needsApproval ? (
            <button role="menuitem" disabled={!vaultLive || !!busy} onClick={() => run("approve", approveSuitsForStaking)}>
              Approve the vault…
            </button>
          ) : (
            <button role="menuitem" disabled={!canStake} onClick={() => run("stake", (s) => stakeSuits(s, selStakeable))}>
              <b>Stake</b>{selStakeable.length > 1 ? ` ${selStakeable.length} Suits` : ""}
            </button>
          )}
          <button role="menuitem" disabled={!canUnstake} onClick={() => run("unstake", (s) => unstakeSuits(s, selUnstakeable))}>
            Unstake{selUnstakeable.length > 1 ? ` ${selUnstakeable.length} Suits` : ""}
          </button>
          <div className="sep" />
          <button
            role="menuitem"
            disabled={sel.size !== 1}
            onClick={() => { setCtx(null); window.open(`${SUITS_MARKET}/${[...sel][0]}`, "_blank"); }}
          >
            Open on OpenSea
          </button>
          <button
            role="menuitem"
            onClick={() => { setCtx(null); window.open(explorerAddr(SUITS_NFT), "_blank"); }}
          >
            View the collection…
          </button>
          <div className="sep" />
          <button role="menuitem" disabled={sel.size !== 1} onClick={() => { setCtx(null); setProps([...sel][0]); play("open"); }}>
            Properties
          </button>
        </div>
      )}

      {props !== null && <SuitProperties id={props} onClose={() => { play("close"); setProps(null); }} />}
    </Frame>
  );
}

/* ==========================================================================
   One file in the folder
   ========================================================================== */

function SuitTile({
  suit, selected, thumb, onClick, onContextMenu, onSettled,
}: {
  suit: Suit;
  selected: boolean;
  thumb: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Fired once, whether the art arrived or not — the count is of work done. */
  onSettled: () => void;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Nothing is rendered until the picture has decoded — see `loadImage`. A
  // half-loaded thumbnail grid should look like a folder still working, not
  // like a folder full of broken files.
  useEffect(() => {
    if (!thumb || img || failed) return;
    let alive = true;
    readSuitMeta(suit.id)
      .then((m) => (m?.image ? loadImage(m.image) : null))
      .then((url) => {
        if (!alive) return;
        url ? setImg(url) : setFailed(true);
        onSettled();
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        onSettled();
      });
    return () => { alive = false; };
  }, [thumb, suit.id, img, failed, onSettled]);

  return (
    <button
      className={`exp-item${selected ? " on" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`Suits #${suit.id}${suit.state === "staked" ? " — staked" : ""}`}
    >
      <span className="exp-thumb">
        {thumb && img && !failed ? (
          <img src={img} alt="" onError={() => setFailed(true)} />
        ) : (
          <PixelIcon name="tie" size={32} />
        )}
        {suit.state === "staked" && <span className="exp-badge" title="Staked"><PixelIcon name="lock" size={12} /></span>}
      </span>
      <span className="exp-name">Suits #{suit.id}</span>
    </button>
  );
}

/* ==========================================================================
   Properties — the traits, as a Win98 property sheet
   ========================================================================== */

function SuitProperties({ id, onClose }: { id: number; onClose: () => void }) {
  const [meta, setMeta] = useState<SuitMeta | null | "loading">("loading");

  useEffect(() => {
    let alive = true;
    readSuitMeta(id)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null));
    return () => { alive = false; };
  }, [id]);

  return (
    <Frame title={`Suits #${id} Properties`} icon="tie" onClose={onClose} width={420}>
      {meta === "loading" ? (
        <p className="muted" style={{ margin: 0 }}>Reading metadata from IPFS…</p>
      ) : meta === null ? (
        <>
          <p style={{ margin: 0 }}>Metadata is unreachable right now.</p>
          <p className="sub">
            The art and traits live on IPFS behind public gateways. The token itself is on chain
            4663 and unaffected — this is a gateway being slow, not a missing NFT.
          </p>
        </>
      ) : (
        <div className="sysprops">
          {meta.image && (
            <div className="sysprops-art">
              <img src={gatewayUrl(meta.image)} width={96} height={96} alt="" style={{ imageRendering: "pixelated" }} />
            </div>
          )}
          <div className="rows mini" style={{ flex: 1 }}>
            <PropRow k="Name">{meta.name}</PropRow>
            <PropRow k="Token ID">{id}</PropRow>
            <PropRow k="Standard">ERC-721</PropRow>
            {meta.attributes.map((a) => (
              <PropRow k={a.trait_type} key={a.trait_type}>{String(a.value)}</PropRow>
            ))}
          </div>
        </div>
      )}
      <p className="sub" style={{ marginTop: 12 }}>
        Trait names come straight from the collection's metadata, typos and all — they are what is
        pinned, and rewriting them here would make this page disagree with every marketplace.{" "}
        <a className="link" href={EXPLORER} target="_blank" rel="noreferrer">Verify on the explorer.</a>
      </p>
    </Frame>
  );
}

function PropRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="rk">{k}</span>
      <span className="rv">{children}</span>
    </div>
  );
}
