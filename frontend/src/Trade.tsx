import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { Panel, Row, Pill, Dot } from "./components";
import Chart from "./Chart";
import { fmtSig, fmtGrouped, bpsToPct, DASH } from "./format";
import { useSnapshot } from "./useReads";
import { AGORA, PONS, explorerAddr, readProvider } from "./chain";
import type { Wallet } from "./eth";
import {
  readCurveState, quoteBuy, quoteSell, applySlippage, curveBuy, curveSell,
  readCurveAllowance, approveCurve, readTokenBalance, dryRunCurve,
  type CurveState, type CurveQuote,
} from "./curve";

type Side = "buy" | "sell";
const SLIPPAGE_CHOICES = [50, 100, 300];

export default function Trade({ wallet }: { wallet: Wallet }) {
  const { data: snap } = useSnapshot();
  const pool = snap?.pool ?? null;

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [curve, setCurve] = useState<CurveState | null>(null);
  const [quote, setQuote] = useState<CurveQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balances, setBalances] = useState<{ eth: bigint | null; token: bigint | null }>({ eth: null, token: null });
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // curve state, polled
  useEffect(() => {
    let alive = true;
    const go = () => readCurveState().then((s) => alive && setCurve(s));
    go();
    const t = setInterval(go, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // balances + allowance
  useEffect(() => {
    if (!wallet.account) { setBalances({ eth: null, token: null }); setAllowance(null); return; }
    let alive = true;
    (async () => {
      try {
        const [eth, token, alw] = await Promise.all([
          readProvider.getBalance(wallet.account!),
          readTokenBalance(wallet.account!),
          readCurveAllowance(wallet.account!),
        ]);
        if (alive) { setBalances({ eth, token }); setAllowance(alw); }
      } catch { /* leave as null */ }
    })();
    return () => { alive = false; };
  }, [wallet.account, txHash]);

  const parsed = useMemo(() => {
    try { return amount.trim() ? parseEther(amount.trim()) : 0n; } catch { return null; }
  }, [amount]);

  // debounced quote
  useEffect(() => {
    if (!parsed || parsed <= 0n) { setQuote(null); return; }
    let alive = true;
    setQuoting(true);
    const t = setTimeout(async () => {
      const q = side === "buy"
        ? await quoteBuy(parsed, wallet.account)
        : await quoteSell(parsed, wallet.account);
      if (alive) { setQuote(q); setQuoting(false); }
    }, 300);
    return () => { alive = false; clearTimeout(t); setQuoting(false); };
  }, [parsed, side, wallet.account]);

  const minOut = quote ? applySlippage(quote.amountOut, slippageBps) : null;
  const needsApproval = side === "sell" && parsed !== null && allowance !== null && allowance < parsed;
  const graduated = curve?.graduated ?? false;

  const insufficient =
    parsed !== null && parsed > 0n &&
    (side === "buy" ? balances.eth !== null && parsed > balances.eth
                    : balances.token !== null && parsed > balances.token);

  async function act() {
    if (!wallet.account || !parsed || !minOut) return;
    setErr(null); setTxHash(null);
    try {
      // Simulate first: turns an opaque wallet failure into a readable reason.
      setBusy("simulating");
      const dry = await dryRunCurve(side, wallet.account, parsed, minOut);
      if (!dry.ok) { setErr(`Simulation failed: ${dry.reason}`); setBusy(null); return; }

      const signer = await wallet.getSigner();
      setBusy("confirm in wallet");
      const tx = side === "buy"
        ? await curveBuy(signer, parsed, minOut, wallet.account)
        : await curveSell(signer, parsed, minOut, wallet.account);
      setBusy("mining");
      await tx.wait();
      setTxHash(tx.hash);
      setAmount("");
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(null);
    }
  }

  async function doApprove() {
    if (!wallet.account) return;
    setErr(null);
    try {
      setBusy("approving");
      const signer = await wallet.getSigner();
      const tx = await approveCurve(signer);
      await tx.wait();
      setAllowance(await readCurveAllowance(wallet.account));
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? "Approval failed.");
    } finally { setBusy(null); }
  }

  const inDenom = side === "buy" ? "ETH" : "AGORA";
  const outDenom = side === "buy" ? "AGORA" : "ETH";

  return (
    <>
      {graduated ? (
        <div className="notice">
          <b>AGORA has graduated.</b> The bonding curve is closed and every trade now routes
          through the Uniswap v4 pool, priced by <code>StateView.getSlot0</code> rather than by
          the curve. The 4% creator tax still applies — it lives in the hook, not the curve, so
          graduation did not change it.
        </div>
      ) : (
        <div className="notice">
          <b>Trading on the bonding curve.</b> AGORA has not graduated
          {curve && <> — <b>{curve.graduationPct.toFixed(2)}%</b> of the 4.2 ETH threshold</>}, so there is no
          Uniswap v4 pool yet and all trades route through the Pons curve at{" "}
          <a className="link" href={explorerAddr(AGORA.curve)} target="_blank" rel="noreferrer">
            {AGORA.curve.slice(0, 10)}…
          </a>. The v4 path is built and validated; it activates automatically on graduation.
        </div>
      )}

      {graduated && (
        <div className="section" style={{ marginTop: 0 }}>
          <p className="label">
            Price <span className="id">from PoolManager Swap logs</span>
          </p>
          <Panel tight>
            <Chart />
          </Panel>
        </div>
      )}

      <div className="two">
        <Panel
          label={`${side === "buy" ? "Buy" : "Sell"} AGORA`}
          id={graduated ? "uniswap v4" : "pons v2 curve"}
          right={<Pill><Dot kind={graduated ? "ok" : "warn"} />{graduated ? "graduated" : "curve"}</Pill>}
        >
          <div className="swapdir">
            <button className="mini" aria-selected={side === "buy"} onClick={() => { setSide("buy"); setAmount(""); }}>Buy</button>
            <button className="mini" aria-selected={side === "sell"} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button>
          </div>

          <div className="field">
            <div className="field-top">
              <span className="k">You pay</span>
              <span className="bal">
                balance{" "}
                <b>
                  {side === "buy"
                    ? balances.eth !== null ? fmtSig(balances.eth, 6) : DASH
                    : balances.token !== null ? fmtGrouped(balances.token, 0) : DASH}
                </b>{" "}
                {inDenom}
              </span>
            </div>
            <div className="input-wrap">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!!busy}
              />
              <span className="denom">{inDenom}</span>
              <button
                className="mini"
                disabled={!!busy || (side === "buy" ? balances.eth === null : balances.token === null)}
                onClick={() => {
                  if (side === "sell" && balances.token !== null) setAmount(formatEther(balances.token));
                  // For ETH, leave headroom for gas rather than max-ing the balance.
                  else if (balances.eth !== null && balances.eth > parseEther("0.0005"))
                    setAmount(formatEther(balances.eth - parseEther("0.0005")));
                }}
              >
                max
              </button>
            </div>
          </div>

          <div className="field">
            <div className="field-top">
              <span className="k">Slippage</span>
              <span className="bal">min received enforced on-chain</span>
            </div>
            <div className="swapdir">
              {SLIPPAGE_CHOICES.map((b) => (
                <button key={b} className="mini" aria-selected={slippageBps === b} onClick={() => setSlippageBps(b)}>
                  {bpsToPct(b)}
                </button>
              ))}
            </div>
          </div>

          {amount && parsed === null && (
            <div className="blocked"><b>Invalid amount.</b> Enter a decimal number.</div>
          )}
          {insufficient && (
            <div className="blocked"><b>Insufficient balance.</b> You don't hold that much {inDenom}.</div>
          )}

          {needsApproval ? (
            <>
              <div className="steps">
                <div className="step"><span className="n">1</span>Approve AGORA for the curve</div>
                <div className="step"><span className="n">2</span>Sell</div>
              </div>
              <button className="btn" onClick={doApprove} disabled={!!busy || !wallet.onCorrectChain}>
                {busy === "approving" ? "approving…" : "Approve AGORA"}
              </button>
            </>
          ) : !wallet.account ? (
            <button className="btn" onClick={wallet.connect}>Connect wallet</button>
          ) : !wallet.onCorrectChain ? (
            <button className="btn danger" onClick={wallet.switchChain}>Switch to Robinhood Chain</button>
          ) : (
            <button
              className="btn"
              onClick={act}
              disabled={!!busy || !quote || !parsed || parsed <= 0n || insufficient}
            >
              {busy ?? (side === "buy" ? "Buy AGORA" : "Sell AGORA")}
            </button>
          )}

          {quote && (
            <div className="quote">
              <div className="qrow emph">
                <span className="qk">Estimated received</span>
                <span className="qv">
                  {side === "buy" ? fmtGrouped(quote.amountOut, 0) : fmtSig(quote.amountOut, 6)} {outDenom}
                </span>
              </div>
              <div className="qrow">
                <span className="qk">Minimum received ({bpsToPct(slippageBps)})</span>
                <span className="qv">
                  {minOut !== null && (side === "buy" ? fmtGrouped(minOut, 0) : fmtSig(minOut, 6))} {outDenom}
                </span>
              </div>
              <div className="qrow tax">
                <span className="qk">Creator tax {curve ? bpsToPct(curve.creatorTaxBps) : ""} + curve fee {curve ? bpsToPct(curve.feeBps) : ""}</span>
                <span className="qv">−{curve ? bpsToPct(curve.totalFeeBps) : DASH}</span>
              </div>
              <div className="qrow">
                <span className="qk">Quote source</span>
                <span className="qv">{quoting ? "…" : quote.exact ? "simulated (exact)" : "reserve math (estimate)"}</span>
              </div>
            </div>
          )}

          {err && <div className="txnote err">{err}</div>}
          {txHash && (
            <div className="txnote ok">
              confirmed ·{" "}
              <a className="link" href={`${explorerAddr(AGORA.token).replace("/address/", "/tx/")}`.replace(AGORA.token, txHash)} target="_blank" rel="noreferrer">
                {txHash.slice(0, 18)}…
              </a>
            </div>
          )}
        </Panel>

        <div>
          {graduated ? (
            /* Post-graduation the curve's reserves are drained by design, so a
               "0 / 4.2 ETH, 0.000%" progress bar is technically accurate and
               completely meaningless. Once the token has graduated, the pool is
               the thing worth reading. */
            <Panel label="Pool state" id="uniswap v4 · StateView">
              <div className="rows">
                <Row k="Spot price">
                  {pool?.priceWad ? `${fmtSig(pool.priceWad, 6)} ETH` : DASH}
                </Row>
                <Row k="Active liquidity" na={pool?.liquidity == null}>
                  {pool?.liquidity != null ? fmtGrouped(pool.liquidity, 4) : DASH}
                </Row>
                <Row k="Tick">{pool?.tick != null ? String(pool.tick) : DASH}</Row>
                <Row k="Creator tax">{curve ? bpsToPct(curve.creatorTaxBps) : "4%"}</Row>
                <Row k="Pool fee">0 — the hook prices every swap dynamically</Row>
                <Row k="poolId">
                  <span className="n">{pool ? `${pool.id.slice(0, 18)}…` : DASH}</span>
                </Row>
                <Row k="Hook">
                  <a className="link" href={explorerAddr(PONS.memeHook)} target="_blank" rel="noreferrer">
                    V2MemeHook
                  </a>
                </Row>
                <Row k="Curve">
                  <span className="muted">closed — graduated at 4.2 ETH</span>
                </Row>
              </div>
              <p className="sub">
                The 4% creator tax did not move with graduation. It lives in the hook, applied in{" "}
                <code>beforeSwap</code>, so it still reaches the FeeSink on every trade through this
                pool.
              </p>
            </Panel>
          ) : (
            <Panel label="Curve state" id="live">
              <div className="rows">
                <Row k="Graduation progress">
                  {curve ? `${fmtSig(curve.realQuoteReserve, 6)} / ${fmtSig(curve.graduationThreshold, 4)} ETH` : DASH}
                </Row>
                <Row k="Percent to graduation">{curve ? `${curve.graduationPct.toFixed(3)}%` : DASH}</Row>
                <Row k="Spot price">{curve ? `${fmtSig(curve.priceWad, 6)} ETH` : DASH}</Row>
                <Row k="Token reserve">{curve ? fmtGrouped(curve.tokenReserve, 0) : DASH}</Row>
                <Row k="Quote reserve (incl. phantom)">{curve ? `${fmtSig(curve.quoteReserve, 6)} ETH` : DASH}</Row>
                <Row k="Phantom quote">{curve ? `${fmtSig(curve.phantomQuote, 4)} ETH` : DASH}</Row>
                <Row k="Creator tax">{curve ? bpsToPct(curve.creatorTaxBps) : DASH}</Row>
                <Row k="Curve fee">{curve ? bpsToPct(curve.feeBps) : DASH}</Row>
                <Row k="Tax accrued on curve">
                  {curve ? `${fmtSig(curve.creatorTaxBalance, 8)} ETH` : DASH}
                </Row>
                <Row k="Snipe tax (first 3s)">
                  {curve ? `${bpsToPct(curve.snipeTaxStartBps)} — window closed` : DASH}
                </Row>
              </div>
            </Panel>
          )}

          <div style={{ height: 14 }} />

          <Panel label={graduated ? "Swap route" : "After graduation"} id={graduated ? "uniswap v4 · live" : "uniswap v4 · validated, dormant"}>
            <div className="rows">
              <Row k="Route">UniversalRouter → V4_SWAP</Row>
              <Row k="Quotes">V4Quoter (staticCall only)</Row>
              <Row k="Buys">native ETH — no approval, no Permit2</Row>
              <Row k="Sells">Permit2 allowance required</Row>
              <Row k="Hook">
                <a className="rv" href={explorerAddr(PONS.memeHook)} target="_blank" rel="noreferrer">
                  V2MemeHook
                </a>
              </Row>
            </div>
            <p className="sub">
              Action encoding was dry-run against the live router via <code>eth_call</code> and accepted;
              two plausible opcode variants reverted, so the sequence is confirmed for this chain.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
