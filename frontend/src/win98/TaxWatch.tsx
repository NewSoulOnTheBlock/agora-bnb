import { useEffect, useRef, useState } from "react";
import { formatEther, id as topicId, AbiCoder } from "ethers";
import { readProvider, PONS, ZERO, AGORA } from "../chain";
import { ponsPoolKey, poolId } from "../poolkey";
import { play } from "./sound";

/**
 * Watches the hook for new tax and announces it.
 *
 * The ticker already claims "the tax never sleeps". This is that claim wired to
 * the chain: `HookFeeCollected` fires on every taxed swap, and when a new one
 * lands while somebody is looking, the balloon slides up from the tray and the
 * ding plays — the Win98 notification, carrying a real number.
 *
 * ## Two things it deliberately does not do
 *
 * It does not announce history. The first poll only records where the chain is;
 * nothing fires until an event arrives *after* the page loaded. Opening the
 * page to nine balloons about swaps that happened this morning would be noise.
 *
 * It does not sum across currencies. The hook emits for **both** legs of every
 * swap — native ETH and the token — and adding those together is how the tax
 * figure once read as 8.8 million "ETH". Only the native-ETH leg is counted.
 */

const TOPIC = topicId("HookFeeCollected(bytes32,address,uint256,uint256)");
const POLL_MS = 20_000;

type Balloon = { id: number; tax: bigint; fee: bigint };

export default function TaxWatch({ enabled = true }: { enabled?: boolean }) {
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const lastBlock = useRef<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || AGORA.token === ZERO) return;
    let alive = true;
    const pid = poolId(ponsPoolKey(AGORA.token));
    const abi = AbiCoder.defaultAbiCoder();

    const poll = async () => {
      try {
        const head = await readProvider.getBlockNumber();

        // First pass records the mark and announces nothing.
        if (lastBlock.current === null) {
          lastBlock.current = head;
          return;
        }
        const from = lastBlock.current + 1;
        if (from > head) return;

        const logs = await readProvider.getLogs({
          address: PONS.memeHook,
          topics: [TOPIC, pid],
          fromBlock: from,
          toBlock: head,
        });
        lastBlock.current = head;
        if (!alive || !logs.length) return;

        for (const l of logs) {
          try {
            const [currency, feeAmount, taxAmount] = abi.decode(
              ["address", "uint256", "uint256"],
              l.data
            );
            // Native ETH only — see the note above.
            if (String(currency).toLowerCase() !== ZERO.toLowerCase()) continue;
            const tax = BigInt(taxAmount);
            if (tax === 0n) continue;

            const id = ++seq.current;
            setBalloons((b) => [...b, { id, tax, fee: BigInt(feeAmount) }].slice(-3));
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
            <b>{formatEther(b.tax)} ETH</b> into the reserve.
            <br />
            Every token is now backed by a little more than it was.
          </div>
        </div>
      ))}
    </div>
  );
}
