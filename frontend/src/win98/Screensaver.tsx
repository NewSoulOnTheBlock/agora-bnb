import { useEffect, useRef, useState } from "react";

/**
 * The screensaver.
 *
 * Idle for `idleMs` and the desktop hands over to a starfield with the AGORA
 * medallion tumbling through it — the flying-logo screensaver every machine of
 * the era shipped, on the vapourwave grid.
 *
 * Any input dismisses it. The idle timer is reset by pointer, key and scroll
 * events registered in the **capture** phase, so a click that lands on a button
 * still counts as activity before the button handles it.
 *
 * It respects `prefers-reduced-motion` by not starting at all: an unexpected
 * full-screen animation is exactly what that setting exists to prevent.
 */

type Star = { x: number; y: number; z: number };
type Mark = { x: number; y: number; vx: number; vy: number; r: number; spin: number };

export default function Screensaver({ idleMs = 60_000 }: { idleMs?: number }) {
  const [active, setActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const logoRef = useRef<HTMLImageElement | null>(null);

  // ---- idle detection -----------------------------------------------------
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setActive(true), idleMs);
    };
    const wake = () => {
      setActive((was) => {
        if (was) return false;
        return was;
      });
      arm();
    };

    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, wake, { capture: true, passive: true });
    arm();

    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake, { capture: true });
    };
  }, [idleMs]);

  // ---- the animation ------------------------------------------------------
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fit = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    fit();
    window.addEventListener("resize", fit);

    if (!logoRef.current) {
      const img = new Image();
      img.src = "/logo.png";
      logoRef.current = img;
    }

    const W = () => canvas.width;
    const H = () => canvas.height;

    const stars: Star[] = Array.from({ length: 220 }, () => ({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z: Math.random(),
    }));

    const marks: Mark[] = Array.from({ length: 5 }, () => ({
      x: Math.random() * 600 + 60,
      y: Math.random() * 400 + 60,
      vx: (Math.random() > 0.5 ? 1 : -1) * (0.8 + Math.random() * 1.1),
      vy: (Math.random() > 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.9),
      r: 22 + Math.random() * 26,
      spin: (Math.random() - 0.5) * 0.02,
    }));

    let t = 0;

    const frame = () => {
      t += 1;
      const w = W(), h = H();

      // Trails rather than a hard clear — the streaking is most of the effect.
      ctx.fillStyle = "rgba(9, 3, 20, 0.28)";
      ctx.fillRect(0, 0, w, h);

      // starfield, flying toward the viewer
      const cx = w / 2, cy = h / 2;
      for (const s of stars) {
        s.z -= 0.0038;
        if (s.z <= 0.02) {
          s.x = Math.random() * 2 - 1;
          s.y = Math.random() * 2 - 1;
          s.z = 1;
        }
        const k = 0.5 / s.z;
        const px = cx + s.x * k * cx;
        const py = cy + s.y * k * cy;
        if (px < 0 || px > w || py < 0 || py > h) continue;
        const size = Math.max(1, (1 - s.z) * 2.6);
        ctx.fillStyle = s.z > 0.6 ? "#7a5aa0" : s.z > 0.3 ? "#01cdfe" : "#ff71ce";
        ctx.fillRect(px, py, size, size);
      }

      // the horizon, so it reads as the same world as the desktop
      const hy = h * 0.72;
      ctx.strokeStyle = "rgba(1,205,254,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(w, hy); ctx.stroke();
      ctx.strokeStyle = "rgba(255,113,206,0.16)";
      const off = (t * 1.6) % 46;
      for (let i = 0; i < 9; i++) {
        const y = hy + i * i * 2.4 + off * (i / 9);
        if (y > h) break;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // the medallions
      const logo = logoRef.current;
      for (const m of marks) {
        m.x += m.vx;
        m.y += m.vy;
        if (m.x < m.r || m.x > w - m.r) m.vx *= -1;
        if (m.y < m.r || m.y > h - m.r) m.vy *= -1;

        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(t * m.spin);
        ctx.globalAlpha = 0.9;
        if (logo?.complete && logo.naturalWidth) {
          ctx.drawImage(logo, -m.r, -m.r, m.r * 2, m.r * 2);
        } else {
          // Until the image decodes, a drawn ring stands in.
          ctx.strokeStyle = "#ff71ce";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, m.r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", fit);
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className="saver" aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="saver-hint">move the mouse to wake</div>
    </div>
  );
}
