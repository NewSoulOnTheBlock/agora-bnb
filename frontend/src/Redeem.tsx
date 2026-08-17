import { useEffect, useMemo, useState } from "react";
import { parseEther } from "ethers";
import { Panel, Row, Stat, Pill, Dot } from "./components";
import { AwaitingDeployment } from "./Layout";
import { fmtGrouped, fmtSig, bpsToPct, DASH } from "./format";
import { AGORA, ZERO, explorerAddr } from "./chain";
import { readTokenBalance } from "./curve";
import { useSnapshot } from "./useReads";
import type { Wallet } from "./eth";

const deployed = AGORA.redeemer !== ZERO;

const HAIRCUT_BPS = 500n; // 5% — spec §7
const WAD = 10n ** 18n;

export default function Redeem({ wallet }: { wallet: Wallet }) {
  const { data: s } = useSnapshot();
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);

  useEffect(() => {
    if (!wallet.account) { setBalance(null); return; }
    let alive = true;
    readTokenBalance(wallet.account).then((b) => alive && setBalance(b)).catch(() => {});
    return () => { alive = false; };
  }, [wallet.account]);

  const parsed = useMemo(() => {
    try { return amount.trim() ? parseEther(amount.trim()) : 0n; } catch { return null; }
  }, [amount]);

  const floor = s?.reserve.floorPerTokenWad ?? null;
  const haircut = s?.redeem.haircutBps ?? HAIRCUT_BPS;

  // Deliberately quoted low: payout uses min(snapshot, current), so the actual
  // amount can only land at or above what we show here.
  const estPayout = useMemo(() => {
    if (!parsed || parsed <= 0n || !floor) return null;
    const gross = (parsed * floor) / WAD;
    return (gross * (10_000n - BigInt(haircut))) / 10_000n;
  }, [parsed, floor, haircut]);

  return (
    <>
      {!deployed && (
        <AwaitingDeployment
          what="Redeemer"
          why="Burning AGORA for a pro-rata slice of the corpus is what makes the floor enforceable. It ships before staking, because the floor works at any corpus size and any volume — including zero."
          phase="Treasury → Redeemer → stAGORA"
        />
      )}

      <div className="two">
        <Panel
          label="Burn AGORA for corpus"
          id={`${bpsToPct(haircut)} haircut · queued`}
          right={<Pill warn={!deployed}><Dot kind={deployed ? "ok" : "off"} />{deployed ? "live" : "not deployed"}</Pill>}
        >
          <div className="field">
            <div className="field-top">
              <span className="k">Amount to burn</span>
              <span className="bal">balance <b>{balance !== null ? fmtGrouped(balance, 0) : DASH}</b> AGORA</span>
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!deployed}
              />
              <span className="denom">AGORA</span>
            </div>
          </div>

          {/* The burn-now / paid-later shape is the riskiest UX here, so it is
              spelled out before the button rather than after. */}
          <div className="blocked">
            <b>Burning is immediate; payment is not.</b> Your AGORA is destroyed when you request, which
            is what lifts the floor for everyone who stays. Payment arrives after the delay, priced at the{" "}
            <b>lower</b> of the floor now and the floor at execution — so the figure below can only be met
            or beaten, never undershot.
          </div>

          <div className="quote" style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}>
            <div className="qrow emph">
              <span className="qk">Estimated payout</span>
              <span className="qv">{estPayout !== null ? `${fmtSig(estPayout, 6)} USDG` : DASH}</span>
            </div>
            <div className="qrow">
              <span className="qk">Floor per token</span>
              <span className="qv">{floor ? fmtSig(floor, 6) : "awaiting Treasury"}</span>
            </div>
            <div className="qrow tax">
              <span className="qk">Haircut (stays in corpus)</span>
              <span className="qv">−{bpsToPct(haircut)}</span>
            </div>
            <div className="qrow">
              <span className="qk">Claimable after</span>
              <span className="qv">
                {s?.redeem.redeemDelay ? `${Number(s.redeem.redeemDelay) / 86400} days` : DASH}
              </span>
            </div>
          </div>

          {!wallet.account ? (
            <button className="btn" onClick={wallet.connect} disabled={!deployed}>Connect wallet</button>
          ) : (
            <button className="btn" disabled={!deployed || !parsed || parsed <= 0n || !floor}>
              {deployed ? "Request redemption" : "Awaiting Redeemer"}
            </button>
          )}

          <p className="sub">
            The haircut is not a fee to anyone — it stays in the corpus, so every redemption raises the
            floor for holders who don't redeem. That is what makes this a floor rather than a run.
          </p>
        </Panel>

        <div>
          <div className="grid c2">
            <Stat k="Total burned" value={s?.redeem.totalBurned ? fmtGrouped(s.redeem.totalBurned, 0) : null} unit="AGORA" />
            <Stat k="Floor / token" value={floor ? fmtSig(floor, 6) : null} unit="ETH" />
          </div>

          <div style={{ height: 14 }} />

          <Panel label="Your queue" id="burned, awaiting execution">
            <div className="rows">
              <Row k="Pending requests" na={!deployed}>{deployed ? "0" : "not deployed"}</Row>
            </div>
            <p className="sub">
              Requests appear here with a countdown and an execute button once the delay elapses.
            </p>
          </Panel>

          <div style={{ height: 14 }} />

          <Panel label="Mechanics" id="spec §7">
            <div className="rows">
              <Row k="Burn">real — PonsV2LauncherToken exposes burn()/burnFrom()</Row>
              <Row k="Pricing">min(snapshot at request, current at execute)</Row>
              <Row k="Paid from">USDG core, so no forced Beefy liquidation</Row>
              <Row k="Per-epoch cap">limits how much corpus can exit at once</Row>
              <Row k="Redeemer" na={!deployed}>
                {deployed ? (
                  <a className="rv" href={explorerAddr(AGORA.redeemer)} target="_blank" rel="noreferrer">
                    {AGORA.redeemer.slice(0, 12)}…
                  </a>
                ) : "not deployed"}
              </Row>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
