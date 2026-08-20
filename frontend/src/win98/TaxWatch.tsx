import { useEffect, useRef, useState } from "react";
import { formatEther, id as topicId, AbiCoder } from "ethers";
import { logProvider, ZERO, TORII } from "../chain";
import { play } from "./sound";

/**
 * Watches the tax vault and announces every arrival.
 *
 * The ticker already claims "the tax never sleeps". This is that claim wired to
 * the chain: `ToriiVault` emits `RevenueRecognized` whenever Flap pushes tax
 * into it, and when one lands while somebody is looking, the balloon slides up
 * from the tray and the ding plays — the Win98 notification, carrying a real
 * number.
 *
 * ## Simpler here than on Pons, for a structural reason
 *
 * The Pons version had to filter by currency, because the hook emitted for both
 * legs of every swap and adding them together is how the tax figure once read
 * as 8.8 million "BNB". Flap's vault has one quote asset — native BNB — so
 * `RevenueRecognized` is unambiguous and there is nothing to filter.
 *
 * It still does not announce history. The first poll only records where the
 * chain is; nothing fires until an event arrives *after* the page loaded.
 *
 * ## It polls the log endpoint, and only just keeps up
 *
 * BSC blocks are 0.45 seconds, so a 20-second interval is ~44 blocks — well
 * inside what a non-archive node will serve. Widen the interval and the window
 * starts to matter; see the archive note in `history.ts`.
 */

const TOPIC = topicId("RevenueRecognized(uint256,uint256)");
const POLL_MS = 20_000;

type Balloon = { id: number; tax: bigint; fee: bigint };

export default function TaxWatch({ enabled = true }: { enabled?: boolean }) {
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const lastBlock = useRef<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || TORII.feeSink === ZERO) return;
    let alive = true;
    const abi = AbiCoder.defaultAbiCoder();

    const poll = async () => {
      try {
        const head = await logProvider.getBlockNumber();

        // First pass records the mark and announces nothing.
        if (lastBlock.current === null) {
          lastBlock.current = head;
          return;
        }
        const from = lastBlock.current + 1;
        if (from > head) return;

        const logs = await logProvider.getLogs({
          address: TORII.feeSink,
          topics: [TOPIC],
          fromBlock: from,
          toBlock: head,
        });
        lastBlock.current = head;
        if (!alive || !logs.length) return;

        for (const l of logs) {
          try {
            // RevenueRecognized(amount, baseline). `baseline` is the balance
            // the delta was measured against, shown as context rather than as a
            // second number anyone should add.
            const [amount, baseline] = abi.decode(["uint256", "uint256"], l.data);
            const tax = BigInt(amount);
            if (tax === 0n) continue;

            const id = ++seq.current;
            setBalloons((b) => [...b, { id, tax, fee: BigInt(baseline) }].slice(-3));
            play("ding");
            setTimeout(() => {
              if (alive) setBalloons((b) => b.filter((x) => x.id !== id));
            }, 7000);
          } catch {
            // Undecodable log: skip it rather than dropping the batch.
          }
        }
      } catch {
        // A failed poll is not worth surfacing; the next one is 20s away.
      }
    };

    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [enabled]);

  if (!balloons.length) return null;

  return (
    <div className="balloons" role="status" aria-live="polite">
      {balloons.map((b) => (
        <div className="balloon" key={b.id}>
          <div className="balloon-title">
            <span className="balloon-dot" />
            Tax collected
          </div>
          <div className="balloon-body">
            <b>{formatEther(b.tax)} BNB</b> into the reserve.
            <br />
            Every token is now backed by a little more than it was.
          </div>
        </div>
      ))}
    </div>
  );
}
