import { useEffect, useRef, useState } from "react";
import { play } from "./sound";

/**
 * The no-internet runner, rebuilt on the neon grid.
 *
 * Everything is drawn with `fillRect` on a canvas at a fixed 600×160 logical
 * size, scaled up by CSS with `image-rendering: pixelated`. That keeps the
 * pixels square at any window size and means the whole thing ships as code
 * rather than as sprite sheets.
 *
 * The physics are the original's: one jump height, gravity, obstacles that
 * approach at a speed which creeps up with distance. It is a real game — you
 * can lose — because a fake one is only funny once.
 */

const W = 600;
const H = 160;
const GROUND = 128;
const GRAVITY = 0.55;
const JUMP_V = -9.4;
const START_SPEED = 4.2;
const HI_KEY = "torii98:dino-hi";

type Cactus = { x: number; w: number; h: number };

type State = {
  y: number;
  vy: number;
  onGround: boolean;
  speed: number;
  dist: number;
  cacti: Cactus[];
  spawnIn: number;
  dead: boolean;
  frame: number;
};

function fresh(): State {
  return {
    y: GROUND, vy: 0, onGround: true,
    speed: START_SPEED, dist: 0,
    cacti: [], spawnIn: 60,
    dead: false, frame: 0,
  };
}

export default function Dino() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<State>(fresh());
  const rafRef = useRef<number>(0);
  const [score, setScore] = useState(0);
  const [hi, setHi] = useState(() => {
    try { return Number(localStorage.getItem(HI_KEY) ?? 0); } catch { return 0; }
  });
  const [dead, setDead] = useState(false);

  // The jump, and the restart. Both hang off the same gesture so the game needs
  // no instructions beyond "press space".
  const poke = () => {
    const s = stateRef.current;
    if (s.dead) {
      stateRef.current = fresh();
      setDead(false);
      setScore(0);
      play("click");
      return;
    }
    if (s.onGround) {
      s.vy = JUMP_V;
      s.onGround = false;
      play("click");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let last = performance.now();

    const loop = (now: number) => {
      // Fixed-step physics at 60Hz regardless of display refresh, so the game
      // is not twice as hard on a 120Hz screen.
      const steps = Math.min(3, Math.max(1, Math.round((now - last) / 16.67)));
      last = now;
      const s = stateRef.current;

      for (let i = 0; i < steps; i++) {
        if (s.dead) break;
        s.frame++;
        s.dist += s.speed;
        s.speed = START_SPEED + Math.min(5.5, s.dist / 2600);

        s.vy += GRAVITY;
        s.y += s.vy;
        if (s.y >= GROUND) { s.y = GROUND; s.vy = 0; s.onGround = true; }

        if (--s.spawnIn <= 0) {
          const big = Math.random() > 0.62;
          s.cacti.push({
            x: W + 10,
            w: big ? 16 : 10,
            h: big ? 34 : 24,
          });
          // Gap shrinks with speed but never below a jumpable distance.
          s.spawnIn = Math.floor(58 + Math.random() * 60 - s.speed * 3);
        }

        for (const c of s.cacti) c.x -= s.speed;
        s.cacti = s.cacti.filter((c) => c.x + c.w > -4);

        // Collision, with a forgiving inset — pixel-perfect hitboxes on a
        // 600px canvas feel unfair rather than precise.
        const dx = 42, dw = 20;
        for (const c of s.cacti) {
          const hit =
            dx + dw - 4 > c.x &&
            dx + 4 < c.x + c.w &&
            s.y > GROUND - c.h + 6;
          if (hit) {
            s.dead = true;
            setDead(true);
            play("error");
            const final = Math.floor(s.dist / 10);
            setHi((prev) => {
              if (final <= prev) return prev;
              try { localStorage.setItem(HI_KEY, String(final)); } catch { /* private mode */ }
              return final;
            });
          }
        }
      }

      setScore(Math.floor(s.dist / 10));

      // ---- draw ----
      ctx.clearRect(0, 0, W, H);

      // sky
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#1a0838");
      sky.addColorStop(0.62, "#7d1f6a");
      sky.addColorStop(0.63, "#180a30");
      sky.addColorStop(1, "#0d0520");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      // sun
      ctx.fillStyle = "#ff9a3c";
      ctx.beginPath();
      ctx.arc(W - 110, 74, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#180a30";
      for (let i = 0; i < 5; i++) ctx.fillRect(W - 150, 74 + i * 8, 80, 3);

      // grid, scrolling with the run
      ctx.strokeStyle = "rgba(1,205,254,0.45)";
      ctx.lineWidth = 1;
      const off = s.dist % 40;
      for (let i = 0; i < 6; i++) {
        const y = GROUND + 4 + i * i * 1.6;
        if (y > H) break;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255,113,206,0.35)";
      for (let x = -off; x < W + 40; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, GROUND + 4);
        ctx.lineTo(x + (x - W / 2) * 0.9, H);
        ctx.stroke();
      }

      // horizon
      ctx.fillStyle = "#e8b530";
      ctx.fillRect(0, GROUND + 3, W, 1);

      // cacti
      ctx.fillStyle = "#12836b";
      for (const c of s.cacti) {
        ctx.fillRect(c.x, GROUND - c.h, c.w, c.h);
        ctx.fillRect(c.x - 4, GROUND - c.h + 8, 4, 3);
        ctx.fillRect(c.x + c.w, GROUND - c.h + 13, 4, 3);
      }

      // the runner
      const dy = s.y;
      ctx.fillStyle = dead ? "#8b8677" : "#ffffff";
      ctx.fillRect(42 + 10, dy - 24, 12, 10);        // head
      ctx.fillRect(42 + 20, dy - 21, 3, 2);          // snout
      ctx.fillStyle = dead ? "#8b8677" : "#c8102e";
      ctx.fillRect(42 + 15, dy - 22, 2, 2);          // eye
      ctx.fillStyle = dead ? "#8b8677" : "#ffffff";
      ctx.fillRect(42 + 4, dy - 16, 16, 12);         // body
      ctx.fillRect(42, dy - 13, 6, 4);               // tail
      // legs alternate every 6 frames while grounded
      const step = s.onGround && Math.floor(s.frame / 6) % 2 === 0;
      ctx.fillRect(42 + 6, dy - 4, 4, step ? 4 : 2);
      ctx.fillRect(42 + 13, dy - 4, 4, step ? 2 : 4);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [dead]);

  return (
    <div className="dino">
      <div className="dino-hud">
        <span className="hanzi">無網際網路</span>
        <span className="dino-score">
          HI {String(hi).padStart(5, "0")} &nbsp; {String(score).padStart(5, "0")}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        onClick={poke}
        role="img"
        aria-label="Dinosaur runner game"
      />

      <div className="dino-foot">
        {dead ? (
          <>
            <b>G A M E &nbsp; O V E R</b> — space or click to run again
          </>
        ) : (
          <>space or click to jump</>
        )}
      </div>
    </div>
  );
}
