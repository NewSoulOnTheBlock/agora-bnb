/**
 * Pixel-art icons, drawn as SVG rects.
 *
 * Why not just download the Windows 98 icon set: those are Microsoft's
 * artwork, and shipping them in a production financial app is a licensing
 * question nobody needs. These are drawn here instead — same 16×16 grid, same
 * 16-colour VGA palette, no third-party assets, and they scale to any size
 * without blurring because `shape-rendering: crispEdges` keeps the pixel grid.
 *
 * Each icon is a 16-row array of 16-character strings, one char per pixel,
 * indexing PALETTE below. A space is transparent. `assertIcons()` in
 * `pixel.test-ish` guard below runs in dev and shouts if a row is the wrong
 * width — hand-drawn ASCII is easy to get subtly wrong.
 */

export const PALETTE: Record<string, string> = {
  k: "#000000", // black
  w: "#ffffff", // white
  g: "#808080", // dark gray  (shadow)
  l: "#c0c0c0", // silver     (face)
  s: "#dfdfdf", // light gray (highlight)
  b: "#000080", // navy
  u: "#0000ff", // blue
  c: "#00a8a8", // teal screen
  t: "#00ffff", // cyan
  r: "#a80000", // dark red
  R: "#ff0000", // red
  n: "#008000", // green
  N: "#00ff00", // bright green
  y: "#ffff00", // yellow
  o: "#a85400", // brown/gold shadow
  O: "#ffd700", // gold
  p: "#a800a8", // purple
};

export type IconMap = readonly string[];

/** A CRT on a stand — the app icon, and the Start button mark. */
export const computer: IconMap = [
  "                ",
  "  kkkkkkkkkkkk  ",
  "  kwwwwwwwwwwgk ",
  "  kwccccccccwgk ",
  "  kwctttttccwgk ",
  "  kwctttttccwgk ",
  "  kwccccccccwgk ",
  "  kwwwwwwwwwwgk ",
  "  kkkkkkkkkkkgk ",
  "   kggggggggggk ",
  "    kkkkkkkkkk  ",
  "     klllllk    ",
  "   kkkkkkkkkkk  ",
  "   kwwwwwwwwwk  ",
  "   kkkkkkkkkkk  ",
  "                ",
];

/** A stack of coins — the Reserve. */
export const coins: IconMap = [
  "                ",
  "     kkkkkk     ",
  "    kOOOOOOk    ",
  "   kOyyyyyyOk   ",
  "   kOyOOOOyOk   ",
  "   kOyOOOOyOk   ",
  "   kOyyyyyyOk   ",
  "   kkOOOOOOkk   ",
  "  kkkkkkkkkkkk  ",
  " kOOOOOOOOOOOOk ",
  " kOyyyyyyyyyyOk ",
  " kOyOOOOOOOOyOk ",
  " kOyyyyyyyyyyOk ",
  " kkOOOOOOOOOOkk ",
  "  kkkkkkkkkkkk  ",
  "                ",
];

/** A bar chart with an up-arrow — Trade. */
export const chart: IconMap = [
  "                ",
  " kwwwwwwwwwwwwk ",
  " kw          wk ",
  " kw        NNwk ",
  " kw      NNNNwk ",
  " kw   uu NNNNwk ",
  " kw   uu NNNNwk ",
  " kwRR uu NNNNwk ",
  " kwRR uu NNNNwk ",
  " kwRR uu NNNNwk ",
  " kwRR uu NNNNwk ",
  " kwRRRuuuNNNNwk ",
  " kwwwwwwwwwwwwk ",
  " kkkkkkkkkkkkkk ",
  "                ",
  "                ",
];

/** A padlock — Stake. */
export const lock: IconMap = [
  "                ",
  "     kkkkkk     ",
  "    kOOOOOOk    ",
  "   kOOkkkkOOk   ",
  "   kOk    kOk   ",
  "   kOk    kOk   ",
  "  kkkkkkkkkkkk  ",
  " kOOOOOOOOOOOOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyykkyyyyyOk ",
  " kOyyykkyyyyyOk ",
  " kOyyykkyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOOOOOOOOOOOOk ",
  "  kkkkkkkkkkkk  ",
  "                ",
];

/** A shirt and necktie. */
export const tie: IconMap = [
  "                ",
  "   kk      kk   ",
  "  kwwk    kwwk  ",
  "  kwwwk  kwwwk  ",
  "  kwwbbkkbbwwk  ",
  "  kww bbbb wwk  ",
  "  kww  bb  wwk  ",
  "  kww  bb  wwk  ",
  "  kww bbbb wwk  ",
  "  kww bbbb wwk  ",
  "  kww bbbb wwk  ",
  "  kww  bb  wwk  ",
  "  kwww    wwwk  ",
  "  kwwwwwwwwwwk  ",
  "  kkkkkkkkkkkk  ",
  "                ",
];

/** A flame — Redeem (burn). */
export const flame: IconMap = [
  "                ",
  "       kk       ",
  "      kRRk      ",
  "      kRRk      ",
  "     kRRRRk     ",
  "    kRRRRRRk    ",
  "   kRRyyyyRRk   ",
  "   kRRyyyyRRk   ",
  "  kRRyyOOyyRRk  ",
  "  kRRyOOOOyRRk  ",
  "  kRRyOOOOyRRk  ",
  "  kRRyyOOyyRRk  ",
  "   kRRyyyyRRk   ",
  "    kRRRRRRk    ",
  "     kkkkkk     ",
  "                ",
];

/** A question mark on a page — Read Me. */
export const help: IconMap = [
  "                ",
  "  kkkkkkkkkk    ",
  "  kwwwwwwwwkk   ",
  "  kwwwwwwwwwk   ",
  "  kwwkkkkwwwk   ",
  "  kwkwwwwkwwk   ",
  "  kwwwwwwkwwk   ",
  "  kwwwwwkwwwk   ",
  "  kwwwwkwwwwk   ",
  "  kwwwwkwwwwk   ",
  "  kwwwwwwwwwk   ",
  "  kwwwwkwwwwk   ",
  "  kwwwwkwwwwk   ",
  "  kwwwwwwwwwk   ",
  "  kkkkkkkkkkk   ",
  "                ",
];

/** Blue circle with an i — informational dialogs. */
export const info: IconMap = [
  "                ",
  "     kkkkkk     ",
  "   kkuuuuuukk   ",
  "  kuuuuwwuuuuk  ",
  " kuuuuuwwuuuuuk ",
  " kuuuuuuuuuuuuk ",
  "kuuuuuwwwuuuuuuk",
  "kuuuuuuwwuuuuuuk",
  "kuuuuuuwwuuuuuuk",
  "kuuuuuuwwuuuuuuk",
  " kuuuuwwwwuuuuk ",
  " kuuuuuuuuuuuuk ",
  "  kuuuuuuuuuuk  ",
  "   kkuuuuuukk   ",
  "     kkkkkk     ",
  "                ",
];

/** Yellow triangle with a bang — warnings. */
export const warning: IconMap = [
  "                ",
  "       kk       ",
  "       kk       ",
  "      kyyk      ",
  "      kyyk      ",
  "     kyykyk     ",
  "     kykkyk     ",
  "    kyykkyyk    ",
  "    kyykkyyk    ",
  "   kyyykkyyyk   ",
  "   kyyykkyyyk   ",
  "  kyyyyyyyyyyk  ",
  "  kyyyykkyyyyk  ",
  " kyyyyyyyyyyyyk ",
  " kkkkkkkkkkkkkk ",
  "                ",
];

/** Red circle with an X — errors. */
export const error: IconMap = [
  "                ",
  "     kkkkkk     ",
  "   kkRRRRRRkk   ",
  "  kRRRRRRRRRRk  ",
  " kRRRwRRRRwRRRk ",
  " kRRRRwRRwRRRRk ",
  "kRRRRRwwwwRRRRRk",
  "kRRRRRRwwRRRRRRk",
  "kRRRRRRwwRRRRRRk",
  "kRRRRRwwwwRRRRRk",
  " kRRRRwRRwRRRRk ",
  " kRRRwRRRRwRRRk ",
  "  kRRRRRRRRRRk  ",
  "   kkRRRRRRkk   ",
  "     kkkkkk     ",
  "                ",
];

/** Two networked machines — the chain/RPC indicator. */
export const network: IconMap = [
  "                ",
  " kkkkkkk        ",
  " kwwwwwgk       ",
  " kwcccwgk       ",
  " kwcccwgk       ",
  " kwwwwwgk       ",
  " kkkkkkgk       ",
  "  kggggggk      ",
  "   kkkkkk kkkkkk",
  "     k    kwwwwg",
  "     kkkkkkwcccw",
  "          kwcccw",
  "          kwwwww",
  "          kkkkkk",
  "           kgggg",
  "                ",
];

/** A folder — generic. */
export const folder: IconMap = [
  "                ",
  "                ",
  "  kkkkk         ",
  " kOOOOOkkkkkkk  ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOyyyyyyyyyyOk ",
  " kOOOOOOOOOOOOk ",
  "  kkkkkkkkkkkk  ",
  "                ",
  "                ",
  "                ",
];

/** A 3.5" diskette — Save. */
export const floppy: IconMap = [
  "                ",
  " kkkkkkkkkkkkk  ",
  " kbbbbbwwwwwbk  ",
  " kbbbbbwwwwwbk  ",
  " kbbbbbwwwwwbk  ",
  " kbbbbbwwwwwbk  ",
  " kbbbbbwwwwwbk  ",
  " kbbbbbbbbbbbk  ",
  " kbbbbbbbbbbbk  ",
  " kbwwwwwwwwwbk  ",
  " kbwkkkkkkkwbk  ",
  " kbwwwwwwwwwbk  ",
  " kbwkkkkkkkwbk  ",
  " kbwwwwwwwwwbk  ",
  " kkkkkkkkkkkkk  ",
  "                ",
];

/** A key — the wallet. */
export const key: IconMap = [
  "                ",
  "                ",
  "     kkkk       ",
  "    kOOOOk      ",
  "   kOOwwOOk     ",
  "   kOOwwOOk     ",
  "   kOOOOOOk     ",
  "    kOOOOk      ",
  "     kOOk       ",
  "     kOOk       ",
  "     kOOkk      ",
  "     kOOOk      ",
  "     kOOkk      ",
  "     kOOOk      ",
  "     kkkk       ",
  "                ",
];

/** A wire globe — explorer links and the RPC. */
export const globe: IconMap = [
  "                ",
  "     kkkkkk     ",
  "   kkccccccck   ",
  "  kccwwwwwccck  ",
  " kcwwcccccwwcck ",
  " kcccccccccccck ",
  "kwwwwwwwwwwwwwwk",
  "kcccccccccccccck",
  "kwwwwwwwwwwwwwwk",
  " kcccccccccccck ",
  " kcwwcccccwwcck ",
  "  kccwwwwwccck  ",
  "   kkccccccck   ",
  "     kkkkkk     ",
  "                ",
  "                ",
];

/** The hourglass — anything still reading. */
export const hourglass: IconMap = [
  "                ",
  "  kkkkkkkkkkkk  ",
  "  kwwwwwwwwwwk  ",
  "  kkyyyyyyyykk  ",
  "   kkyyyyyykk   ",
  "    kkyyyykk    ",
  "     kkyykk     ",
  "      kkkk      ",
  "      kkkk      ",
  "     kkyykk     ",
  "    kkyyyykk    ",
  "   kkyyyyyykk   ",
  "  kkyyyyyyyykk  ",
  "  kwwwwwwwwwwk  ",
  "  kkkkkkkkkkkk  ",
  "                ",
];

/** The bin. Here it means burned supply, which is a real thing on this chain. */
export const recycle: IconMap = [
  "                ",
  "    kkkkkkkk    ",
  "  kkkkkkkkkkkk  ",
  "  klllllllllk   ",
  "   klllllllk    ",
  "   klNlNlNlk    ",
  "   klNlNlNlk    ",
  "   klNlNlNlk    ",
  "   klNlNlNlk    ",
  "   klNlNlNlk    ",
  "   klNlNlNlk    ",
  "   klllllllk    ",
  "    kkkkkkk     ",
  "                ",
  "                ",
  "                ",
];

/** A drive bay — the reserve as storage. */
export const harddrive: IconMap = [
  "                ",
  "                ",
  " kkkkkkkkkkkkkk ",
  " kllllllllllllk ",
  " klwwwwwwwwwwlk ",
  " klwggggggggwlk ",
  " klwgggggggwwlk ",
  " klwwwwwwwwwwlk ",
  " kllllllllllllk ",
  " klNlllllllRllk ",
  " kllllllllllllk ",
  " kkkkkkkkkkkkkk ",
  "                ",
  "                ",
  "                ",
  "                ",
];


/** The no-internet runner. Only ever seen when something is broken. */
export const dino: IconMap = [
  "                ",
  "        kkkkkk  ",
  "        kwkkkk  ",
  "        kkkkkk  ",
  "        kkkkk   ",
  " k      kkkk    ",
  " kk   kkkkkkk   ",
  " kkk kkkkkkk    ",
  " kkkkkkkkkk     ",
  "  kkkkkkkkk     ",
  "   kkkkkkk      ",
  "    kk  kk      ",
  "    k    k      ",
  "    kk   kk     ",
  "                ",
  "                ",
];

/** Trust me. */
export const dolphin: IconMap = [
  "                ",
  "      kkkk      ",
  "    kkccccck    ",
  "   kcccccccck   ",
  "  kccwkcccccck  ",
  " kcccccccccccck ",
  "kccccccccccccckk",
  "kcccccccccccckk ",
  " kkcccccccccck  ",
  "   kkcccccckk   ",
  "  kk kkccckk    ",
  " kk    kkkk     ",
  "kk       kk     ",
  "          kk    ",
  "                ",
  "                ",
];

/** A launchpad we did not build. */
export const rocket: IconMap = [
  "                ",
  "       kk       ",
  "      kwwk      ",
  "      kwwk      ",
  "     kwrrwk     ",
  "     kwrrwk     ",
  "    kwwrrwwk    ",
  "    kwwrrwwk    ",
  "   kkwwrrwwkk   ",
  "   kkwwrrwwkk   ",
  "  kk kwwwwk kk  ",
  "  k  kwrrwk  k  ",
  "     kkrrkk     ",
  "      kRRk      ",
  "       kk       ",
  "                ",
];

export const ICONS = {
  computer, coins, chart, lock, tie, flame, help, info, warning, error, network, folder,
  floppy, key, globe, hourglass, recycle, harddrive, dino, dolphin, rocket,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Render a pixel map as SVG.
 *
 * Adjacent same-colour pixels in a row are merged into one `<rect>`, which
 * roughly halves the node count for these icons and keeps the DOM cheap when a
 * dozen of them sit on the desktop at once.
 */
export function PixelIcon({
  name, size = 16, className, title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  const map = ICONS[name];
  const rects: React.ReactElement[] = [];

  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === " " || !PALETTE[ch]) { x++; continue; }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      rects.push(
        <rect key={`${x}-${y}`} x={x} y={y} width={run} height={1} fill={PALETTE[ch]} />
      );
      x += run;
    }
  });

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {rects}
    </svg>
  );
}

// Dev-time guard: a mis-typed row is invisible until an icon renders skewed.
if (import.meta.env?.DEV) {
  for (const [name, map] of Object.entries(ICONS)) {
    if (map.length !== 16) console.warn(`[pixel] ${name}: ${map.length} rows, expected 16`);
    map.forEach((row, i) => {
      if (row.length !== 16) console.warn(`[pixel] ${name} row ${i}: ${row.length} chars, expected 16`);
    });
  }
}
