import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { Panel, Row, Stat, Pill, Dot } from "./components";
import { AwaitingDeployment } from "./Layout";
import { fmtSig, DASH } from "./format";
import {
  AGORA, ZERO, explorerAddr, SUITS_NFT, SUITS_SUPPLY, SUITS_VALIDATOR, SUITS_SHARE_BPS,
} from "./chain";
import {
  readSuitsPosition, classifyTokens, approveSuitsForStaking, stakeSuits,
  unstakeSuits, claimSuitsYield, type SuitsPosition, type TokenStatus,
} from "./vault";
import { useSnapshot } from "./useReads";
import type { Wallet } from "./eth";

const deployed = AGORA.stakedSuits !== ZERO;

/** Accepts "1, 2, 7" and "1-4" — holders think in ranges. */
function parseIds(input: string): bigint[] {
  const out: bigint[] = [];
  for (const part of input.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (a <= b && b - a < 500) for (let i = a; i <= b; i++) out.push(BigInt(i));
    } else if (/^\d+$/.test(part)) {
      out.push(BigInt(part));
    }
  }
  return [...new Set(out.map(String))].map(BigInt);
}

export default function Suits({ wallet }: { wallet: Wallet }) {
  const { data: s } = useSnapshot();
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [input, setInput] = useState("");
  const [statuses, setStatuses] = useState<TokenStatus[] | null>(null);
  const [pos, setPos] = useState<SuitsPosition | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet.account) { setPos(null); return; }
    setPos(await readSuitsPosition(wallet.account));
  }, [wallet.account]);

  useEffect(() => { void refresh(); }, [refresh]);

  const ids = useMemo(() => parseIds(input), [input]);

  // Resolve ownership as the holder types. The collection is not Enumerable,
  // so this is the only way to tell them what will happen before they sign.
  useEffect(() => {
    if (!wallet.account || ids.length === 0) { setStatuses(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      classifyTokens(ids.slice(0, 60), wallet.account!)
        .then((r) => alive && setStatuses(r))
        .catch(() => alive && setStatuses(null));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [ids, wallet.account]);

  const stakeable = statuses?.filter((t) => t.state === "yours").map((t) => t.id) ?? [];
  const unstakeable = statuses?.filter((t) => t.state === "staked-by-you").map((t) => t.id) ?? [];
  const selected = mode === "stake" ? stakeable : unstakeable;

  const run = async (label: string, fn: (signer: any) => Promise<string>) => {
    setErr(null); setTx(null); setBusy(label);
    try {
      if (!wallet.onCorrectChain) await wallet.switchChain();
      setTx(await fn(await wallet.getSigner()));
      setInput("");
      setStatuses(null);
      await refresh();
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.reason ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(null);
    }
  };

  const needsApproval = mode === "stake" && pos?.approvedForAll === false;
  const suitsInfo = s?.suits;

  return (
    <>
      {!deployed && (
        <AwaitingDeployment
          what="StakedSuits"
          why={`Staked Suits receive ${SUITS_SHARE_BPS / 100}% of protocol income. The Suits collection itself is live and unaffected — only the staking vault is pending.`}
          phase="Treasury + FeeSink → launch → StakedSuits + Distributor"
        />
      )}

      <div className="two">
        <Panel
          label={mode === "stake" ? "Stake Suits" : "Unstake Suits"}
          id="ERC-721"
          right={
            <Pill warn={!deployed}>
              <Dot kind={deployed ? "ok" : "off"} />
              {deployed ? "live" : "not deployed"}
            </Pill>
          }
        >
          <div className="swapdir">
            <button className="mini" aria-selected={mode === "stake"} onClick={() => setMode("stake")}>Stake</button>
            <button className="mini" aria-selected={mode === "unstake"} onClick={() => setMode("unstake")}>Unstake</button>
          </div>

          <div className="field">
            <div className="field-top">
              <span className="k">Token IDs</span>
              <span className="bal">
                you hold <b>{pos?.owned != null ? String(pos.owned) : DASH}</b> · staked{" "}
                <b>{pos?.staked != null ? String(pos.staked) : DASH}</b>
              </span>
            </div>
            <div className="input-wrap">
              <input
                placeholder="e.g. 118, 402, 900-903"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={!deployed || !wallet.account}
              />
              <span className="denom">IDs</span>
            </div>
          </div>

          {statuses && statuses.length > 0 && (
            <div className="chips">
              {statuses.map((t) => (
                <span
                  key={String(t.id)}
                  className={`chip ${
                    t.state === "yours" ? "yours"
                    : t.state === "staked-by-you" ? "mine"
                    : t.state === "missing" ? "" : "other"
                  }`}
                  title={
                    t.state === "yours" ? "in your wallet — ready to stake"
                    : t.state === "staked-by-you" ? "staked by you"
                    : t.state === "staked-by-other" ? "staked by someone else"
                    : t.state === "not-yours" ? "owned by another wallet"
                    : "no such token"
                  }
                >
                  #{String(t.id)}
                  {t.state === "staked-by-you" && " ✦"}
                  {(t.state === "not-yours" || t.state === "staked-by-other") && " ✕"}
                  {t.state === "missing" && " ?"}
                </span>
              ))}
            </div>
          )}

          {ids.length > 0 && statuses && selected.length === 0 && (
            <div className="err" style={{ marginTop: 12 }}>
              {mode === "stake"
                ? "None of those IDs are in your wallet."
                : "None of those IDs were staked by you."}
            </div>
          )}

          <div style={{ height: 14 }} />

          {!wallet.account ? (
            <button className="btn" onClick={wallet.connect} disabled={!deployed}>
              {deployed ? "Connect wallet" : "Awaiting StakedSuits"}
            </button>
          ) : needsApproval ? (
            <button className="btn" disabled={!!busy} onClick={() => run("approve", approveSuitsForStaking)}>
              {busy === "approve" ? "Approving…" : "Approve the vault for Suits"}
            </button>
          ) : (
            <button
              className="btn"
              disabled={!deployed || !!busy || selected.length === 0}
              onClick={() =>
                run(mode, (sg) =>
                  mode === "stake" ? stakeSuits(sg, selected) : unstakeSuits(sg, selected)
                )
              }
            >
              {busy === mode
                ? mode === "stake" ? "Staking…" : "Unstaking…"
                : selected.length === 0
                  ? mode === "stake" ? "Enter your token IDs" : "Enter staked token IDs"
                  : `${mode === "stake" ? "Stake" : "Unstake"} ${selected.length} Suit${selected.length === 1 ? "" : "s"}`}
            </button>
          )}

          <button
            className="btn ghost"
            style={{ marginTop: 8 }}
            disabled={!deployed || !wallet.account || !!busy || !(pos?.pendingYield && pos.pendingYield > 0n)}
            onClick={() => run("claim", claimSuitsYield)}
          >
            {busy === "claim"
              ? "Claiming…"
              : pos?.pendingYield && pos.pendingYield > 0n
                ? `Claim ${fmtSig(pos.pendingYield)} ETH`
                : "Nothing to claim"}
          </button>

          {err && <div className="err">{err}</div>}
          {tx && <div className="txnote">Confirmed · {tx.slice(0, 18)}…</div>}

          <p className="sub">
            Token IDs are typed in because the collection is <b>not</b> <code>ERC721Enumerable</code> —
            there is no <code>tokenOfOwnerByIndex</code>, so no contract or page can list what a wallet
            holds. Each ID is checked against <code>ownerOf</code> before anything is offered.
          </p>
        </Panel>

        <div>
          <div className="grid c2">
            <Stat
              k="Your staked Suits"
              value={pos?.staked != null ? String(pos.staked) : null}
              note={pos?.pendingYield != null ? `${fmtSig(pos.pendingYield)} ETH unclaimed` : undefined}
            />
            <Stat
              k="Staked collection-wide"
              value={suitsInfo?.totalStaked != null ? `${suitsInfo.totalStaked} / ${SUITS_SUPPLY}` : null}
            />
          </div>

          <div style={{ height: 14 }} />

          <Panel label="The collection" id="live now">
            <div className="rows">
              <Row k="Name">{suitsInfo?.collection.name ?? DASH}</Row>
              <Row k="Supply">
                {suitsInfo?.collection.totalSupply != null
                  ? `${suitsInfo.collection.totalSupply} — fully minted, fixed`
                  : DASH}
              </Row>
              <Row k="Income share">
                {suitsInfo?.shareBps != null
                  ? `${Number(suitsInfo.shareBps) / 100}% of all yield`
                  : `${SUITS_SHARE_BPS / 100}% of all yield`}
              </Row>
              <Row k="Weighting">One Suit, one share — no rarity multiplier</Row>
              <Row k="Contract">
                <a className="rv" href={explorerAddr(SUITS_NFT)} target="_blank" rel="noreferrer">
                  {SUITS_NFT.slice(0, 14)}…
                </a>
              </Row>
            </div>
          </Panel>

          <div style={{ height: 14 }} />

          <Panel label="Income to Suits">
            <div className="rows">
              <Row k="Delivered to date" na={suitsInfo?.cumulativeRewards == null}>
                {suitsInfo?.cumulativeRewards != null
                  ? `${formatEther(suitsInfo.cumulativeRewards)} ETH`
                  : "not deployed"}
              </Row>
              <Row k="Claimed" na={suitsInfo?.cumulativeClaimed == null}>
                {suitsInfo?.cumulativeClaimed != null
                  ? `${formatEther(suitsInfo.cumulativeClaimed)} ETH`
                  : "not deployed"}
              </Row>
              <Row k="If none staked">Rerouted to stAGORA — never stranded</Row>
            </div>
          </Panel>
        </div>
      </div>

      <div className="notice" style={{ marginTop: 18 }}>
        <b>Transfer-validator risk — read before staking.</b> Suits has a Limit Break creator-token
        transfer validator at <code>{SUITS_VALIDATOR.slice(0, 14)}…</code>
        {suitsInfo?.collection.transferValidator &&
          suitsInfo.collection.transferValidator !== ZERO &&
          suitsInfo.collection.transferValidator.toLowerCase() !== SUITS_VALIDATOR.toLowerCase() &&
          <> (currently <code>{suitsInfo.collection.transferValidator.slice(0, 14)}…</code>)</>}
        . Today its policy permits transfers into a contract, which is what staking needs. But the
        collection owner can tighten that policy at any time and could block transfers <em>out</em> of the
        vault, stranding staked NFTs. Nothing in these contracts can prevent that — the collection is not
        ours. Unstaking uses a plain <code>transferFrom</code> so it does not also depend on the receiver
        hook, and accrued ETH is tracked independently of custody, so rewards stay claimable even if a
        token were stuck.
      </div>
    </>
  );
}
