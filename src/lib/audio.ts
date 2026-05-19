// Self-hosted alarm + notification sounds via the Web Audio API.
// v1 fetched MP3s from assets.mixkit.co on every alarm — external CDN, no SRI,
// referer leakage, and a single point of failure for ops alerts. See S-17.

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedCtx) {
    const Ctx = (window.AudioContext as typeof AudioContext) ||
      ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!Ctx) return null;
    sharedCtx = new Ctx();
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

function beep(durationMs: number, frequency: number, volume: number): void {
  const ctx = getCtx();
  if (!ctx) return;

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
