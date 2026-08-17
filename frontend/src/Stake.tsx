import { useEffect, useMemo, useState } from "react";
import { parseEther } from "ethers";
import { Panel, Row, Stat, Pill, Dot } from "./components";
import { AwaitingDeployment } from "./Layout";
import { fmtGrouped, DASH } from "./format";
import { AGORA, ZERO, explorerAddr } from "./chain";
import { readTokenBalance } from "./curve";
import { useSnapshot } from "./useReads";
import type { Wallet } from "./eth";

const deployed = AGORA.stakedAgora !== ZERO;

export default function Stake({ wallet }: { wallet: Wallet }) {
  const { data: s } = useSnapshot();
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
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

  return (
    <>
      {!deployed && (
        <AwaitingDeployment
          what="stAGORA"
          why="Staking is an ERC-4626 vault over AGORA that pays realised yield in USDG via pull-claim. It cannot exist before the Treasury that funds it."
          phase="Treasury → Redeemer → stAGORA"
        />
      )}

      <div className="two">
        <Panel
          label={mode === "stake" ? "Stake AGORA" : "Unstake AGORA"}
          id="ERC-4626"
          right={<Pill warn={!deployed}><Dot kind={deployed ? "ok" : "off"} />{deployed ? "live" : "not deployed"}</Pill>}
        >
          <div className="swapdir">
            <button className="mini" aria-selected={mode === "stake"} onClick={() => setMode("stake")}>Stake</button>
            <button className="mini" aria-selected={mode === "unstake"} onClick={() => setMode("unstake")}>Unstake</button>
          </div>

          <div className="field">
            <div className="field-top">
              <span className="k">{mode === "stake" ? "Amount to stake" : "Shares to redeem"}</span>
              <span className="bal">
                balance <b>{balance !== null ? fmtGrouped(balance, 0) : DASH}</b> AGORA
              </span>
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!deployed}
              />
              <span className="denom">{mode === "stake" ? "AGORA" : "stAGORA"}</span>
            </div>
          </div>

          {!wallet.account ? (
            <button className="btn" onClick={wallet.connect} disabled={!deployed}>Connect wallet</button>
          ) : (
            <button className="btn" disabled={!deployed || !parsed || parsed <= 0n}>
              {deployed ? (mode === "stake" ? "Stake" : "Unstake") : "Awaiting stAGORA"}
            </button>
          )}

          <button className="btn ghost" style={{ marginTop: 8 }} disabled={!deployed}>
            {deployed ? "Claim USDG yield" : "Claim — awaiting Distributor"}
          </button>

          <p className="sub">
            Staking exists so eligible supply is simply <code>stAGORA.totalSupply()</code>. The alternative —
            accruing to every holder in a transfer hook — needs an exclusion set covering the pool, treasury
            and burns, and any error in it drifts permanently.
          </p>
        </Panel>

        <div>
          <div className="grid c2">
            <Stat k="Total staked" value={s?.staking.totalAssets ? fmtGrouped(s.staking.totalAssets, 0) : null} unit="AGORA" />
            <Stat k="stAGORA supply" value={s?.staking.totalShares ? fmtGrouped(s.staking.totalShares, 0) : null} unit="stAGORA" />
          </div>

          <div style={{ height: 14 }} />

          <Panel label="Yield" id="realised only">
            <div className="rows">
              <Row k="Distributions to date" na={!deployed}>{deployed ? DASH : "none yet"}</Row>
              <Row k="Paid in">USDG, pull-claim</Row>
              <Row k="Source">Beefy surplus above a principal high-water mark</Row>
              <Row k="stAGORA contract" na={!deployed}>
                {deployed ? (
                  <a className="rv" href={explorerAddr(AGORA.stakedAgora)} target="_blank" rel="noreferrer">
                    {AGORA.stakedAgora.slice(0, 12)}…
                  </a>
                ) : "not deployed"}
              </Row>
            </div>
            <p className="sub">
              No projected APY is shown, deliberately. Beefy on this chain holds ~$125k across 40 LP-only
              vaults, so the corpus will exceed available capacity almost immediately and the sleeve starts
              at zero. Realised distributions get reported here; a forecast would be fiction.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
