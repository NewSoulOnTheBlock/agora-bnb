import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseUnits } from "ethers";
import { Panel, Row, Stat, Pill, Dot, Balance } from "./components";
import StakePitch from "./StakePitch";
import { AwaitingDeployment } from "./Layout";
import { fmtGrouped, fmtSig, DASH } from "./format";
import { TORII, ZERO, explorerAddr, SUITS_SHARE_BPS, ST_TORII_DECIMALS } from "./chain";
import {
  readStakePosition, approveToriiForStaking, stakeTorii, unstakeTorii,
  claimToriiYield, type StakePosition,
} from "./vault";
import { useSnapshot } from "./useReads";
import type { Wallet } from "./eth";

const deployed = TORII.stakedAgora !== ZERO;
const toriiLive = TORII.token !== ZERO;

export default function Stake({ wallet }: { wallet: Wallet }) {
  const { data: s } = useSnapshot();
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [pos, setPos] = useState<StakePosition | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet.account) { setPos(null); return; }
    setPos(await readStakePosition(wallet.account));
  }, [wallet.account]);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * The field means different tokens in the two modes, and they do not share a
   * scale: `deposit` takes TORII assets at 18dp, `redeem` takes stTORII shares
   * at 21dp. Parsing both as ether would send a redeem a thousand times too
   * small — the user would type their whole balance and unstake a thousandth
   * of it.
   */
  const decimals = mode === "stake" ? 18 : ST_TORII_DECIMALS;

  const parsed = useMemo(() => {
    const t = amount.trim();
    if (!t) return 0n;
    try { return parseUnits(t, decimals); } catch { return null; }
  }, [amount, decimals]);

  const balance = mode === "stake" ? pos?.toriiBalance ?? null : pos?.shares ?? null;
  const needsApproval =
    mode === "stake" && parsed !== null && parsed > 0n &&
    pos?.allowance !== null && pos?.allowance !== undefined && pos.allowance < parsed;

  const overBalance = parsed !== null && balance !== null && parsed > balance;

  const run = async (label: string, fn: (signer: any) => Promise<string>) => {
    setErr(null); setTx(null); setBusy(label);
    try {
      if (!wallet.onCorrectChain) { await wallet.switchChain(); }
      const signer = await wallet.getSigner();
      setTx(await fn(signer));
      setAmount("");
      await refresh();
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.reason ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(null);
    }
  };

  const canSubmit =
    deployed && !!wallet.account && !busy &&
    parsed !== null && parsed > 0n && !overBalance;

  return (
    <>
      {!deployed && (
        <AwaitingDeployment
          what="stTORII"
          why="An ERC-4626 vault over TORII. Stakers receive the protocol's income stream in ETH; passive holders keep the redemption floor."
          phase="Treasury + FeeSink → launch → stTORII, Redeemer, StakedSuits, Distributor"
        />
      )}

      <StakePitch />

      <div className="two">
        <Panel
          label={mode === "stake" ? "Stake TORII" : "Unstake TORII"}
          id="ERC-4626"
          right={
            <Pill warn={!deployed}>
              <Dot kind={deployed ? "ok" : "off"} />
              {deployed ? "live" : "unavailable"}
            </Pill>
          }
        >
          <div className="swapdir">
            <button className="mini" aria-selected={mode === "stake"} onClick={() => setMode("stake")}>Stake</button>
            <button className="mini" aria-selected={mode === "unstake"} onClick={() => setMode("unstake")}>Unstake</button>
          </div>

          <div className="field">
            <div className="field-top">
              <span className="k">{mode === "stake" ? "Amount to stake" : "Shares to redeem"}</span>
              <Balance
                value={balance}
                decimals={decimals}
                unit={mode === "stake" ? "TORII" : "stTORII"}
                onPick={setAmount}
              />
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!deployed || !wallet.account}
              />
              <span className="denom">{mode === "stake" ? "TORII" : "stTORII"}</span>
            </div>
          </div>

          {mode === "unstake" && pos?.sharesAsAssets != null && (
            <div className="quote">
              <div className="qrow">
                <span className="qk">Your shares are worth</span>
                <span className="qv">{fmtGrouped(pos.sharesAsAssets, 4)} TORII</span>
              </div>
              <div className="qrow">
                <span className="qk">Unclaimed yield (kept on unstake)</span>
                <span className="qv">{pos.pendingYield != null ? `${fmtSig(pos.pendingYield)} ETH` : DASH}</span>
              </div>
            </div>
          )}

          {!wallet.account ? (
            <button className="btn" onClick={wallet.connect} disabled={!deployed}>
              {deployed ? "Connect wallet" : "Awaiting stTORII"}
            </button>
          ) : needsApproval ? (
            <button className="btn" disabled={!canSubmit} onClick={() => run("approve", approveToriiForStaking)}>
              {busy === "approve" ? "Approving…" : "Approve TORII"}
            </button>
          ) : (
            <button
              className="btn"
              disabled={!canSubmit}
              onClick={() =>
                run(mode, (sg) =>
                  mode === "stake"
                    ? stakeTorii(sg, parsed!, wallet.account!)
                    : unstakeTorii(sg, parsed!, wallet.account!)
                )
              }
            >
              {busy === mode
                ? mode === "stake" ? "Staking…" : "Unstaking…"
                : overBalance ? "Insufficient balance"
                : mode === "stake" ? "Stake" : "Unstake"}
            </button>
          )}

          <button
            className="btn ghost"
            style={{ marginTop: 8 }}
            disabled={!deployed || !wallet.account || !!busy || !(pos?.pendingYield && pos.pendingYield > 0n)}
            onClick={() => run("claim", claimToriiYield)}
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
            Eligible supply for income is simply <code>stTORII.totalSupply()</code>. The alternative —
            accruing to every holder through a transfer hook — is not even possible here: TORII is deployed
            by the Pons factory with no hooks and no way to add them.
          </p>
        </Panel>

        <div>
          <div className="grid c2">
            <Stat
              k="Your position"
              value={pos?.shares != null ? fmtGrouped(pos.shares, 2, ST_TORII_DECIMALS) : null}
              unit="stTORII"
              note={pos?.pendingYield != null ? `${fmtSig(pos.pendingYield)} ETH unclaimed` : undefined}
            />
            <Stat
              k="Total staked"
              value={s?.staking.totalAssets != null ? fmtGrouped(s.staking.totalAssets, 0) : null}
              unit="TORII"
            />
          </div>

          <div style={{ height: 14 }} />

          <Panel label="Income" id="realised only">
            <div className="rows">
              <Row k="Paid to stakers" na={s?.staking.cumulativeRewards == null}>
                {s?.staking.cumulativeRewards != null
                  ? `${formatEther(s.staking.cumulativeRewards)} ETH`
                  : "unavailable"}
              </Row>
              <Row k="Claimed so far" na={s?.staking.cumulativeClaimed == null}>
                {s?.staking.cumulativeClaimed != null
                  ? `${formatEther(s.staking.cumulativeClaimed)} ETH`
                  : "unavailable"}
              </Row>
              <Row k="Your share of income">
                {(10000 - SUITS_SHARE_BPS) / 100}% — staked Suits take {SUITS_SHARE_BPS / 100}%
              </Row>
              <Row k="Awaiting distribution" na={s?.reserve.pendingIncome == null}>
                {s?.reserve.pendingIncome != null
                  ? `${formatEther(s.reserve.pendingIncome)} ETH`
                  : "unavailable"}
              </Row>
              <Row k="stTORII contract" na={!deployed}>
                {deployed ? (
                  <a className="rv" href={explorerAddr(TORII.stakedAgora)} target="_blank" rel="noreferrer">
                    {TORII.stakedAgora.slice(0, 14)}…
                  </a>
                ) : "unavailable"}
              </Row>
            </div>

            <p className="sub">
              Rewards are ETH and stay <em>outside</em> <code>totalAssets()</code>, so the share price never
              moves — shares track deposits one-to-one and yield accrues separately. Inflating the share
              price with ETH income would make <code>convertToAssets</code> report TORII the vault does not
              hold.
            </p>
          </Panel>

          <div style={{ height: 14 }} />

          <Panel label="Where income comes from">
            <div className="rows">
              <Row k="Tax routed to income" na={s?.reserve.incomeShareBps == null}>
                {s?.reserve.incomeShareBps != null
                  ? `${Number(s.reserve.incomeShareBps) / 100}%`
                  : "unavailable"}
              </Row>
              <Row k="Yield sleeve" na={s?.reserve.sleeveCapBps == null}>
                {s?.reserve.sleeveCapBps != null
                  ? `${Number(s.reserve.sleeveCapBps) / 100}% of NAV`
                  : "unavailable"}
              </Row>
              <Row k="Unrealised sleeve gain" na={s?.reserve.unrealizedSurplus == null}>
                {s?.reserve.unrealizedSurplus != null
                  ? `${formatEther(s.reserve.unrealizedSurplus)} ETH`
                  : "unavailable"}
              </Row>
            </div>
            <p className="sub">
              No projected APY is shown, deliberately. Beefy on this chain holds roughly $125k across 40
              LP-only vaults, so the sleeve starts at zero and every allocation is a manual, governed
              decision. Only realised surplus is ever distributed; a forecast would be fiction.
            </p>
          </Panel>
        </div>
      </div>

      {!toriiLive && (
        <div className="notice" style={{ marginTop: 18 }}>
          <b>TORII has not been relaunched yet.</b> Balances read as unavailable because no token address
          is configured. Everything above is wired against the deployed ABIs — filling in{" "}
          <code>src/chain.ts</code> from the output of <code>bind.ts</code> activates it.
        </div>
      )}
    </>
  );
}
