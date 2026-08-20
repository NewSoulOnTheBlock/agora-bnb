/**
 * System sounds, synthesised.
 *
 * The obvious route was to download Microsoft's WAVs from guidebookgallery and
 * bundle them. Three reasons this generates them instead:
 *
 *   1. **Licensing.** Those files are Microsoft's. Shipping them inside a live
 *      financial app is a question nobody needs to answer.
 *   2. **Weight.** The real set is ~400 kB of WAV for sounds that play for
 *      200 ms. This module is under 3 kB and adds nothing to the network.
 *   3. **Control.** Synthesised tones can be pitched to taste and never need a
 *      loading state — the first `ding` is instant.
 *
 * If you would rather have the originals, `winme/chord.wav`, `winme/ding.wav`
 * and `winme/start.wav` on guidebookgallery are the same sound family Windows
 * 98 shipped; drop them in `public/` and swap `play()` for an `<audio>` call.
 *
 * **On by default**, but silent until the first interaction — the browser will
 * not start an AudioContext without a user gesture, so nothing can ambush
 * someone who merely has the tab open. The tray speaker turns it off, and the
 * choice persists.
 */

type Voice = "ding" | "chord" | "error" | "click" | "open" | "close" | "startup";

const KEY = "torii98:sound";

let ctx: AudioContext | null = null;
let enabled = read();

/**
 * On unless explicitly switched off.
 *
 * Nothing actually plays until the first click regardless: browsers refuse to
 * start an AudioContext outside a user gesture, so a page left open in a
 * background tab stays silent. The tray speaker turns it off for good.
 */
function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode — the toggle still works for this session */
  }
  if (on) play("ding");
}

/**
 * Browsers refuse to start an AudioContext outside a user gesture, so it is
 * created lazily on the first `play()` — which, because sound is opt-in, is
 * always downstream of a click.
 */
function audio(): AudioContext | null {
  if (ctx) return ctx;
  const AC =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/** One enveloped oscillator. `at` is an offset in seconds from now. */
function tone(
  c: AudioContext,
  opts: {
    freq: number;
    at?: number;
    dur?: number;
    type?: OscillatorType;
    gain?: number;
    /** Glide to this frequency across the note. */
    to?: number;
  }
) {
  const { freq, at = 0, dur = 0.18, type = "sine", gain = 0.18, to } = opts;
  const t0 = c.currentTime + at;

  const osc = c.createOscillator();
  const amp = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);

  // A short attack keeps it from clicking; exponential release is what makes
  // it read as a struck bell rather than a beep.
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(amp).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Filtered noise burst — the mechanical part of a click. */
function noise(c: AudioContext, { at = 0, dur = 0.03, gain = 0.06 } = {}) {
  const t0 = c.currentTime + at;
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }

  const src = c.createBufferSource();
  src.buffer = buf;

  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800;

  const amp = c.createGain();
  amp.gain.value = gain;

  src.connect(hp).connect(amp).connect(c.destination);
  src.start(t0);
}

export function play(voice: Voice) {
  if (!enabled) return;
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") void c.resume();

  switch (voice) {
    // The two-partial bell that fires on any acknowledgement.
    case "ding":
      tone(c, { freq: 987.77, dur: 0.22, gain: 0.16 });          // B5
      tone(c, { freq: 1975.53, dur: 0.16, gain: 0.05 });         // octave shimmer
      break;

    // A major triad rolled upward — used when a transaction confirms.
    case "chord":
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(c, { freq: f, at: i * 0.055, dur: 0.5, gain: 0.11 })
      );
      break;

    // Two blunt low square blips. Deliberately unpleasant.
    case "error":
      tone(c, { freq: 220, dur: 0.13, type: "square", gain: 0.1 });
      tone(c, { freq: 175, at: 0.16, dur: 0.18, type: "square", gain: 0.1 });
      break;

    case "click":
      noise(c, { dur: 0.025, gain: 0.05 });
      break;

    // Rising sweep for a window appearing, falling for one going away.
    case "open":
      tone(c, { freq: 440, to: 1200, dur: 0.1, type: "triangle", gain: 0.07 });
      break;

    case "close":
      tone(c, { freq: 1200, to: 380, dur: 0.12, type: "triangle", gain: 0.07 });
      break;

    // The long one: a slow pad that resolves, for the boot splash.
    case "startup":
      [261.63, 392.0, 523.25, 659.25, 783.99].forEach((f, i) =>
        tone(c, { freq: f, at: i * 0.12, dur: 1.5 - i * 0.12, gain: 0.09, type: "sine" })
      );
      tone(c, { freq: 1046.5, at: 0.62, dur: 1.1, gain: 0.05 });
      break;
  }
}
