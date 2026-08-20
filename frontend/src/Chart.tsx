import { useEffect, useRef, useState } from "react";
import { readCandles, BUCKETS, type Candle, type Bucket } from "./candles";
import { fmtSig } from "./format";

/**
 * A candlestick readout, drawn on a canvas in the same idiom as the rest of the
 * panel — dark ground, neon marks, monospace axis.
 *
 * Everything is `fillRect`, so there is no charting library in the bundle and
 * nothing to keep in sync with the theme. The price axis is logarithmic,
 * because a token that traded between 8.1e-9 and 1.9e-8 in its first hour has
 * a range a linear axis renders as a flat line with one spike.
 */

const PAD = { l: 8, r: 74, t: 10, b: 20 };

function fmtClock(t: number, bucket: Bucket) {
  const d = new Date(t * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (bucket >= 86400) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${hh}:${mm}`;
}

export default function Chart() {
  const [bucket, setBucket] = useState<Bucket>(60);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  /** True when the RPC refused part of the range — see `history.ts`. */
  const [wall, setWall] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    setCandles(null);
    setErr(null);
    readCandles(bucket)
      .then((r) => {
        if (!alive) return;
        setCandles(r.candles);
        setWall(r.reachedWall);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [bucket]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !candles) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // ground
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#25073f");
    g.addColorStop(1, "#12041f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    if (!candles.length) {
      ctx.fillStyle = "#8a6aa8";
      ctx.font = "11px 'Lucida Console', monospace";
      // "Nothing traded" and "the node would not answer" are different facts,
      // and drawing an empty chart for the second is how a limitation starts
      // reading as a measurement.
      ctx.fillText(
        wall ? "the RPC would not serve this range" : "no swaps in range",
        12,
        H / 2
      );
      return;
    }

    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;

    const lo = Math.min(...candles.map((c) => c.l));
    const hi = Math.max(...candles.map((c) => c.h));
    // Log scale, with a little headroom so the extremes are not on the frame.
    const l0 = Math.log(lo) - (Math.log(hi) - Math.log(lo)) * 0.06 - 1e-9;
    const l1 = Math.log(hi) + (Math.log(hi) - Math.log(lo)) * 0.06 + 1e-9;
    const y = (p: number) => PAD.t + plotH - ((Math.log(p) - l0) / (l1 - l0)) * plotH;

    // horizontal rules + price axis
    ctx.font = "10px 'Lucida Console', monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const yy = PAD.t + (plotH * i) / 4;
      ctx.strokeStyle = "rgba(255,113,206,0.13)";
      ctx.beginPath();
      ctx.moveTo(PAD.l, yy + 0.5);
      ctx.lineTo(PAD.l + plotW, yy + 0.5);
      ctx.stroke();

      const price = Math.exp(l1 - ((l1 - l0) * i) / 4);
      ctx.fillStyle = "#b06ac0";
      ctx.fillText(price.toExponential(2), PAD.l + plotW + 6, yy);
    }

    const n = candles.length;
    const step = plotW / n;
    const bodyW = Math.max(1, Math.min(9, step * 0.68));

    candles.forEach((c, i) => {
      const cx = PAD.l + step * (i + 0.5);
      const up = c.c >= c.o;
      // Jade rises, cinnabar falls — the Chinese convention is the
      // opposite of the Western one, and this page is Chinese.
      const colour = up ? "#12836b" : "#c8102e";

      // wick
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(c.h));
      ctx.lineTo(Math.round(cx) + 0.5, y(c.l));
      ctx.stroke();

      // body — a doji still needs one pixel of presence
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      const yo = y(c.o);
      const yc = y(c.c);
      const top = Math.min(yo, yc);
      const h = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(Math.round(cx - bodyW / 2), Math.round(top), Math.round(bodyW), Math.round(h));
    });
    ctx.globalAlpha = 1;

    // time axis: first, middle, last
    ctx.fillStyle = "#8a6aa8";
    ctx.textBaseline = "top";
    const marks = [0, Math.floor(n / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of marks) {
      const cx = PAD.l + step * (i + 0.5);
      const label = fmtClock(candles[i].t, bucket);
      const w = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(Math.max(PAD.l, cx - w / 2), PAD.l + plotW - w), H - PAD.b + 5);
    }

    // last price marker
    const last = candles[n - 1];
    ctx.strokeStyle = "rgba(1,205,254,0.6)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, y(last.c) + 0.5);
    ctx.lineTo(PAD.l + plotW, y(last.c) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [candles, bucket, wall]);

  const last = candles?.length ? candles[candles.length - 1] : null;
  const first = candles?.length ? candles[0] : null;
  const change =
    last && first && first.o > 0 ? ((last.c - first.o) / first.o) * 100 : null;

  return (
    <div className="chart">
      <div className="chart-top">
        <span className="chart-price">
          {last ? `${fmtSig(BigInt(Math.round(last.c * 1e18)))} ETH` : "—"}
        </span>
        {change !== null && (
          <span className={`premium ${change >= 0 ? "pos" : "neg"}`}>
            {change >= 0 ? "+" : ""}
            {change.toFixed(2)}%
          </span>
        )}
        <span style={{ flex: 1 }} />
        <div className="swapdir" style={{ margin: 0 }}>
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              className="mini"
              aria-selected={bucket === b.id}
              onClick={() => setBucket(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <canvas ref={ref} width={620} height={210} role="img" aria-label="TORII price chart" />

      <div className="chart-foot">
        {err ? (
          <span className="err">{err}</span>
        ) : !candles ? (
          <>reading Swap events…</>
        ) : (
          <>
            {candles.length} candles · {candles.reduce((a, c) => a + c.trades, 0)} swaps ·{" "}
            {candles.reduce((a, c) => a + c.v, 0).toFixed(4)} BNB volume · built from pair
            logs, no third-party feed
            {wall && (
              <span className="warnline">
                {" "}· range truncated: free BSC nodes serve about 75 minutes of logs
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
