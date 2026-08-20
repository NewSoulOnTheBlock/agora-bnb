import { useCallback, useEffect, useMemo, useState } from "react";
import { Frame } from "./Frame";
import { play } from "./sound";

/**
 * 五子棋 — five in a row, against the machine.
 *
 * ## Why this game and not another
 *
 * The desktop already has the Chrome dinosaur, which is a Western joke. Gomoku
 * is the game that is actually played on paper in Chinese classrooms, it needs
 * no explanation to anyone who has seen a 圍棋 board, and — the reason it fits
 * *here* — it is small enough to implement honestly. A half-working Mahjong
 * solitaire would have been a worse gift than a Gomoku that plays a real game.
 *
 * ## The opponent
 *
 * No search tree, no minimax. It scores every empty point by what both sides
 * would gain from playing it and takes the best — its own threats and yours,
 * with yours weighted slightly higher so it blocks before it builds. That is
 * enough to punish a careless open three and to lose to anyone who plans two
 * moves ahead, which is the right difficulty for something living on a
 * desktop next to a joke about dolphins.
 *
 * The scoring is deliberately shape-aware rather than a flat count: an *open*
 * three (empty at both ends) is worth far more than a closed four, because the
 * open three is the one that actually wins. Counting stones alone produces an
 * opponent that walks into obvious traps.
 */

const N = 13;
const EMPTY = 0, BLACK = 1, WHITE = 2;
type Cell = 0 | 1 | 2;

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;

const inside = (r: number, c: number) => r >= 0 && r < N && c >= 0 && c < N;
const idx = (r: number, c: number) => r * N + c;

function winnerAt(b: Cell[], r: number, c: number): boolean {
  const me = b[idx(r, c)];
  if (me === EMPTY) return false;
  for (const [dr, dc] of DIRS) {
    let run = 1;
    for (const sign of [1, -1]) {
      let rr = r + dr * sign, cc = c + dc * sign;
      while (inside(rr, cc) && b[idx(rr, cc)] === me) { run++; rr += dr * sign; cc += dc * sign; }
    }
    if (run >= 5) return true;
  }
  return false;
}

/**
 * What one point is worth to `me`, summed over the four directions.
 *
 * For each direction the run length is counted both ways and the open ends are
 * tallied. A run of four that is blocked at both ends scores nothing, because
 * it cannot become five.
 */
function scoreFor(b: Cell[], r: number, c: number, me: Cell): number {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let run = 1;
    let open = 0;
    for (const sign of [1, -1]) {
      let rr = r + dr * sign, cc = c + dc * sign;
      while (inside(rr, cc) && b[idx(rr, cc)] === me) { run++; rr += dr * sign; cc += dc * sign; }
      if (inside(rr, cc) && b[idx(rr, cc)] === EMPTY) open++;
    }
    if (run >= 5) total += 1_000_000;
    else if (run === 4) total += open >= 1 ? 100_000 : 0;
    else if (run === 3) total += open === 2 ? 12_000 : open === 1 ? 1_200 : 0;
    else if (run === 2) total += open === 2 ? 600 : open === 1 ? 90 : 0;
    else total += open === 2 ? 30 : 8;
  }
  return total;
}

/** Only points next to an existing stone are worth considering. */
function candidates(b: Cell[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (b[idx(r, c)] !== EMPTY) continue;
      let near = false;
      for (let dr = -2; dr <= 2 && !near; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (inside(r + dr, c + dc) && b[idx(r + dr, c + dc)] !== EMPTY) { near = true; break; }
        }
      }
      if (near) out.push(idx(r, c));
    }
  }
  return out;
}

function bestMove(b: Cell[]): number {
  const cands = candidates(b);
  if (!cands.length) return idx((N - 1) >> 1, (N - 1) >> 1);

  let best = cands[0];
  let bestScore = -1;
  for (const i of cands) {
    const r = Math.floor(i / N), c = i % N;
    // Attack plus defence. Defence is weighted above 1 so a shared point is
    // taken as a block first — losing to a threat you could see is worse than
    // missing a build you could have had next turn.
    const s = scoreFor(b, r, c, WHITE) + scoreFor(b, r, c, BLACK) * 1.15;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

type Status = "play" | "won" | "lost" | "draw";

export function Gomoku({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<Cell[]>(() => Array(N * N).fill(EMPTY) as Cell[]);
  const [status, setStatus] = useState<Status>("play");
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const [moves, setMoves] = useState(0);

  const reset = useCallback(() => {
    setBoard(Array(N * N).fill(EMPTY) as Cell[]);
    setStatus("play");
    setLast(null);
    setMoves(0);
    play("open");
  }, []);

  const place = (i: number) => {
    if (status !== "play" || thinking || board[i] !== EMPTY) return;
    const next = board.slice() as Cell[];
    next[i] = BLACK;
    setBoard(next);
    setLast(i);
    setMoves((m) => m + 1);
    play("click");

    if (winnerAt(next, Math.floor(i / N), i % N)) { setStatus("won"); play("ding"); return; }
    if (next.every((c) => c !== EMPTY)) { setStatus("draw"); return; }
    setThinking(true);
  };

  // The reply runs in an effect rather than inline so the player's stone paints
  // first — placing and answering in one frame looks like the board rejected
  // the move.
  useEffect(() => {
    if (!thinking) return;
    const t = setTimeout(() => {
      // Computed outside the updater. A setState updater must be pure — React
      // is free to call it more than once for a single update, and doing the
      // counter, the sound and the win check in there scored the machine's one
      // reply as two moves.
      const i = bestMove(board);
      if (board[i] !== EMPTY) { setThinking(false); return; }

      const next = board.slice() as Cell[];
      next[i] = WHITE;

      setBoard(next);
      setLast(i);
      setMoves((m) => m + 1);

      if (winnerAt(next, Math.floor(i / N), i % N)) { setStatus("lost"); play("error"); }
      else if (next.every((c) => c !== EMPTY)) setStatus("draw");
      else play("click");

      setThinking(false);
    }, 260);
    return () => clearTimeout(t);
  }, [thinking, board]);

  const message = useMemo(() => {
    if (status === "won") return { hz: "你贏了", en: "You win. Five in a row." };
    if (status === "lost") return { hz: "你輸了", en: "The machine got five first." };
    if (status === "draw") return { hz: "和棋", en: "Board full. A draw." };
    if (thinking) return { hz: "思考中…", en: "White is thinking" };
    return { hz: "輪到你", en: "Your turn — you are black, black moves first" };
  }, [status, thinking]);

  return (
    <Frame title="五子棋 — Gomoku" icon="gomoku" onClose={onClose} width={430}>
      <div className="gomoku">
        <div className={`goban${status !== "play" ? " over" : ""}`}>
          {board.map((cell, i) => (
            <button
              key={i}
              className={`pt${cell === BLACK ? " b" : cell === WHITE ? " w" : ""}${i === last ? " last" : ""}`}
              onClick={() => place(i)}
              disabled={status !== "play" || thinking || cell !== EMPTY}
              aria-label={`${Math.floor(i / N) + 1},${(i % N) + 1}`}
            />
          ))}
        </div>

        <div className="go-foot">
          <span className={`go-msg ${status}`}>
            <b>{message.hz}</b> <span className="muted">{message.en}</span>
          </span>
          <span className="muted mono">{moves} 手</span>
        </div>

        <div className="dialog-btns" style={{ justifyContent: "flex-start", marginTop: 8 }}>
          <button className="btn" onClick={reset}>重新開始 · New game</button>
        </div>

        <p className="sub">
          Black moves first and that is a real advantage — competitive rules handicap it for exactly
          that reason. The opponent scores every point by what both sides would gain from it and
          plays the best one; it has no search tree, so it will block an open three and lose to a
          double threat.
        </p>
      </div>
    </Frame>
  );
}
