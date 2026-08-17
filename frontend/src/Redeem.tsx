import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { Panel, Row, Stat, Pill, Dot } from "./components";
import { AwaitingDeployment } from "./Layout";
import { fmtGrouped, fmtSig, DASH } from "./format";
import { AGORA, ZERO, explorerAddr } from "./chain";
import {
  readStakePosition, readRedeemerAllowance, readMyRequests, quoteRedeem,
  approveAgoraForRedeemer, requestRedeem, executeRedeem, type RedeemRequest,
} from "./vault";
import { useSnapshot } from "./useReads";
import type { Wallet } from "./eth";

const deployed = AGORA.redeemer !== ZERO;

function when(ts: number): string {
  const d = ts * 1000 - Date.now();
  if (d <= 0) return "ready";
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export default function Redeem({ wallet }: { wallet: Wallet }) {
  const { data: s } = useSnapshot();
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [queue, setQueue] = useState<RedeemRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet.account) { setBalance(null); setAllowance(null); setQueue([]); return; }
    const [p, a, q] = await Promise.all([
      readStakePosition(wallet.account),
      readRedeemerAllowance(wallet.account),
      readMyRequests(wallet.account),
    ]);
    setBalance(p.agoraBalance);
    setAllowance(a);
    setQueue(q);
  }, [wallet.account]);

  useEffect(() => { void refresh(); }, [refresh]);

  const parsed = useMemo(() => {
    const t = amount.trim();
    if (!t) return 0n;
    try { return parseEther(t); } catch { return null; }
  }, [amount]);

  useEffect(() => {
    if (!parsed || parsed <= 0n) { setQuote(null); return; }
    let alive = true;
    quoteRedeem(parsed).then((q) => alive && setQuote(q)).catch(() => {});
    return () => { alive = false; };
  }, [parsed]);

  const overBalance = parsed !== null && balance !== null && parsed > balance;
  const needsApproval =
    parsed !== null && parsed > 0n && allowance !== null && allowance < parsed;

  const run = async (label: string, fn: (signer: any) => Promise<string>) => {
    setErr(null); setTx(null); setBusy(label);
    try {
      if (!wallet.onCorrectChain) await wallet.switchChain();
      setTx(await fn(await wallet.getSigner()));
      setAmount("");
      await refresh();
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.reason ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(null);
    }
  };

  const r = s?.reserve;
  const rd = s?.redeem;
  const haircutPct = rd?.haircutBps != null ? Number(rd.haircutBps) / 100 : 5;
  const delayHrs = rd?.redeemDelay != null ? Number(rd.redeemDelay) / 3600 : 24;

  return (
    <>
      {!deployed && (
        <AwaitingDeployment
          what="Redeemer"
          why="Burning AGORA for a pro-rata share of the corpus is what turns an accumulating treasury into an actual price floor. Until it ships, the corpus is one-way."
          phase="Treasury + FeeSink → launch → Redeemer"
        />
      )}

      <div className="two">
        <Panel
          label="Burn AGORA for reserve"
          id={`${haircutPct}% haircut`}
          right={
            <Pill warn={!deployed || rd?.requestsPaused === true}>
              <Dot kind={rd?.requestsPaused ? "warn" : deployed ? "ok" : "off"} />
              {rd?.requestsPaused ? "paused" : deployed ? "live" : "not deployed"}
            </Pill>
          }
        >
          <div className="field">
            <div className="field-top">
              <span className="k">Amount to burn</span>
              <span className="bal">
                balance <b>{balance !== null ? fmtGrouped(balance, 2) : DASH}</b> AGORA
              </span>
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!deployed || !wallet.account}
              />
              <span className="denom">AGORA</span>
            </div>
          </div>

          <div className="quote">
            <div className="qrow">
              <span className="qk">Floor per AGORA</span>
              <span className="qv">
                {r?.floorPerTokenWad != null ? `${fmtSig(r.floorPerTokenWad)} ETH` : DASH}
              </span>
            </div>
            <div className="qrow">
              <span className="qk">Haircut retained by the corpus</span>
              <span className="qv tax">{haircutPct}%</span>
            </div>
            <div className="qrow">
              <span className="qk">You would receive</span>
              <span className="qv">{quote != null ? `${fmtSig(quote)} ETH` : DASH}</span>
            </div>
            <div className="qrow">
              <span className="qk">Claimable after</span>
              <span className="qv">{delayHrs}h</span>
            </div>
          </div>

          {!wallet.account ? (
            <button className="btn" onClick={wallet.connect} disabled={!deployed}>
              {deployed ? "Connect wallet" : "Awaiting Redeemer"}
            </button>
          ) : needsApproval ? (
            <button className="btn" disabled={!!busy} onClick={() => run("approve", approveAgoraForRedeemer)}>
              {busy === "approve" ? "Approving…" : "Approve AGORA"}
            </button>
          ) : (
            <button
              className="btn danger"
              disabled={!deployed || !!busy || !parsed || parsed <= 0n || overBalance || rd?.requestsPaused === true}
              onClick={() => run("request", (sg) => requestRedeem(sg, parsed!))}
            >
              {busy === "request" ? "Burning…"
                : overBalance ? "Insufficient balance"
                : "Burn and queue"}
            </button>
          )}

          {err && <div className="err">{err}</div>}
          {tx && <div className="txnote">Confirmed · {tx.slice(0, 18)}…</div>}

          <p className="sub">
            <b>The burn happens immediately and cannot be cancelled.</b> Your tokens are destroyed when
            you queue, not when you claim — which is what makes the supply drop, and the floor rise for
            everyone else, right away. Re-minting is impossible: AGORA's supply is fixed by the Pons
            factory.
          </p>
        </Panel>

        <div>
          <div className="grid c2">
            <Stat
              k="Floor per AGORA"
              value={r?.floorPerTokenWad != null ? fmtSig(r.floorPerTokenWad) : null}
              unit="ETH"
            />
            <Stat
              k="Reserve"
              value={r?.navWad != null ? formatEther(r.navWad) : null}
              unit="ETH"
              note="excludes income owed to stakers"
            />
          </div>

          <div style={{ height: 14 }} />

          <Panel label="Your queue" id={`${queue.length} request${queue.length === 1 ? "" : "s"}`}>
            {queue.length === 0 ? (
              <p className="sub" style={{ marginTop: 0 }}>
                {wallet.account ? "No redemption requests." : "Connect a wallet to see your queue."}
              </p>
            ) : (
              <div className="rows">
                {queue.map((q) => (
                  <Row key={q.id} k={`#${q.id} · ${fmtGrouped(q.amount, 0)} AGORA`}>
                    {q.executed ? (
                      <span className="muted">claimed</span>
                    ) : q.ready ? (
                      <button
                        className="mini"
                        aria-selected
                        disabled={!!busy}
                        onClick={() => run(`exec-${q.id}`, (sg) => executeRedeem(sg, q.id))}
                      >
                        {busy === `exec-${q.id}` ? "claiming…" : `claim ${fmtSig(q.paid)} ETH`}
                      </button>
                    ) : (
                      <span className="muted">{when(q.executableAt)}</span>
                    )}
                  </Row>
                ))}
              </div>
            )}
            <p className="sub">
              Anyone can execute a matured request; it always pays the original owner, so a friend or a
              keeper can crank the queue for you.
            </p>
          </Panel>

          <div style={{ height: 14 }} />

          <Panel label="Terms">
            <div className="rows">
              <Row k="Haircut" na={rd?.haircutBps == null}>
                {rd?.haircutBps != null ? `${Number(rd.haircutBps) / 100}% — stays in the corpus` : "not deployed"}
              </Row>
              <Row k="Delay" na={rd?.redeemDelay == null}>
                {rd?.redeemDelay != null ? `${Number(rd.redeemDelay) / 3600} hours` : "not deployed"}
              </Row>
              <Row k="Per-epoch cap" na={rd?.epochCapBps == null}>
                {rd?.epochCapBps != null ? `${Number(rd.epochCapBps) / 100}% of reserve` : "not deployed"}
              </Row>
              <Row k="Capacity left this epoch" na={rd?.epochRemaining == null}>
                {rd?.epochRemaining != null ? `${formatEther(rd.epochRemaining)} ETH` : "not deployed"}
              </Row>
              <Row k="Burned to date" na={rd?.totalBurned == null}>
                {rd?.totalBurned != null ? `${fmtGrouped(rd.totalBurned, 0)} AGORA` : "not deployed"}
              </Row>
              <Row k="Redeemer contract" na={!deployed}>
                {deployed ? (
                  <a className="rv" href={explorerAddr(AGORA.redeemer)} target="_blank" rel="noreferrer">
                    {AGORA.redeemer.slice(0, 14)}…
                  </a>
                ) : "not deployed"}
              </Row>
            </div>
            <p className="sub">
              You are paid at <code>min(snapshot, current)</code> — the floor when you queued, or the floor
              when you claim, whichever is lower. That blocks queueing during a spike to claim afterwards,
              and its mirror. Because burns ratchet the floor upward, the snapshot usually binds.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
