import { useCallback, useEffect, useRef, useState } from "react";
import { readProvider, EXPLORER } from "../chain";
import { Frame } from "./Frame";
import { play } from "./sound";

/**
 * 求籤 — the fortune sticks.
 *
 * You shake a bamboo tube until one stick works its way out, take the number to
 * the counter, and read the slip it corresponds to. It is what a shrine is
 * *for*, and this token is literally named 神社, so it belongs here more than
 * anything else on the desktop does.
 *
 * ## The randomness is real, and that is the whole point
 *
 * `Math.random()` would have been one line. But this page's entire claim is
 * that its numbers come from the chain and can be checked, and a fortune teller
 * that quietly makes things up would be the one dishonest thing on it — a small
 * lie, in a product whose pitch is that it does not tell them.
 *
 * So the draw is `keccak(blockhash ‖ address) mod 100`, taken from a block that
 * had already been mined before you clicked. The block number and hash are
 * printed under the result. Anyone can recompute it, and nobody — including us
 * — could have chosen it.
 *
 * The address is mixed in so two people shaking on the same block do not get
 * the same stick, and the block advances every 0.45 seconds on BNB Chain, so a
 * second shake is a different draw.
 */

/** The seven traditional grades, worst to best, with the share each takes. */
const GRADES = [
  { min: 0,  label: "大凶", roman: "dà xiōng", en: "great curse", tone: "bad" },
  { min: 5,  label: "凶",   roman: "xiōng",     en: "curse",       tone: "bad" },
  { min: 15, label: "末吉", roman: "mò jí",     en: "last luck",   tone: "mid" },
  { min: 30, label: "小吉", roman: "xiǎo jí",   en: "small luck",  tone: "mid" },
  { min: 50, label: "中吉", roman: "zhōng jí",  en: "middle luck", tone: "good" },
  { min: 72, label: "吉",   roman: "jí",        en: "luck",        tone: "good" },
  { min: 92, label: "大吉", roman: "dà jí",     en: "great luck",  tone: "best" },
] as const;

/**
 * The slips.
 *
 * Written to the register of a real 籤詩 — a couplet, concrete image, no
 * explanation — but every one of them is also true of these contracts. The
 * fortune and the protocol are saying the same thing, which is the only way a
 * joke like this earns its place on a page about money.
 */
const SLIPS: Record<string, string[]> = {
  大凶: [
    "山高路遠　風雨不歇\nThe mountain is high and the rain does not stop. Nothing is owed to you here.",
    "空手而來　空手而去\nEmpty-handed you came, empty-handed you may leave. The floor is not a promise.",
  ],
  凶: [
    "急水行舟　不進反退\nRowing hard against fast water. Selling into the tax costs twice.",
    "月落無聲　燈火未明\nThe moon sets without a sound. Wait for the light rather than the noise.",
  ],
  末吉: [
    "石上滴水　久而成穿\nWater on stone, patient, eventually through. Every taxed trade adds a drop.",
    "小舟已渡　岸猶在遠\nThe small boat has crossed; the far bank is still distant.",
  ],
  小吉: [
    "春風入戶　舊事漸新\nSpring wind enters the door. The pot is larger than it was yesterday.",
    "積土成山　積水成淵\nEarth piles into a mountain, water into a deep pool. This is the mechanism.",
  ],
  中吉: [
    "門前有客　庭中有香\nGuests at the gate, incense in the courtyard. Others have found the shrine.",
    "火燒而壁堅　人去而牆高\nThe fire burns and the wall stands. Every redemption raises the floor for whoever stayed.",
  ],
  吉: [
    "潮來船高　不必爭渡\nThe tide lifts the boat; no need to fight for the crossing.",
    "守株可待　樹已生根\nWait by the tree — this one has actually taken root.",
  ],
  大吉: [
    "金石為開　萬事亨通\nEven stone opens. The tax never sleeps and it is working for you.",
    "登樓望遠　天地皆春\nClimb the tower and look far: spring in every direction.",
  ],
};

type Grade = (typeof GRADES)[number];

function gradeFor(n: number): Grade {
  let g: Grade = GRADES[0];
  for (const cand of GRADES) if (n >= cand.min) g = cand;
  return g;
}

type Draw = {
  /** 1–100, the number on the stick. */
  stick: number;
  grade: Grade;
  slip: string;
  block: number;
  hash: string;
};

export function Fortune({
  account,
  onClose,
}: {
  account: string | null;
  onClose: () => void;
}) {
  const [draw, setDraw] = useState<Draw | null>(null);
  const [shaking, setShaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  // Set on mount, not only cleared on unmount. React's StrictMode mounts,
  // unmounts and remounts in development, so a ref that is only ever set to
  // false stays false for the rest of the session — and every shake would then
  // resolve into a discarded result with the tube spinning forever.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const shake = useCallback(async () => {
    setShaking(true);
    setErr(null);
    setDraw(null);
    play("click");

    try {
      const [{ keccak256, solidityPacked, getAddress }, head] = await Promise.all([
        import("ethers"),
        readProvider.getBlockNumber(),
      ]);

      // One block back, so the hash is settled before the click rather than
      // being whatever lands next — a fortune should not be front-runnable.
      const target = Math.max(0, head - 1);
      const block = await readProvider.getBlock(target);
      if (!block?.hash) throw new Error("could not read the block");

      // Without a wallet the seed is the tube itself, so a shake still works;
      // it just means everyone shaking on this block draws together.
      const who = account ? getAddress(account) : "0x0000000000000000000000000000000000000000";
      const seed = keccak256(solidityPacked(["bytes32", "address"], [block.hash, who]));

      const stick = Number(BigInt(seed) % 100n) + 1;
      const grade = gradeFor(stick - 1);
      const pool = SLIPS[grade.label] ?? [];
      const slip = pool[Number(BigInt(seed) % BigInt(Math.max(1, pool.length)))] ?? "";

      // A shake that resolves instantly does not feel like a shake.
      await new Promise((r) => setTimeout(r, 900));
      if (!alive.current) return;

      setDraw({ stick, grade, slip, block: block.number, hash: block.hash });
      play(grade.tone === "bad" ? "error" : "ding");
    } catch (e: any) {
      if (!alive.current) return;
      setErr(e?.shortMessage ?? e?.message ?? "the chain did not answer");
      play("error");
    } finally {
      if (alive.current) setShaking(false);
    }
  }, [account]);

  const [head, body] = draw ? splitSlip(draw.slip) : ["", ""];

  return (
    <Frame title="求籤 — Fortune Sticks" icon="sticks" onClose={onClose} width={430}>
      <div className="fortune">
        <div className={`tube${shaking ? " shaking" : ""}`} aria-hidden="true">
          <span className="stick s1" />
          <span className="stick s2" />
          <span className="stick s3" />
          <span className="tube-body">籤</span>
        </div>

        {err ? (
          <p className="err" style={{ marginTop: 0 }}>{err}</p>
        ) : shaking ? (
          <p className="muted" style={{ margin: 0 }}>搖籤中… shaking the tube</p>
        ) : draw ? (
          <>
            <div className={`grade ${draw.grade.tone}`}>
              <span className="hz">{draw.grade.label}</span>
              <span className="rm">{draw.grade.roman} · {draw.grade.en}</span>
            </div>
            <div className="stick-no">第 {draw.stick} 籤</div>
            <div className="slip">
              <div className="slip-hz">{head}</div>
              <div className="slip-en">{body}</div>
            </div>
          </>
        ) : (
          <p className="sub" style={{ textAlign: "center", marginTop: 0 }}>
            Shake the tube. One stick will fall.
          </p>
        )}

        <button className="btn primary" disabled={shaking} onClick={() => void shake()}>
          {shaking ? "搖籤中…" : draw ? "再搖一次 · Shake again" : "搖籤 · Shake"}
        </button>

        {draw && (
          <p className="sub" style={{ marginTop: 10 }}>
            Drawn from block{" "}
            <a
              className="link"
              href={`${EXPLORER}/block/${draw.block}`}
              target="_blank"
              rel="noreferrer"
            >
              #{draw.block}
            </a>{" "}
            — <code>keccak(blockhash ‖ address) mod 100</code>. Recompute it yourself; the block was
            mined before you clicked, so nobody chose this, including us.
            <br />
            <span className="n">{draw.hash.slice(0, 26)}…</span>
          </p>
        )}
      </div>
    </Frame>
  );
}

/** Slips are "漢字 couplet \n English reading". */
function splitSlip(s: string): [string, string] {
  const i = s.indexOf("\n");
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
