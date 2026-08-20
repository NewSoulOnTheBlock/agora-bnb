import { useEffect, useState } from "react";
import { Contract, formatEther } from "ethers";
import { readProvider, TORII, EXPLORER, explorerAddr, TORII_TAX_BPS, CHAIN_ID } from "../chain";
import { Frame } from "./Frame";

/**
 * Three windows that dress a real protocol state as a period artefact.
 *
 * Each is a joke that happens to be the clearest available presentation of the
 * thing it describes — a countdown, a queue and a spec sheet are exactly what
 * a timelock, a redemption queue and a set of parameters are.
 */

/* ==========================================================================
   System Properties — right-click the desktop
   ========================================================================== */
export function SystemProperties({ onClose }: { onClose: () => void }) {
  const [nav, setNav] = useState<bigint | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);

  useEffect(() => {
    const t = new Contract(
      TORII.treasury,
      [
        "function nav() view returns (uint256)",
        "function eligibleSupply() view returns (uint256)",
      ],
      readProvider
    );
    Promise.all([t.nav().catch(() => null), t.eligibleSupply().catch(() => null)])
      .then(([n, s]) => {
        if (n !== null) setNav(BigInt(n));
        if (s !== null) setSupply(BigInt(s));
      })
      .catch(() => {});
  }, []);

  return (
    <Frame title="System Properties" icon="computer" onClose={onClose} width={460}>
      <div className="sysprops">
        <div className="sysprops-art">
          <img src="/logo.png" width={64} height={64} alt="" />
          <div className="kana">アゴラ</div>
        </div>
        <div className="rows mini" style={{ flex: 1 }}>
          <SysRow k="System">TORII 98</SysRow>
          <SysRow k="Version">4.663 (Robinhood Chain)</SysRow>
          <SysRow k="Registered to">whoever is holding</SysRow>
          <SysRow k="Chain ID">{CHAIN_ID}</SysRow>
          <SysRow k="Processor">Pons v2 · V2MemeHook</SysRow>
          <SysRow k="Levy">{TORII_TAX_BPS / 100}% on every buy and sell</SysRow>
          <SysRow k="Reserve">
            {nav !== null ? `${formatEther(nav)} ETH` : "reading…"}
          </SysRow>
          <SysRow k="Eligible supply">
            {supply !== null ? `${Number(formatEther(supply)).toLocaleString("en-US", { maximumFractionDigits: 0 })} TORII` : "reading…"}
          </SysRow>
          <SysRow k="Token">
            <a className="link" href={explorerAddr(TORII.token)} target="_blank" rel="noreferrer">
              {TORII.token.slice(0, 12)}…
            </a>
          </SysRow>
          <SysRow k="Treasury">
            <a className="link" href={explorerAddr(TORII.treasury)} target="_blank" rel="noreferrer">
              {TORII.treasury.slice(0, 12)}…
            </a>
          </SysRow>
        </div>
      </div>
      <p className="sub" style={{ marginTop: 12 }}>
        This system is not a bank, a fund, or advice. It is a tax, a pot, and a queue — all three
        verifiable at <a className="link" href={EXPLORER} target="_blank" rel="noreferrer">{EXPLORER.replace("https://", "")}</a>.
      </p>
    </Frame>
  );
}

function SysRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="rk">{k}</span>
      <span className="rv">{children}</span>
    </div>
  );
}

/* ==========================================================================
   Windows Update — the adapter timelock, as an install progress bar
   ========================================================================== */
export function WindowsUpdate({ onClose }: { onClose: () => void }) {
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const [timelock, setTimelock] = useState<number>(172800);
  const [active, setActive] = useState<boolean | null>(null);
  const [sleeve, setSleeve] = useState<number | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const ADAPTER = "0x0B57a02cd732A4942DefD1c67F83097a24DBDbEe";

  useEffect(() => {
    const t = new Contract(
      TORII.treasury,
      [
        "function adapterQueuedAt(address) view returns (uint256)",
        "function ADAPTER_TIMELOCK() view returns (uint256)",
        "function isAdapter(address) view returns (bool)",
        "function sleeveBps() view returns (uint16)",
      ],
      readProvider
    );
    Promise.all([
      t.adapterQueuedAt(ADAPTER).catch(() => null),
      t.ADAPTER_TIMELOCK().catch(() => null),
      t.isAdapter(ADAPTER).catch(() => null),
      t.sleeveBps().catch(() => null),
    ]).then(([q, tl, on, sb]) => {
      if (q !== null) setQueuedAt(Number(q));
      if (tl !== null) setTimelock(Number(tl));
      if (on !== null) setActive(Boolean(on));
      if (sb !== null) setSleeve(Number(sb));
    });
  }, []);

  useEffect(() => {
    const i = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(i);
  }, []);

  const readyAt = queuedAt ? queuedAt + timelock : null;
  const remaining = readyAt ? Math.max(0, readyAt - now) : null;
  const pct =
    queuedAt && readyAt
      ? Math.min(100, Math.max(0, ((now - queuedAt) / timelock) * 100))
      : 0;

  const hh = remaining !== null ? Math.floor(remaining / 3600) : 0;
  const mm = remaining !== null ? Math.floor((remaining % 3600) / 60) : 0;
  const ss = remaining !== null ? remaining % 60 : 0;

  return (
    <Frame title="Windows Update" icon="floppy" onClose={onClose} width={520}>
      {queuedAt === null ? (
        <p style={{ margin: 0 }}>No update is queued.</p>
      ) : active ? (
        <>
          <p style={{ margin: 0 }}>
            <b>Update installed.</b> BeefyCLMAdapter is active on the Treasury.
          </p>
          <p className="sub">
            {sleeve === 0
              ? "One step remains: sleeveBps is still 0, so no deposit is possible until it is set."
              : `The sleeve is set to ${(sleeve ?? 0) / 100}% of NAV.`}
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            <b>Installing update 1 of 1:</b> BeefyCLMAdapter
          </p>

          <div className="progress" style={{ marginTop: 12 }}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>

          <div className="progress-note">
            {remaining === 0 ? (
              <b className="ok">Ready to install — call activateAdapter()</b>
            ) : (
              <>
                {String(hh).padStart(2, "0")}h {String(mm).padStart(2, "0")}m{" "}
                {String(ss).padStart(2, "0")}s remaining · {pct.toFixed(1)}%
              </>
            )}
          </div>

          <p className="sub">
            <b>Do not turn off your computer.</b> Adding an adapter is the one action the Treasury
            delays, because an adapter can hold the corpus. The two days exist so holders can read
            the contract — and leave at the current floor — before any ETH goes into it.
          </p>

          <div className="rows mini">
            <div className="row">
              <span className="rk">Adapter</span>
              <span className="rv">
                <a className="link" href={explorerAddr(ADAPTER)} target="_blank" rel="noreferrer">
                  {ADAPTER.slice(0, 14)}…
                </a>
              </span>
            </div>
            <div className="row">
              <span className="rk">Vault</span>
              <span className="rv">weth-usdg · Beefy cowcentrated</span>
            </div>
          </div>
        </>
      )}
    </Frame>
  );
}

/* ==========================================================================
   Print queue — the redemption queue
   ========================================================================== */
type Job = { id: number; owner: string; amount: bigint; paid: bigint; ready: boolean; at: number };

export function PrintQueue({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [nagged, setNagged] = useState<number | null>(null);

  useEffect(() => {
    const r = new Contract(
      TORII.redeemer,
      [
        "function queueLength() view returns (uint256)",
        "function requests(uint256) view returns (tuple(address owner,uint128 amount,uint128 snapshotFloor,uint64 requestedAt,bool executed))",
        "function preview(uint256) view returns (uint256 paid, uint256 executableAt, bool ready)",
      ],
      readProvider
    );

    (async () => {
      try {
        const n = Number(await r.queueLength());
        const out: Job[] = [];
        for (let i = Math.max(0, n - 12); i < n; i++) {
          const [req, pv] = await Promise.all([r.requests(i), r.preview(i)]);
          if (req.executed) continue;
          out.push({
            id: i,
            owner: String(req.owner),
            amount: BigInt(req.amount),
            paid: BigInt(pv[0]),
            ready: Boolean(pv[2]),
            at: Number(pv[1]),
          });
        }
        setJobs(out);
      } catch {
        setJobs([]);
      }
    })();
  }, []);

  return (
    <Frame title="Redemption Queue" icon="recycle" onClose={onClose} width={560}>
      <div className="queue-head">
        {jobs === null
          ? "Reading the queue…"
          : jobs.length === 0
            ? "0 documents waiting"
            : `${jobs.length} document${jobs.length === 1 ? "" : "s"} waiting`}
      </div>

      <div className="rows" style={{ marginTop: 8 }}>
        {jobs?.map((j) => {
          const left = Math.max(0, j.at - Math.floor(Date.now() / 1000));
          return (
            <div className="row" key={j.id}>
              <span className="rk">
                #{j.id} · {Number(formatEther(j.amount)).toLocaleString("en-US", { maximumFractionDigits: 0 })} TORII
                <br />
                <span className="muted">{j.owner.slice(0, 10)}…</span>
              </span>
              <span className="rv">
                {formatEther(j.paid)} ETH
                <br />
                {j.ready ? (
                  <b className="ok">ready to collect</b>
                ) : (
                  <span className="muted">
                    {Math.floor(left / 3600)}h {Math.floor((left % 3600) / 60)}m to go
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {jobs !== null && jobs.length > 0 && (
        <div className="dialog-btns" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="btn" onClick={() => setNagged(jobs[0].id)}>
            Cancel document
          </button>
        </div>
      )}

      {nagged !== null && (
        <div className="notice" style={{ marginTop: 12 }}>
          <b>Cannot cancel job #{nagged}.</b> The TORII was destroyed the moment the request was
          made, not when it is collected. Re-minting is impossible — the supply is fixed by the Pons
          factory and there is no mint function. Burning at request time is what makes every
          redemption raise the floor for the holders who stayed, immediately.
        </div>
      )}

      <p className="sub">
        Requests mature after the redeem delay, then anyone may execute them — the payout goes to
        the owner, not the caller, so a stranger cranking the queue costs them nothing.
      </p>
    </Frame>
  );
}
