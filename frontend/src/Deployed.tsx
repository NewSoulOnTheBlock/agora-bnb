import { Panel, Stat, Row, Dot, Pill } from "./components";
import { useSnapshot, useBeefy, useOperatorHoldings } from "./useReads";
import { fmtSig, fmtGrouped, fmtUnits, DASH } from "./format";
import { AGORA, explorerAddr } from "./chain";

/**
 * Deployed capital.
 *
 * This page exists because of a specific, fair complaint about the dashboard:
 * it reported `cumulativeWithdrawn` as a bare number with no counterpart, so a
 * treasury with most of its capital at work looked like one that had been
 * emptied. At the time of writing NAV reads 0.02 ETH against 1.37 ETH
 * withdrawn — a reading that is alarming and, on its own, misleading.
 *
 * Until `BeefyCLMAdapter` is queued and activated, moving ETH out to the
 * operator **is** the deployment mechanism. It is not a leak, and the position
 * is fully readable on-chain, so it belongs on the page as an asset rather than
 * as an absence.
 *
 * The disclosure does not go away — deployed ETH genuinely sits outside `nav()`
 * and therefore outside the floor, and that is stated plainly at the bottom.
 * What changes is that the reader can now see where it went and what it is
 * worth.
 */
export default function Deployed() {
  const { data: s } = useSnapshot();
  const operator = s?.reserve.operator ?? AGORA.deployer;
  const beefy = useBeefy(operator);
  const held = useOperatorHoldings(operator, AGORA.token, AGORA.stakedAgora, s?.pool.priceWad ?? null);

  /** Everything the operator can be seen to hold, deployed or not. */
  const accountedFor =
    (beefy.total ?? 0n) + (held?.eth ?? 0n) + (held?.agoraWei ?? 0n) + (held?.stAgoraWei ?? 0n);

  const withdrawn = s?.reserve.cumulativeWithdrawn ?? null;
  const worth = beefy.total;

  /** Everything visible, against what left the Treasury. */
  const accountedPct =
    withdrawn != null && withdrawn > 0n && (beefy.total != null || held != null)
      ? (Number(accountedFor) / Number(withdrawn)) * 100
      : null;

  return (
    <>
      <div className="section">
        <p className="label">
          Deployed capital <span className="id">held by the operator, read from Beefy</span>
        </p>

        <div className="grid c3">
          <Stat
            k="Withdrawn, all time"
            value={withdrawn != null ? fmtSig(withdrawn) : null}
            unit="ETH"
            note="cumulative total, not a current balance"
          />
          <Stat
            k="Worth now"
            value={worth != null ? fmtSig(worth) : beefy.loading ? null : "0"}
            unit="ETH"
            note="mark-to-market across every open position"
          />
          <Stat
            k="Still in the Treasury"
            value={s?.reserve.navWad != null ? fmtSig(s.reserve.navWad) : null}
            unit="ETH"
            note="NAV — the only part the floor counts"
          />
        </div>

        <div style={{ height: 14 }} />

        {/* Beefy is only one of the places withdrawn ETH can sit. Reconciling
            against it alone leaves a hole that looks like a loss and usually is
            not — most of it is plainly visible in the wallet. */}
        <div className="grid c4">
          <Stat
            k="In Beefy vaults"
            value={beefy.total != null ? fmtSig(beefy.total) : beefy.loading ? null : "0"}
            unit="ETH"
            note="open cowcentrated positions"
          />
          <Stat
            k="Operator ETH"
            value={held?.eth != null ? fmtSig(held.eth) : null}
            unit="ETH"
            note="idle in the wallet, not yet deployed"
          />
          <Stat
            k="Operator AGORA"
            value={held?.agora != null ? fmtGrouped(held.agora, 0) : null}
            unit="AGORA"
            note={
              held?.agoraWei != null
                ? `≈ ${fmtSig(held.agoraWei)} ETH at the pool price`
                : "bought back, or never sold"
            }
          />
          <Stat
            k="Operator stAGORA"
            value={held?.stAgora != null ? fmtGrouped(held.stAgora, 0) : null}
            unit="stAGORA"
            note={
              held?.stAgoraWei != null
                ? `staked in the protocol's own vault · ≈ ${fmtSig(held.stAgoraWei)} ETH`
                : "staked in the protocol's own vault"
            }
          />
        </div>

        {accountedPct != null && (
          <p className="sub">
            Visible holdings account for <b>{accountedPct.toFixed(1)}%</b> of everything ever
            withdrawn. The remainder is not necessarily missing — it may have been returned to the
            Treasury with <code>fund()</code>, spent on gas, or moved into a venue this page does
            not scan. What this page can prove is only what it can read, and it reads three places:
            Beefy, the wallet's ETH, and the wallet's AGORA.
          </p>
        )}
      </div>

      <div className="section">
        <p className="label">
          Open positions{" "}
          <span className="id">
            {beefy.data ? `${beefy.data.length} of 33 vaults` : "scanning…"}
          </span>
        </p>

        {beefy.loading && !beefy.data && (
          <Panel tight>
            <span className="muted">Sweeping the Beefy registry…</span>
          </Panel>
        )}

        {beefy.data && beefy.data.length === 0 && (
          <Panel tight>
            <span className="muted">
              No open Beefy positions. Every wei withdrawn has either come back to the Treasury or
              is sitting in the operator wallet.
            </span>
          </Panel>
        )}

        {beefy.data?.map((p) => (
          <Panel
            key={p.id}
            label={p.label}
            id={p.sharePct != null ? `${p.sharePct.toFixed(2)}% of the vault` : undefined}
            right={
              <Pill warn={p.isCalm === false}>
                <Dot kind={p.isCalm === false ? "warn" : "live"} />
                {p.isCalm === false ? "not calm" : "calm"}
              </Pill>
            }
          >
            <div className="rows">
              <Row k="Value now" na={p.valueWei === null}>
                {p.valueWei != null ? `${fmtSig(p.valueWei)} ETH` : "could not be priced"}
              </Row>
              <Row k="Composition">
                {p.amount0 != null && p.decimals0 != null
                  ? `${fmtUnits(p.amount0, p.decimals0)} ${p.symbol0 ?? ""} + ${fmtUnits(
                      p.amount1 ?? 0n,
                      p.decimals1 ?? 18
                    )} ${p.symbol1 ?? ""}`
                  : DASH}
              </Row>
              <Row k="Whole vault holds">
                {p.vaultValueWei != null ? `${fmtSig(p.vaultValueWei)} ETH` : DASH}
              </Row>
              <Row k="Vault contract">
                <a className="link" href={explorerAddr(p.clm)} target="_blank" rel="noreferrer">
                  {p.clm.slice(0, 10)}…
                </a>
              </Row>
              <Row k="On Beefy">
                <a className="link" href={p.url} target="_blank" rel="noreferrer">
                  {p.id}
                </a>
              </Row>
            </div>

            {p.sharePct != null && p.sharePct > 20 && (
              <p className="sub">
                <b className="tax">This is {p.sharePct.toFixed(0)}% of the whole vault.</b> The
                on-chain adapter caps a position at 20% for a reason: at this concentration the
                deposit is most of the pool, so it suppresses its own yield and cannot be exited
                without moving the price against itself.
              </p>
            )}
          </Panel>
        ))}
      </div>

      <div className="section">
        <p className="label">Why this sits outside the floor</p>
        <Panel>
          <p className="sub" style={{ marginTop: 0 }}>
            Deployed ETH is held by the operator wallet, not by the Treasury, so{" "}
            <code>nav()</code> cannot see it and the floor is computed only from what remains
            on-contract. That is the honest accounting — a contract should not count an asset it
            does not custody.
          </p>
          <p className="sub">
            It is also the reason <code>BeefyCLMAdapter</code> was written. With the adapter queued
            and activated, the same capital goes to the same vaults while staying inside{" "}
            <code>nav()</code>, so deploying it stops costing the floor anything. Until then this
            page is the counterpart to the withdrawal figure.
          </p>
          <div className="rows mini">
            <Row k="Operator wallet">
              <a className="link" href={explorerAddr(operator)} target="_blank" rel="noreferrer">
                {operator}
              </a>
            </Row>
            <Row k="Adapter status">not deployed · sleeveBps 0 · adapters() empty</Row>
          </div>
        </Panel>
      </div>
    </>
  );
}
