import { useEffect, useState } from "react";
import { Panel, Stat, Row, Dot, Pill } from "./components";
import { useSnapshot, useTaxHistory, useFloorHistory } from "./useReads";
import { fmtSig, fmtGrouped, bpsToPct, signedPct, shortAddr, DASH } from "./format";
import { V4, PONS, AGORA, ZERO, explorerAddr, AGORA_TAX_BPS, ETH_USD_FEED } from "./chain";
import { readCurveState, type CurveState } from "./curve";

export default function Floor() {
  const { data: s, loading, error, refresh } = useSnapshot();
  const [curve, setCurve] = useState<CurveState | null>(null);
  useEffect(() => {
    let alive = true;
    const go = () => readCurveState().then((c) => alive && setCurve(c));
    go();
    const t = setInterval(go, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const tax = useTaxHistory(s?.pool.id, !!s?.pool.initialised);
  const floor = useFloorHistory(AGORA.treasury !== ZERO);

  const cumulativeTax = tax.data?.length ? tax.data[tax.data.length - 1].cumulativeTax : null;

  return (
    <>
      <div style={{ marginBottom: 14, display: "flex", gap: 8, alignItems: "center" }}>
        <Pill>
          <Dot kind={error ? "warn" : loading ? "off" : "live"} />
          {error ? "rpc error" : loading ? "reading" : `blk ${s?.blockNumber ?? DASH}`}
        </Pill>
        {curve && (
          <Pill warn={!curve.graduated}>
            {curve.graduated ? "graduated" : `curve · ${curve.graduationPct.toFixed(2)}% to graduation`}
          </Pill>
        )}
      </div>

        {curve && !curve.graduated && (
          <div className="notice">
            <b>AGORA is live on the Pons bonding curve.</b> Market price, the 4% creator tax and the
            graduation figures below are read from the curve at{" "}
            <a className="link" href={explorerAddr(AGORA.curve)} target="_blank" rel="noreferrer">
              {AGORA.curve.slice(0, 10)}…
            </a>. Reserve, floor, staking and redemption read as <b>not deployed</b> because those
            contracts do not exist yet — shown as gaps rather than zeros that would look like measurements.
          </div>
        )}

        {error && (
          <div className="notice">
            <b>RPC error.</b> {error}{" "}
            <button className="tab" onClick={refresh} style={{ marginLeft: 8 }}>retry</button>
          </div>
        )}

        {/* ---- hero: the two numbers the whole product is about ---- */}
        <div className="hero">
          <Panel label="Floor per token" id="nav ÷ eligible supply" right={<Pill warn>awaiting Treasury</Pill>}>
            <div className="big muted">
              {s?.reserve.floorPerTokenWad ? fmtSig(s.reserve.floorPerTokenWad) : "—"}
              <span className="unit">ETH</span>
            </div>
            <p className="sub">
              The redemption floor. Ratchets up on every taxed swap and every redemption, because the
              5% haircut stays in the corpus. Live once <code>Treasury</code> ships.
            </p>
          </Panel>

          <Panel label="Market price" id={s?.pool.initialised ? "uniswap v4 · StateView" : "pons curve"}>
            <div className={`big${(s?.pool.priceWad ?? curve?.priceWad) ? "" : " muted"}`}>
              {s?.pool.priceWad ? fmtSig(s.pool.priceWad) : curve ? fmtSig(curve.priceWad) : "—"}
              <span className="unit">ETH</span>
            </div>
            <p className="sub">
              {s?.pool.initialised ? (
                <>
                  Premium to floor{" "}
                  <span className={`premium ${(s.premiumPct ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {signedPct(s.premiumPct)}
                  </span>
                  {s.premiumPct === null && " — needs both sides"}
                </>
              ) : (
                <>
                  Priced from the bonding curve. Graduates into a Uniswap v4 pool at 4.2 ETH —
                  currently {curve ? `${curve.graduationPct.toFixed(2)}%` : "—"} of the way.
                </>
              )}
            </p>
          </Panel>
        </div>

        {/* ---- corpus ---- */}
        <div className="section">
          <p className="label">Corpus <span className="id">§4 · USDG core + capped Beefy sleeve</span></p>
          <div className="grid c4">
            <Stat k="NAV" value={s?.reserve.navWad ? fmtGrouped(s.reserve.navWad) : null} unit="USDG"
              note="AGORA always marked at zero (§6)" />
            <Stat k="USDG core" value={s?.reserve.usdgBalance ? fmtGrouped(s.reserve.usdgBalance) : null} unit="USDG" />
            <Stat k="Beefy sleeve" value={s?.reserve.sleeveAssets ? fmtGrouped(s.reserve.sleeveAssets) : null} unit="USDG"
              note="double-capped; starts at 0" />
            <Stat k="Eligible supply" value={s?.reserve.eligibleSupply ? fmtGrouped(s.reserve.eligibleSupply, 0) : null}
              unit="AGORA" note="excl. burned + protocol-held" />
          </div>
        </div>

        {/* ---- the Pons fee pipeline: fully live today ---- */}
        <div className="section">
          <p className="label">
            Tax pipeline <span className="id">§14.4 · live from V2MemeHook</span>
          </p>
          <div className="grid c3">
            <Stat k="Accrued in hook"
              value={s?.fees.pendingCreatorTaxEth !== null && s?.fees.pendingCreatorTaxEth !== undefined
                ? fmtSig(s.fees.pendingCreatorTaxEth) : null}
              unit="ETH"
              note="pendingCreatorTax — only Pons's operator can sweep this" />
            <Stat k="Claimable in escrow"
              value={s?.fees.escrowBalanceEth !== null && s?.fees.escrowBalanceEth !== undefined
                ? fmtSig(s.fees.escrowBalanceEth) : null}
              unit="ETH"
              note="V2FeeEscrow.balanceOf(FeeSink)" />
            <Stat k="Cumulative tax"
              value={cumulativeTax !== null ? fmtSig(cumulativeTax) : null}
              unit="ETH"
              note={tax.loading ? "scanning logs…" : `${tax.data?.length ?? 0} HookFeeCollected events`} />
          </div>
        </div>

        {/* ---- proof: every input, traceable ---- */}
        <div className="section">
          <p className="label">Proof <span className="id">every number above, traceable</span></p>
          <Panel>
            <div className="rows">
              <Row k="Token">
                <a className="rv" href={explorerAddr(s?.token.address ?? ZERO)} target="_blank" rel="noreferrer">
                  {s?.token.name ?? DASH} {s?.token.symbol ? `(${s.token.symbol})` : ""}
                </a>
              </Row>
              <Row k="poolId (keccak256 of PoolKey)">{s?.pool.id ?? DASH}</Row>
              <Row k="PoolKey.currency0">
                {s?.pool.key.currency0 === ZERO ? "0x000…000 (native ETH)" : shortAddr(s?.pool.key.currency0)}
              </Row>
              <Row k="PoolKey.currency1">{shortAddr(s?.pool.key.currency1)}</Row>
              <Row k="PoolKey.fee / tickSpacing">
                {s?.pool.key.fee ?? DASH} / {s?.pool.key.tickSpacing ?? DASH} (dynamic fee via hook)
              </Row>
              <Row k="PoolKey.hooks">
                <a className="rv" href={explorerAddr(PONS.memeHook)} target="_blank" rel="noreferrer">
                  {shortAddr(PONS.memeHook)} · V2MemeHook
                </a>
              </Row>
              <Row k="sqrtPriceX96">{s?.pool.sqrtPriceX96?.toString() ?? DASH}</Row>
              <Row k="tick / liquidity">
                {s?.pool.tick ?? DASH} / {s?.pool.liquidity?.toString() ?? DASH}
              </Row>
              <Row k="Creator tax (set at launch)">{bpsToPct(AGORA_TAX_BPS)} · cap {bpsToPct(PONS.maxCreatorTaxBps)}</Row>
              <Row k="Pool fee → creator share">
                {bpsToPct(s?.fees.hookFeeBps ?? PONS.hookFeeBps)} → {bpsToPct(PONS.creatorFeeShareBps)}
              </Row>
              <Row k="feeSweepOperator (not ours)">
                <a className="rv" href={explorerAddr(s?.fees.feeSweepOperator ?? PONS.feeSweepOperator)} target="_blank" rel="noreferrer">
                  {shortAddr(s?.fees.feeSweepOperator ?? PONS.feeSweepOperator)}
                </a>
              </Row>
              <Row k="StateView">
                <a className="rv" href={explorerAddr(V4.stateView)} target="_blank" rel="noreferrer">{shortAddr(V4.stateView)}</a>
              </Row>
              <Row k="PoolManager">
                <a className="rv" href={explorerAddr(V4.poolManager)} target="_blank" rel="noreferrer">{shortAddr(V4.poolManager)}</a>
              </Row>
              <Row k="Treasury" na={AGORA.treasury === ZERO}>
                {AGORA.treasury === ZERO ? "not deployed" : shortAddr(AGORA.treasury)}
              </Row>
              <Row k="stAGORA" na={AGORA.stakedAgora === ZERO}>
                {AGORA.stakedAgora === ZERO ? "not deployed" : shortAddr(AGORA.stakedAgora)}
              </Row>
              <Row k="Redeemer" na={AGORA.redeemer === ZERO}>
                {AGORA.redeemer === ZERO ? "not deployed" : shortAddr(AGORA.redeemer)}
              </Row>
              <Row k="ETH/USD feed" na={!ETH_USD_FEED}>
                {ETH_USD_FEED ?? "unset — USD figures intentionally withheld"}
              </Row>
              <Row k="Floor history" na={!floor.data?.length}>
                {floor.loading ? "scanning…" : `${floor.data?.length ?? 0} FloorUpdated events`}
                {floor.regressions.length > 0 && ` · ⚠ ${floor.regressions.length} REGRESSIONS`}
              </Row>
            </div>
          </Panel>
        </div>

    </>
  );
}
