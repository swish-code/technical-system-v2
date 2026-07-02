// Self-hosted alarm + notification sounds via the Web Audio API.
// v1 fetched MP3s from assets.mixkit.co on every alarm — external CDN, no SRI,
// referer leakage, and a single point of failure for ops alerts. See S-17.

let sharedCtx: AudioContext | null = null;

function createCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedCtx) {
    const Ctx = (window.AudioContext as typeof AudioContext) ||
      ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return null;
    sharedCtx = new Ctx();
  }
  return sharedCtx;
}

function getCtx(): AudioContext | null {
  const ctx = createCtx();
  if (!ctx) return null;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

// Browsers start an AudioContext "suspended" until it's resumed during a real
// user gesture (click/tap/key). Because our beeps only fire from incoming
// WebSocket notifications — never from a user action — the context would stay
// suspended and every alert would be silent. unlockAudio() is wired to the
// first user interaction (see main.tsx) to create + resume the context while a
// gesture is active, so all later notification sounds actually play. Idempotent.
export function unlockAudio(): void {
  const ctx = createCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
}

function emit(ctx: AudioContext, durationMs: number, frequency: number, volume: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.value = volume;

  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  osc.start(now);
  // Short attack/release envelope to avoid clicks.
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.01);
  gain.gain.setValueAtTime(volume, now + durationMs / 1000 - 0.02);
  gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
  osc.stop(now + durationMs / 1000);
}

function beep(durationMs: number, frequency: number, volume: number): void {
  const ctx = getCtx();
  if (!ctx) return;

  // If the context is still resuming, scheduling against its (frozen) clock
  // drops the sound. Wait for resume to settle, then emit.
  if (ctx.state === "suspended") {
    ctx.resume().then(() => emit(ctx, durationMs, frequency, volume)).catch(() => {});
    return;
  }
  emit(ctx, durationMs, frequency, volume);
}

/** One-shot notification chime (two quick beeps). Use for incoming notifications. */
export function playNotificationBeep(): void {
  beep(120, 880, 0.15);
  setTimeout(() => beep(180, 1175, 0.15), 130);
}

/** Looping urgent alarm. Returns a stop() to cancel. Use for timer expiry. */
export function createLoopingAlarm(): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const fire = () => {
    beep(220, 880, 0.22);
    setTimeout(() => beep(220, 660, 0.22), 250);
  };

  return {
    start() {
      if (timer) return;
      fire();
      timer = setInterval(fire, 1500);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
