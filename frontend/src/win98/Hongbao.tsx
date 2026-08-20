import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import { readProvider, TORII, ZERO, EXPLORER, TORII_TAX_BPS } from "../chain";
import { multiRead, asBig } from "../multicall";
import { usdOf } from "../price";
import { useEthUsd } from "../useReads";
import { fmtSig } from "../format";
import { Frame } from "./Frame";
import { play } from "./sound";

/**
 * 紅包 — the red envelope.
 *
 * ## What it is not
 *
 * Not an airdrop, not a giveaway, and it hands out nothing. A red envelope that
 * turned out to be empty would be the single most annoying thing this page
 * could do, so the joke is inverted: the envelope is already open and it is
 * addressed to every holder at once. What is inside is the pot — the number
 * the whole protocol exists to grow — read live.
 *
 * ## Why it earns its place
 *
 * 紅包 is the most legible object in Chinese digital culture; a red rectangle
 * with a gold seal needs no caption anywhere in the world it is used. And the
 * mechanic underneath is genuinely the same one: many people put money in, and
 * it is shared out. Stating that with the envelope rather than with another
 * table is the cheapest way this desktop can explain itself.
 *
 * The lucky number is `blockhash mod 88` — 88 because 八 sounds like 發, to
 * prosper. It is decoration and says so.
 */
export function Hongbao({ onClose }: { onClose: () => void }) {
  const [opened, setOpened] = useState(false);
  const [nav, setNav] = useState<bigint | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);
  const [lucky, setLucky] = useState<{ n: number; block: number } | null>(null);
  const ethUsd = useEthUsd();

  useEffect(() => {
    let alive = true;

    (async () => {
      if (TORII.treasury !== ZERO) {
        const f = (sig: string) => ({
          target: TORII.treasury,
          fragment: `function ${sig} view returns (uint256)`,
        });
        const r = await multiRead([f("nav()"), f("eligibleSupply()")]).catch(() => []);
        if (!alive) return;
        setNav(asBig(r[0] ?? null));
        setSupply(asBig(r[1] ?? null));
      }

      const head = await readProvider.getBlockNumber().catch(() => null);
      if (head === null || !alive) return;
      const b = await readProvider.getBlock(Math.max(0, head - 1)).catch(() => null);
      if (!b?.hash || !alive) return;
      setLucky({ n: Number(BigInt(b.hash) % 88n) + 1, block: b.number });
    })();

    return () => { alive = false; };
  }, []);

  /** What one whole TORII is backed by right now. */
  const perToken =
    nav !== null && supply !== null && supply > 0n ? (nav * 10n ** 18n) / supply : null;

  return (
    <Frame title="紅包 — Red Envelope" icon="hongbao" onClose={onClose} width={400}>
      <div className="hongbao">
        <button
          className={`envelope${opened ? " open" : ""}`}
          onClick={() => { if (!opened) { setOpened(true); play("ding"); } }}
          aria-label={opened ? "紅包 opened" : "Open the red envelope"}
        >
          <span className="seal">福</span>
          {!opened && <span className="tap">點擊開啟 · tap to open</span>}
        </button>

        {opened && (
          <>
            <div className="rows mini" style={{ marginTop: 12 }}>
              <div className="row">
                <span className="rk">裡面有 · What is inside</span>
                <span className="rv">
                  {nav !== null ? `${formatEther(nav)} BNB` : "—"}
                  {usdOf(nav, ethUsd) && <span className="muted"> · {usdOf(nav, ethUsd)}</span>}
                </span>
              </div>
              <div className="row">
                <span className="rk">分給誰 · Shared between</span>
                <span className="rv">
                  {supply !== null
                    ? `${Number(formatEther(supply)).toLocaleString("en-US", { maximumFractionDigits: 0 })} TORII`
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span className="rk">每枚 · Each token's share</span>
                <span className="rv">{perToken !== null ? `${fmtSig(perToken, 6)} BNB` : "—"}</span>
              </div>
              {lucky && (
                <div className="row">
                  <span className="rk">幸運數字 · Lucky number</span>
                  <span className="rv">
                    {lucky.n}{" "}
                    <a
                      className="link"
                      href={`${EXPLORER}/block/${lucky.block}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      blk #{lucky.block}
                    </a>
                  </span>
                </div>
              )}
            </div>

            <p className="sub">
              This envelope gives you nothing, and that is the honest version. Nobody is handing out
              tokens here — the {TORII_TAX_BPS / 100}% on every trade fills the pot above, and
              holding TORII is what makes a share of it yours. The lucky number is decoration; it is{" "}
              <code>blockhash mod 88</code>, because 八 sounds like 發.
            </p>
          </>
        )}
      </div>
    </Frame>
  );
}
