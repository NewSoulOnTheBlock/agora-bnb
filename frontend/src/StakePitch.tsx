import { useEffect, useState } from "react";
import { parseEther } from "ethers";
import { Panel, Stat, Row } from "./components";
import { fmtSig, fmtGrouped, DASH } from "./format";
import { usdOf, fmtUsd } from "./price";
import { useSnapshot, useEthUsd } from "./useReads";
import { readIncomeHistory, type IncomeHistory } from "./history";
import { TORII_TAX_BPS } from "./chain";

/**
 * The case for staking, made out of things that have already happened.
 *
 * The Stake page used to open with an ERC-4626 form and a paragraph about
 * transfer hooks. Correct, and it converts nobody: it never says what staking
 * has actually paid.
 *
 * ## The rule this page follows
 *
 * Every figure here is **backward-looking and windowed**. The existing copy
 * refuses to show a projected APY because "a forecast would be fiction", and
 * that is right — eighteen hours of launch volume annualised is a number with
 * no relationship to anything. So nothing is annualised, the measurement window
 * is printed beside the result, and the dependence on trading volume is stated
 * rather than buried.
 *
 * The calculator asks "what would this stake have earned over that window",
 * not "what will it earn". That is a division on settled events, and it is the
 * honest version of the question people are actually asking.
 */
export default function StakePitch() {
  const { data: s } = useSnapshot();
  const ethUsd = useEthUsd();
  const [income, setIncome] = useState<IncomeHistory | null>(null);
  const [amount, setAmount] = useState("10000000");

  useEffect(() => {
    let alive = true;
    readIncomeHistory()
      .then((h) => alive && setIncome(h))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const staking = s?.staking;
  const priceWad = s?.pool.priceWad ?? null;

  /** TORII locked in the vault, and what it is worth. */
  const stakedAgora = staking?.totalAssets ?? null;
  const stakedWei =
    stakedAgora !== null && priceWad !== null ? (stakedAgora * priceWad) / 10n ** 18n : null;

  const paid = staking?.cumulativeRewards ?? null;
  const claimed = staking?.cumulativeClaimed ?? null;
  const unclaimed = paid !== null && claimed !== null ? paid - claimed : null;

  /** Paid to stakers as a share of what is staked, over the measured window. */
  const trailingPct =
    paid !== null && stakedWei !== null && stakedWei > 0n
      ? (Number(paid) / Number(stakedWei)) * 100
      : null;

  const windowHours = income && income.windowSec > 0 ? income.windowSec / 3600 : null;

  /** BNB per day, measured across the same window. Not extrapolated further. */
  const perDay =
    income && windowHours && windowHours > 0
      ? (Number(income.total) / 1e18 / windowHours) * 24
      : null;

  // ---- the calculator -----------------------------------------------------
  let parsed: bigint | null = null;
  try {
    parsed = amount.trim() ? parseEther(amount.trim()) : null;
  } catch {
    parsed = null;
  }

  const share =
    parsed !== null && parsed > 0n && stakedAgora !== null
      ? Number(parsed) / (Number(stakedAgora) + Number(parsed))
      : null;

  const wouldHaveEarned =
    share !== null && paid !== null ? BigInt(Math.floor(Number(paid) * share)) : null;

  return (
    <>
      {/* ---- the headline: what has actually been paid out ---- */}
      <div className="section" style={{ marginTop: 0 }}>
        <Panel label="Paid to stakers, so far" id="not a projection — money already distributed">
          <div className={`big${paid ? "" : " muted"}`}>
            {paid !== null ? fmtSig(paid) : DASH}
            <span className="unit">BNB</span>
          </div>
          {usdOf(paid, ethUsd) && (
            <div className="pitch-usd">≈ {usdOf(paid, ethUsd)}</div>
          )}

          <p className="sub">
            <b>{TORII_TAX_BPS / 100}% of every buy and sell</b> goes to the protocol.{" "}
            <b>{s?.reserve.incomeShareBps != null ? Number(s.reserve.incomeShareBps) / 100 : 30}%</b>{" "}
            of that is paid out as income, all of it to people who stake TORII. The rest stays in
            the reserve and raises the floor for everyone, staked or not.
          </p>

          <div className="rows mini">
            <Row k="Distributions so far">
              {income ? `${income.count} payouts` : DASH}
            </Row>
            <Row k="Measured over">
              {windowHours !== null ? `${windowHours.toFixed(1)} hours` : DASH}
            </Row>
            <Row k="Pace across that window">
              {perDay !== null ? (
                <>
                  {perDay.toFixed(4)} BNB/day
                  {ethUsd !== null && (
                    <span className="muted"> · {fmtUsd(perDay * ethUsd)}/day</span>
                  )}
                </>
              ) : DASH}
            </Row>
            <Row k="Sitting unclaimed">
              {unclaimed !== null ? (
                <>
                  {fmtSig(unclaimed)} BNB
                  {usdOf(unclaimed, ethUsd) && (
                    <span className="muted"> · {usdOf(unclaimed, ethUsd)}</span>
                  )}
                </>
              ) : DASH}
            </Row>
          </div>
        </Panel>
      </div>

      {/* ---- the trailing figure, with its window attached ---- */}
      <div className="section">
        <div className="grid c3">
          <Stat
            k="Staked right now"
            value={stakedAgora !== null ? fmtGrouped(stakedAgora, 0) : null}
            unit="TORII"
            usd={usdOf(stakedWei, ethUsd)}
            note="locked in the stTORII vault"
          />
          <Stat
            k="Returned to stakers"
            value={trailingPct !== null ? `${trailingPct.toFixed(1)}` : null}
            unit="%"
            note={
              windowHours !== null
                ? `of the staked value, over ${windowHours.toFixed(1)}h — measured, not annualised`
                : "of the staked value so far"
            }
          />
          <Stat
            k="Your share pays"
            value={wouldHaveEarned !== null ? fmtSig(wouldHaveEarned) : null}
            unit="BNB"
            usd={usdOf(wouldHaveEarned, ethUsd)}
            note="what the amount below would have earned"
          />
        </div>
      </div>

      {/* ---- the calculator ---- */}
      <div className="section">
        <Panel label="What would my stake have earned?" id="over the window above">
          <div className="field">
            <div className="field-top">
              <span className="k">If I had staked</span>
              <span className="bal">
                vault holds {stakedAgora !== null ? fmtGrouped(stakedAgora, 0) : DASH} TORII
              </span>
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="10000000"
              />
              <span className="denom">TORII</span>
            </div>
          </div>

          <div className="swapdir" style={{ marginTop: 8 }}>
            {["1000000", "10000000", "50000000"].map((v) => (
              <button
                key={v}
                className="mini"
                aria-selected={amount === v}
                onClick={() => setAmount(v)}
              >
                {Number(v).toLocaleString("en-US")}
              </button>
            ))}
          </div>

          <div className="quote">
            <div className="qrow">
              <span className="qk">Share of the vault</span>
              <span className="qv">{share !== null ? `${(share * 100).toFixed(2)}%` : DASH}</span>
            </div>
            <div className="qrow">
              <span className="qk">
                Would have earned over {windowHours !== null ? `${windowHours.toFixed(1)}h` : "the window"}
              </span>
              <span className="qv">
                {wouldHaveEarned !== null ? `${fmtSig(wouldHaveEarned)} BNB` : DASH}
              </span>
            </div>
            {ethUsd !== null && wouldHaveEarned !== null && (
              <div className="qrow">
                <span className="qk">In dollars</span>
                <span className="qv">{usdOf(wouldHaveEarned, ethUsd)}</span>
              </div>
            )}
            <div className="qrow">
              <span className="qk">Cost to acquire, at the pool price</span>
              <span className="qv">
                {parsed !== null && priceWad !== null
                  ? `${fmtSig((parsed * priceWad) / 10n ** 18n)} BNB`
                  : DASH}
              </span>
            </div>
          </div>

          <p className="sub">
            <b className="tax">This is arithmetic on the past, not a promise about the future.</b>{" "}
            Staking income is a share of trading tax, so it tracks volume and nothing else — no
            volume, no income. The window above is short and it covers a launch, which is when
            volume is at its least typical. There is no yield from anywhere else: the sleeve is
            still at zero.
          </p>
        </Panel>
      </div>

      {/* ---- what staking does not cost you ---- */}
      <div className="section">
        <Panel label="What you keep while staked">
          <div className="rows">
            <Row k="Your TORII">
              still yours — the vault custodies it, one share per token
            </Row>
            <Row k="Your floor backing">
              unchanged — staked TORII still counts in eligible supply
            </Row>
            <Row k="Unstaking">
              any time, no lockup, no exit fee
            </Row>
            <Row k="Rewards already earned">
              yours even after you unstake — accrual is settled before any transfer
            </Row>
            <Row k="Paid in">
              BNB, not more TORII — so the reward is not diluting you
            </Row>
          </div>
          <p className="sub">
            The split is the whole design: passive holders get the floor, stakers get the income,
            both out of the same tax. Staking gives up nothing except the tokens sitting in your own
            wallet instead of the vault's.
          </p>
        </Panel>
      </div>
    </>
  );
}
