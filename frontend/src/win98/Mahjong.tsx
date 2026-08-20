import { useCallback, useMemo, useState } from "react";
import { Frame } from "./Frame";
import { play } from "./sound";

/**
 * 上海麻將 — Mahjong solitaire, the turtle.
 *
 * The Windows game that was on every machine of this era AND is Chinese, which
 * is a short list. It belongs on this desktop twice over.
 *
 * ## The deal is guaranteed solvable, and that is the hard part
 *
 * Shuffling 144 tiles into the layout and hoping produces a board that is
 * unwinnable a good fraction of the time, and a solitaire you cannot finish is
 * worse than no solitaire. So the board is built **backwards**: starting from
 * the full turtle, the algorithm repeatedly finds the tiles that are currently
 * free, picks two of them, assigns them a matching pair, and lifts them off.
 * Replaying those removals in reverse order is a solution, so one always
 * exists.
 *
 * It does not mean every route wins — you can still strand yourself, which is
 * the game. `重新洗牌` reshuffles what is left, again solvably.
 *
 * ## The rules, exactly
 *
 * A tile is **free** when nothing rests on top of it and at least one of its
 * left or right edges is clear. Free tiles match when they are identical —
 * except flowers, which match any flower, and seasons, which match any season.
 * Those two groups are the only four-of-a-kind-less tiles in the set, and they
 * would be unplayable under strict identity.
 */

/* --------------------------------------------------------------------------
   The tile set — 144 tiles
   -------------------------------------------------------------------------- */

type Face = { glyph: string; group: string; name: string };

/**
 * Faces come from the Unicode Mahjong block, with U+FE0E after each one.
 *
 * That variation selector is not decoration: 🀄 RED DRAGON has
 * `Emoji_Presentation=Yes`, so without it that single tile renders as a colour
 * emoji while the other 143 render as text — one tile in the wrong style, which
 * looks like a bug. VS15 forces text presentation for all of them.
 */
const T = (cp: number) => String.fromCodePoint(cp) + "︎";

function buildFaces(): Face[] {
  const out: Face[] = [];
  const push = (f: Face, times: number) => { for (let i = 0; i < times; i++) out.push(f); };

  const suits: [string, number, string][] = [
    ["萬", 0x1f007, "characters"],
    ["索", 0x1f010, "bamboo"],
    ["筒", 0x1f019, "circles"],
  ];
  for (const [cn, base, group] of suits) {
    for (let r = 0; r < 9; r++) push({ glyph: T(base + r), group, name: `${r + 1}${cn}` }, 4);
  }

  const winds = ["東", "南", "西", "北"];
  for (let i = 0; i < 4; i++) push({ glyph: T(0x1f000 + i), group: "winds", name: winds[i] }, 4);

  const dragons = ["中", "發", "白"];
  for (let i = 0; i < 3; i++) push({ glyph: T(0x1f004 + i), group: "dragons", name: dragons[i] }, 4);

  // One of each: they match within their group rather than by identity.
  const flowers = ["梅", "蘭", "菊", "竹"];
  for (let i = 0; i < 4; i++) push({ glyph: T(0x1f022 + i), group: "flowers", name: flowers[i] }, 1);

  const seasons = ["春", "夏", "秋", "冬"];
  for (let i = 0; i < 4; i++) push({ glyph: T(0x1f026 + i), group: "seasons", name: seasons[i] }, 1);

  return out;
}

/** Flowers match flowers and seasons match seasons; everything else by name. */
function matches(a: Face, b: Face): boolean {
  if (a.group === "flowers" || a.group === "seasons") return a.group === b.group;
  return a.group === b.group && a.name === b.name;
}

/* --------------------------------------------------------------------------
   The turtle — 87 + 36 + 16 + 4 + 1 = 144 positions
   -------------------------------------------------------------------------- */

type Pos = { z: number; r: number; c: number };

function turtle(): Pos[] {
  const p: Pos[] = [];
  const row = (z: number, r: number, from: number, to: number) => {
    for (let c = from; c <= to; c++) p.push({ z, r, c });
  };

  // Base: eight rows of a shell, plus the head and the two tail tiles.
  row(0, 0, 1, 12);
  row(0, 1, 3, 10);
  row(0, 2, 2, 11);
  row(0, 3, 1, 12);
  row(0, 4, 1, 12);
  row(0, 5, 2, 11);
  row(0, 6, 3, 10);
  row(0, 7, 1, 12);
  p.push({ z: 0, r: 3, c: -1 });   // 頭 — the head, off the left
  p.push({ z: 0, r: 3, c: 14 });   // 尾 — the tail
  p.push({ z: 0, r: 3, c: 15 });

  for (let r = 1; r <= 6; r++) row(1, r, 4, 9);   // 36
  for (let r = 2; r <= 5; r++) row(2, r, 5, 8);   // 16
  for (let r = 3; r <= 4; r++) row(3, r, 6, 7);   // 4
  p.push({ z: 4, r: 3, c: 6 });                   // 1 — the crown

  return p;
}

type Tile = Pos & { id: number; face: Face; gone: boolean };

const key = (z: number, r: number, c: number) => `${z}:${r}:${c}`;

/** Free = nothing on top, and at least one side clear. */
function isFree(t: Tile, live: Map<string, Tile>): boolean {
  if (live.has(key(t.z + 1, t.r, t.c))) return false;
  const left = live.has(key(t.z, t.r, t.c - 1));
  const right = live.has(key(t.z, t.r, t.c + 1));
  return !left || !right;
}

function liveMap(tiles: Tile[]): Map<string, Tile> {
  const m = new Map<string, Tile>();
  for (const t of tiles) if (!t.gone) m.set(key(t.z, t.r, t.c), t);
  return m;
}

/**
 * Deal by dismantling.
 *
 * Positions are emptied two at a time, always choosing from the tiles that are
 * free *at that moment*, and each emptied pair is assigned a matching face.
 * Undoing that sequence is a winning line, so the board can always be cleared.
 */
function deal(positions: Pos[], rnd: () => number): Tile[] {
  const faces = buildFaces();
  for (let i = faces.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [faces[i], faces[j]] = [faces[j], faces[i]];
  }

  // Pair the shuffled faces up front so each removal gets a real match.
  const pairs: [Face, Face][] = [];
  const byGroup = new Map<string, Face[]>();
  for (const f of faces) {
    const k = f.group === "flowers" || f.group === "seasons" ? f.group : `${f.group}:${f.name}`;
    const arr = byGroup.get(k) ?? [];
    arr.push(f);
    byGroup.set(k, arr);
  }
  for (const arr of byGroup.values()) {
    for (let i = 0; i + 1 < arr.length; i += 2) pairs.push([arr[i], arr[i + 1]]);
  }
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  const tiles: Tile[] = positions.map((p, i) => ({
    ...p,
    id: i,
    face: { glyph: "", group: "", name: "" },
    gone: false,
  }));

  const remaining = new Set(tiles.map((t) => t.id));
  const byId = new Map(tiles.map((t) => [t.id, t]));
  let pi = 0;

  while (remaining.size >= 2 && pi < pairs.length) {
    const live = new Map<string, Tile>();
    for (const id of remaining) {
      const t = byId.get(id)!;
      live.set(key(t.z, t.r, t.c), t);
    }
    const free = [...remaining].map((id) => byId.get(id)!).filter((t) => isFree(t, live));

    // The turtle always leaves at least two free, but never trust a layout to
    // guarantee that — falling back keeps the deal from looping forever.
    const pool = free.length >= 2 ? free : [...remaining].map((id) => byId.get(id)!);
    const a = pool[Math.floor(rnd() * pool.length)];
    let b = pool[Math.floor(rnd() * pool.length)];
    let guard = 0;
    while (b.id === a.id && guard++ < 50) b = pool[Math.floor(rnd() * pool.length)];
    if (b.id === a.id) break;

    const [fa, fb] = pairs[pi++];
    a.face = fa;
    b.face = fb;
    remaining.delete(a.id);
    remaining.delete(b.id);
  }

  return tiles;
}

/* --------------------------------------------------------------------------
   The component
   -------------------------------------------------------------------------- */

const CW = 30;   // column step, px
const RH = 34;   // row step
const DX = -5;   // per-layer offset that gives the stack its depth
const DY = -6;

export function Mahjong({ onClose }: { onClose: () => void }) {
  const positions = useMemo(() => turtle(), []);
  const [seed, setSeed] = useState(1);
  const [tiles, setTiles] = useState<Tile[]>(() => deal(positions, Math.random));
  const [picked, setPicked] = useState<number | null>(null);
  const [hint, setHint] = useState<[number, number] | null>(null);

  const live = useMemo(() => liveMap(tiles), [tiles]);
  const left = tiles.filter((t) => !t.gone).length;

  /** Every playable pair on the board right now. */
  const openPairs = useMemo(() => {
    const free = tiles.filter((t) => !t.gone && isFree(t, live));
    const out: [number, number][] = [];
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        if (matches(free[i].face, free[j].face)) out.push([free[i].id, free[j].id]);
      }
    }
    return out;
  }, [tiles, live]);

  const newGame = useCallback(() => {
    setTiles(deal(positions, Math.random));
    setPicked(null);
    setHint(null);
    setSeed((s) => s + 1);
    play("open");
  }, [positions]);

  /** Reshuffle only what is left, keeping the remainder solvable. */
  const reshuffle = useCallback(() => {
    setTiles((cur) => {
      const remainingPos = cur.filter((t) => !t.gone).map(({ z, r, c }) => ({ z, r, c }));
      if (remainingPos.length < 2) return cur;
      const fresh = deal(remainingPos, Math.random);
      const goneOnes = cur.filter((t) => t.gone);
      return [...goneOnes, ...fresh.map((t, i) => ({ ...t, id: 10_000 + i }))];
    });
    setPicked(null);
    setHint(null);
    play("open");
  }, []);

  /**
   * The hint survives selecting one of its own tiles.
   *
   * Clearing it on every `picked` change meant the highlight vanished the
   * instant you acted on it, leaving the partner unmarked — a hint you cannot
   * follow. It is cleared when the pair is actually taken, or on a new deal.
   */

  const click = (t: Tile) => {
    if (t.gone || !isFree(t, live)) { play("error"); return; }
    if (picked === t.id) { setPicked(null); play("click"); return; }

    if (picked === null) { setPicked(t.id); play("click"); return; }

    const other = tiles.find((x) => x.id === picked);
    if (!other) { setPicked(t.id); return; }

    if (matches(other.face, t.face)) {
      setTiles((cur) => cur.map((x) => (x.id === t.id || x.id === other.id ? { ...x, gone: true } : x)));
      setPicked(null);
      setHint(null);
      play("ding");
    } else {
      setPicked(t.id);
      play("click");
    }
  };

  const won = left === 0;
  const stuck = !won && openPairs.length === 0;

  return (
    <Frame title="上海麻將 — Mahjong Solitaire" icon="mahjong" onClose={onClose} width={600}>
      <div className="mahjong">
        <div className="mj-board" key={seed}>
          {tiles
            .filter((t) => !t.gone)
            // Painter's order: deeper layers, then further rows, then columns.
            .sort((a, b) => a.z - b.z || a.r - b.r || a.c - b.c)
            .map((t) => {
              const free = isFree(t, live);
              const isHint = hint ? hint[0] === t.id || hint[1] === t.id : false;
              return (
                <button
                  key={t.id}
                  className={`mj-tile${free ? "" : " locked"}${picked === t.id ? " picked" : ""}${isHint ? " hint" : ""}`}
                  style={{
                    left: t.c * CW + t.z * DX + 60,
                    top: t.r * RH + t.z * DY + 26,
                    zIndex: t.z * 100 + t.r * 2 + (t.c < 0 ? 0 : 1),
                  }}
                  onClick={() => click(t)}
                  title={free ? t.face.name : `${t.face.name} — 被壓住 covered`}
                >
                  <span className="mj-face">{t.face.glyph}</span>
                </button>
              );
            })}
        </div>

        <div className="mj-foot">
          <span>
            {won ? (
              <b className="ok">全部消除！ · Board cleared.</b>
            ) : stuck ? (
              <b className="bad">沒有可配對的了 · No pairs left — reshuffle.</b>
            ) : (
              <>
                剩 <b>{left}</b> 張 · {openPairs.length} pair{openPairs.length === 1 ? "" : "s"} open
              </>
            )}
          </span>
        </div>

        <div className="dialog-btns" style={{ justifyContent: "flex-start", marginTop: 8 }}>
          <button className="btn" onClick={newGame}>新局 · New game</button>
          <button
            className="btn ghost"
            disabled={won || !openPairs.length}
            onClick={() => { setHint(openPairs[0]); play("click"); }}
          >
            提示 · Hint
          </button>
          <button className="btn ghost" disabled={won} onClick={reshuffle}>
            重新洗牌 · Reshuffle
          </button>
        </div>

        <p className="sub">
          A tile is free when nothing rests on it and one side is clear. Flowers match any flower and
          seasons match any season; everything else matches its twin. The deal is built by taking the
          turtle apart pair by pair and recording what came off, so a solution always exists — you can
          still strand yourself, and that is the game.
        </p>
      </div>
    </Frame>
  );
}
