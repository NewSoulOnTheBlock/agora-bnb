import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "ethers";
import { TORII, ZERO, TORII_TAX_BPS, EXPLORER } from "../chain";
import { multiRead, asBig } from "../multicall";
import { readCurveState } from "../curve";
import { fmtSig } from "../format";
import { Frame } from "./Frame";
import { PixelIcon } from "./pixel";
import { play } from "./sound";

/**
 * 企鵝 — the messenger.
 *
 * A chat window from the era when every Chinese PC had one open, with a penguin
 * on the taskbar and an auto-reply bot on the other end. Here the bot is the
 * shrine, and it answers with numbers it reads off the chain while you watch.
 *
 * ## Why a chat window and not another panel
 *
 * The Reserve page states the protocol correctly and nobody reads it first. A
 * conversation asks the questions in the order a person actually has them —
 * what is this, where does the money go, what do I get, what can go wrong —
 * and answers each one with a live figure rather than a paragraph. It is the
 * same information the tables carry, arranged the way it is actually wanted.
 *
 * ## The rule it keeps
 *
 * Every number in a reply is fetched when the reply is sent, not baked in. If
 * a read fails the shrine says so rather than inventing a figure — a chatbot
 * is exactly the surface where a made-up number would be most believed and
 * least checkable.
 *
 * ## About the penguin
 *
 * It is an original drawing. The messenger this evokes belongs to a company
 * whose penguin is a trademark, and putting someone's registered mark on a
 * financial product for a joke is not worth it. A penguin in a red scarf gets
 * the same feeling and belongs to nobody.
 */

type Msg = { id: number; from: "me" | "shrine"; text: string; pending?: boolean };

type Topic = {
  key: string;
  ask: string;
  /** Resolves the reply. Throwing yields an honest failure line. */
  answer: () => Promise<string>;
};

const bnb = (v: bigint | null) => (v === null ? null : `${fmtSig(v, 6)} BNB`);

async function treasury(fields: string[]): Promise<(bigint | null)[]> {
  if (TORII.treasury === ZERO) return fields.map(() => null);
  const r = await multiRead(
    fields.map((f) => ({
      target: TORII.treasury,
      fragment: `function ${f} view returns (uint256)`,
    }))
  );
  return r.map((x) => asBig(x));
}

const TOPICS: Topic[] = [
  {
    key: "what",
    ask: "這是什麼？ · What is this?",
    answer: async () => {
      const [nav, supply] = await treasury(["nav()", "eligibleSupply()"]);
      if (nav === null) throw new Error("treasury");
      const per = supply && supply > 0n ? (nav * 10n ** 18n) / supply : null;
      return (
        `神社 TORII。每筆買賣抽 ${TORII_TAX_BPS / 100}%，進一個共同的池子。\n` +
        `A ${TORII_TAX_BPS / 100}% tax on every buy and sell, paid into one pot.\n\n` +
        `Right now the pot holds ${formatEther(nav)} BNB` +
        (per ? `, which is ${fmtSig(per, 6)} BNB behind each token.` : ".")
      );
    },
  },
  {
    key: "where",
    ask: "錢去哪了？ · Where does the money go?",
    answer: async () => {
      const [share, collected, paid] = await treasury([
        "incomeShareBps()",
        "cumulativeTaxReceived()",
        "cumulativeIncomeDistributed()",
      ]);
      if (share === null) throw new Error("treasury");
      const pct = Number(share) / 100;
      return (
        `${pct}% 給質押的人，${100 - pct}% 留在池子裡抬高底價。\n` +
        `${pct}% to people who stake, ${100 - pct}% stays in the pot and lifts the floor.\n\n` +
        `Collected so far: ${bnb(collected) ?? "—"}\n` +
        `Paid to stakers:  ${bnb(paid) ?? "—"}`
      );
    },
  },
  {
    key: "curve",
    ask: "什麼時候畢業？ · When does it graduate?",
    answer: async () => {
      const c = await readCurveState();
      if (!c) throw new Error("curve");
      if (c.graduated) return "已經畢業了，現在在 PancakeSwap 上交易。\nAlready graduated — it trades on PancakeSwap now.";
      return (
        `還在 Flap 的曲線上：${fmtSig(c.realQuoteReserve, 6)} / ${fmtSig(c.graduationThreshold, 4)} BNB` +
        `，走了 ${c.graduationPct.toFixed(2)}%。\n` +
        `Still on the Flap curve — ${c.graduationPct.toFixed(2)}% of the way. ` +
        `At the threshold it moves to a PancakeSwap pair and the tax keeps working exactly the same.`
      );
    },
  },
  {
    key: "risk",
    ask: "有什麼風險？ · What can go wrong?",
    answer: async () => {
      const [withdrawn] = await treasury(["cumulativeWithdrawn()"]);
      return (
        `底價不是保證。The floor is not guaranteed.\n\n` +
        `The operator can withdraw pot BNB to deploy it, so what you see is what backs each token ` +
        `right now — not a level the contract can hold. Every withdrawal is logged.\n\n` +
        `Withdrawn all time: ${bnb(withdrawn) ?? "—"}\n\n` +
        `You also pay the tax twice on a round trip: ${(TORII_TAX_BPS / 100) * 2}% before the price moves at all.`
      );
    },
  },
];

export function Penguin({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: 0,
      from: "shrine",
      text: "叮咚。神社上線了。\nThe shrine is online. Ask it something — every answer is read off chain 56 as it is sent.",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(1);
  const log = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    // Keep the newest line in view without yanking the whole page.
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const send = useCallback(async (t: Topic) => {
    if (busy) return;
    setBusy(true);
    play("click");

    const mine = { id: seq.current++, from: "me" as const, text: t.ask };
    const typing = { id: seq.current++, from: "shrine" as const, text: "對方正在輸入…", pending: true };
    setMsgs((m) => [...m, mine, typing]);

    let reply: string;
    try {
      const [text] = await Promise.all([t.answer(), new Promise((r) => setTimeout(r, 700))]);
      reply = text;
    } catch {
      // A chatbot is the worst place to invent a number, so it says nothing
      // rather than something.
      reply =
        "讀不到鏈上資料。\nI could not read that off the chain just now — so I am not going to guess at it. Try again in a moment.";
    }
    if (!alive.current) return;

    setMsgs((m) => m.filter((x) => !x.pending).concat({ id: seq.current++, from: "shrine", text: reply }));
    play("ding");
    setBusy(false);
  }, [busy]);

  return (
    <Frame title="企鵝 — Messenger" icon="penguin" onClose={onClose} width={430}>
      <div className="qq">
        <div className="qq-head">
          <PixelIcon name="penguin" size={32} />
          <div>
            <div className="qq-name">神社 <span className="qq-status">線上 · online</span></div>
            <div className="qq-sig">a tax, a pot, and a queue</div>
          </div>
        </div>

        <div className="qq-log" ref={log}>
          {msgs.map((m) => (
            <div key={m.id} className={`qq-msg ${m.from}${m.pending ? " pending" : ""}`}>
              <span className="qq-who">{m.from === "me" ? "你" : "神社"}</span>
              <div className="qq-bubble">{m.text}</div>
            </div>
          ))}
        </div>

        <div className="qq-asks">
          {TOPICS.map((t) => (
            <button key={t.key} className="mini" disabled={busy} onClick={() => void send(t)}>
              {t.ask}
            </button>
          ))}
        </div>

        <p className="sub">
          Canned questions, live answers. Nothing here is stored or sent anywhere — the replies are
          `eth_call`s against{" "}
          <a className="link" href={`${EXPLORER}/address/${TORII.treasury}`} target="_blank" rel="noreferrer">
            the Treasury
          </a>{" "}
          made when you click, and if one fails the shrine says so instead of guessing.
        </p>
      </div>
    </Frame>
  );
}
