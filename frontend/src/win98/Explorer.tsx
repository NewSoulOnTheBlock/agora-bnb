import { useEffect, useState } from "react";
import { Contract, formatEther } from "ethers";
import { readProvider, TORII, explorerAddr, TORII_TAX_BPS, EXPLORER } from "../chain";
import { readBeefyPositions, totalDeployedWei } from "../beefy";
import { multiRead, asBig } from "../multicall";
import { PixelIcon, type IconName } from "./pixel";
import { Frame } from "./Frame";

/* ==========================================================================
   My Computer — the treasury as a set of drives
   ========================================================================== */

type Drive = {
  letter: string;
  label: string;
  icon: IconName;
  /** Wei sitting on this "drive". */
  used: bigint | null;
  /** What the slice is measured against. */
  capacity: bigint | null;
  note: string;
};

/**
 * A Win98 disk-usage pie: two flat wedges and a hard outline, no gradients.
 * Drawn as SVG arcs so it stays crisp at any size.
 */
function Pie({ used, capacity }: { used: bigint | null; capacity: bigint | null }) {
  const frac =
    used !== null && capacity !== null && capacity > 0n
      ? Math.min(1, Number((used * 10_000n) / capacity) / 10_000)
      : 0;

  const R = 26;
  const C = 30;
  const angle = frac * Math.PI * 2 - Math.PI / 2;
  const large = frac > 0.5 ? 1 : 0;
  const x = C + R * Math.cos(angle);
  const y = C + R * Math.sin(angle);

  return (
    <svg width={60} height={60} viewBox="0 0 60 60" aria-hidden="true">
      <circle cx={C} cy={C} r={R} fill="#3a1f55" stroke="#0a0a0a" strokeWidth="1.5" />
      {frac > 0.001 && (
        <path
          d={`M ${C} ${C} L ${C} ${C - R} A ${R} ${R} 0 ${large} 1 ${x} ${y} Z`}
          fill="#c8102e"
          stroke="#0a0a0a"
          strokeWidth="1.2"
        />
      )}
      <circle cx={C} cy={C} r={R} fill="none" stroke="#0a0a0a" strokeWidth="1.5" />
    </svg>
  );
}

export function MyComputer({ onClose }: { onClose: () => void }) {
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [withdrawn, setWithdrawn] = useState<bigint | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      const T = TORII.treasury;
      const f = (sig: string) => ({ target: T, fragment: `function ${sig} view returns (uint256)` });

      const [reads, positions, collectable] = await Promise.all([
        multiRead([f("nav()"), f("liquidEth()"), f("pendingIncome()"), f("cumulativeWithdrawn()")]),
        readBeefyPositions(TORII.deployer).catch(() => []),
        new Contract(
          TORII.feeSink,
          ["function collectable() view returns (uint256,uint256,uint256)"],
          readProvider
        )
          .collectable()
          .catch(() => null),
      ]);
      if (!alive) return;

      const nav = asBig(reads[0]);
      const liquid = asBig(reads[1]);
      const income = asBig(reads[2]);
      setWithdrawn(asBig(reads[3]));

      const deployed = totalDeployedWei(positions);
      const escrow = collectable
        ? BigInt(collectable[0]) + BigInt(collectable[1]) + BigInt(collectable[2])
        : null;

      /**
       * Capacity is **Treasury + deployed**, not "everything ever withdrawn".
       * Measured the other way the drive reads 99% full, which is arithmetically
       * true and tells the wrong story: the withdrawals were allocations, not
       * consumption. Cumulative withdrawal is still shown, as its own line.
       */
      const total = (nav ?? 0n) + (deployed ?? 0n);

      setDrives([
        {
          letter: "C:",
          label: "Treasury",
          icon: "harddrive",
          used: nav,
          capacity: total,
          note: `${liquid !== null ? formatEther(liquid) : "?"} BNB liquid · ${
            income !== null ? formatEther(income) : "?"
          } BNB owed to stakers`,
        },
        {
          letter: "D:",
          label: "Beefy (deployed)",
          icon: "globe",
          used: deployed,
          capacity: total,
          note: "held by the operator, outside nav()",
        },
        {
          letter: "A:",
          label: "FeeSink",
          icon: "floppy",
          used: escrow,
          capacity: escrow && escrow > 0n ? escrow : 1n,
          note: escrow && escrow > 0n ? "tax waiting to be collected" : "empty — nothing to sweep",
        },
      ]);
    })();

    return () => { alive = false; };
  }, []);

  const total = drives ? (drives[0].capacity ?? 0n) : 0n;

  return (
    <Frame title="My Computer" icon="computer" onClose={onClose} width={520}>
      {!drives ? (
        <p className="muted" style={{ margin: 0 }}>Reading drives…</p>
      ) : (
        <>
          <div className="drives">
            {drives.map((d) => (
              <div className="drive" key={d.letter}>
                <Pie used={d.used} capacity={d.capacity} />
                <div className="drive-body">
                  <div className="drive-name">
                    <PixelIcon name={d.icon} size={16} />
                    <b>{d.letter}</b> {d.label}
                  </div>
                  <div className="drive-size">
                    {d.used !== null ? `${formatEther(d.used)} BNB` : "unavailable"}
                  </div>
                  <div className="drive-note">{d.note}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="rows mini" style={{ marginTop: 12 }}>
            <div className="row">
              <span className="rk">Total capacity</span>
              <span className="rv">{formatEther(total)} BNB</span>
            </div>
            <div className="row">
              <span className="rk">Withdrawn, all time</span>
              <span className="rv">
                {withdrawn !== null ? `${formatEther(withdrawn)} BNB` : "—"}
              </span>
            </div>
          </div>

          <p className="sub">
            Capacity here is the Treasury plus what is deployed, not everything ever withdrawn.
            Measured the other way the drive reads almost full, which is true arithmetic and the
            wrong story — those withdrawals were allocations, not consumption. The cumulative
            figure is above, unshortened.
          </p>
        </>
      )}
    </Frame>
  );
}

/* ==========================================================================
   Network Neighborhood — the contract set, as machines
   ========================================================================== */

type Node = { name: string; addr: string; role: string };

const NODES: Node[] = [
  { name: "TORII", addr: TORII.token, role: "the token · fixed supply, burn-only" },
  { name: "TREASURY", addr: TORII.treasury, role: "the corpus · NAV and the floor" },
  { name: "FEESINK", addr: TORII.feeSink, role: "collects the 5% pushed by Flap" },
  { name: "REDEEMER", addr: TORII.redeemer, role: "burn TORII, join the queue" },
  { name: "STTORII", addr: TORII.stakedAgora, role: "ERC-4626 vault · BNB rewards" },
  { name: "DISTRIBUTOR", addr: TORII.distributor, role: "splits income 90 / 10" },
  { name: "ADAPTER", addr: "0x0B57a02cd732A4942DefD1c67F83097a24DBDbEe", role: "Beefy sleeve · queued, not active" },
  { name: "CURVE", addr: TORII.curve, role: "the bonding curve · closed" },
];

export function NetworkNeighborhood({ onClose }: { onClose: () => void }) {
  const [online, setOnline] = useState<Record<string, boolean | null>>({});

  useEffect(() => {
    let alive = true;
    // "Online" means the address actually holds code. It is the cheapest honest
    // liveness check available without calling into each contract.
    Promise.all(
      NODES.map((n) =>
        readProvider
          .getCode(n.addr)
          .then((c) => [n.name, c !== "0x" && c.length > 2] as const)
          .catch(() => [n.name, null] as const)
      )
    ).then((rows) => {
      if (!alive) return;
      setOnline(Object.fromEntries(rows));
    });
    return () => { alive = false; };
  }, []);

  return (
    <Frame title="Network Neighborhood" icon="network" onClose={onClose} width={560}>
      <div className="netlist">
        {NODES.map((n) => {
          const state = online[n.name];
          return (
            <a
              className="netnode"
              key={n.name}
              href={explorerAddr(n.addr)}
              target="_blank"
              rel="noreferrer"
              title={n.addr}
            >
              <PixelIcon name="computer" size={24} />
              <div className="netnode-body">
                <div className="netnode-name">
                  <span className={`dot ${state === null ? "warn" : state ? "live" : "off"}`} />
                  \\\\{n.name}
                </div>
                <div className="netnode-role">{n.role}</div>
                <div className="netnode-addr">{n.addr}</div>
              </div>
            </a>
          );
        })}
      </div>
      <p className="sub">
        Every machine on this network is a contract on chain 56. A green light means the address
        holds code — nothing more. Click through to{" "}
        <a className="link" href={EXPLORER} target="_blank" rel="noreferrer">the explorer</a> to read
        any of them.
      </p>
    </Frame>
  );
}

/* ==========================================================================
   Notepad — readme.txt
   ========================================================================== */

const README = `TORII — readme.txt
==================================================

WHAT THIS IS

  Every buy and every sell of TORII pays a ${TORII_TAX_BPS / 100}% fee.
  The fee is set at launch on Flap and paid in BNB, so the
  token itself carries no tax code at all — it is a plain
  ERC-20 with no hooks, no owner, no blacklist, no mint.

  The fee lands in a Treasury. Part of it is paid to people
  who stake; the rest stays in the pot and makes every token
  worth a little more than it was.

  Any holder may burn TORII and take a pro-rata share of the
  pot, minus a 5% haircut. The haircut stays behind, so every
  redemption makes the remaining position stronger. A run
  makes the survivors richer. That is the whole design.


WHAT IT IS NOT

  It is not a guaranteed floor. The operator can withdraw
  corpus BNB to deploy it into yield, so the reported figure
  describes what backs each token right now, not a level the
  contract can hold. Every withdrawal is logged on-chain.

  It is not a bank, a fund, or advice.


THINGS THAT ARE TRUE AND EASY TO MISS

  - Burning happens when you ASK, not when you collect.
    There is no cancel. Re-minting is impossible.

  - Staking rewards are BNB and stay outside the vault's
    totalAssets(), so the share price never moves.

  - Deployed capital sits outside nav(). A contract should
    not count an asset it does not custody.


  chain 56 · bnb smart chain
  ${EXPLORER}

==================================================
`;

export function Notepad({ onClose }: { onClose: () => void }) {
  return (
    <Frame title="readme.txt — Notepad" icon="help" onClose={onClose} width={560}>
      <div className="notepad">
        <div className="notepad-menu">
          <span><u>F</u>ile</span>
          <span><u>E</u>dit</span>
          <span><u>S</u>earch</span>
          <span><u>H</u>elp</span>
        </div>
        <textarea className="notepad-body" readOnly value={README} spellCheck={false} />
      </div>
    </Frame>
  );
}
