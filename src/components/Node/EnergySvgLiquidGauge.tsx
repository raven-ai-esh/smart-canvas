import React from 'react';
import { clampEnergy, energyToColor } from '../../utils/energy';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function buildWavePath(args: {
  left: number;
  top: number;
  width: number;
  sampleY: (x: number, i: number) => number;
}) {
  const { left, top, width, sampleY } = args;
  const points = 16;
  const step = width / points;

  const ys = new Array(points + 1).fill(0).map((_, i) => {
    const x = i * step;
    const y = top + sampleY(x, i);
    return { x: left + x, y };
  });

  // Smooth-ish quadratic chain.
  let d = `M ${ys[0].x} ${ys[0].y}`;
  for (let i = 1; i < ys.length - 1; i++) {
    const p0 = ys[i];
    const p1 = ys[i + 1];
    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    d += ` Q ${p0.x} ${p0.y} ${cx} ${cy}`;
  }
  const last = ys[ys.length - 1];
  d += ` T ${last.x} ${last.y}`;
  return d;
}

export function EnergySvgLiquidGauge({
  level,
  className,
}: {
  level: number; // 0..100
  className?: string;
}) {
  // We render only the liquid inside the already-styled container.
  // The parent `.noteEnergyScale` already has border-radius + overflow hidden.
  const vbW = 100;
  const vbH = 100;
  const inset = 2;
  const innerX = inset;
  const innerY = inset;
  const innerW = vbW - inset * 2;
  const innerH = vbH - inset * 2;

  const value = clampEnergy(level);
  const targetP = clamp01(value / 100);

  const animRef = React.useRef({
    p: targetP,
    v: 0,
    target: targetP,
    lastT: 0,
    phase: 0,
    ampKick: 0,
    prevTarget: targetP,
    bubbles: [] as Array<{
      id: string;
      x: number;
      y: number;
      r: number;
      vy: number;
      drift: number;
      wobblePhase: number;
    }>,
    nextBubbleAt: 0,
    noiseA: Array.from({ length: 17 }, () => (Math.random() * 2 - 1) * 0.55),
    noiseB: Array.from({ length: 17 }, () => (Math.random() * 2 - 1) * 0.55),
    noiseMix: 0,
    cycles2A: 2.4,
    cycles2B: 2.4,
    cyclesMix: 0,
  });

  const [, forceTick] = React.useReducer((x) => (x + 1) | 0, 0);

  React.useEffect(() => {
    const a = animRef.current;
    if (a.target !== targetP) {
      const dp = Math.abs(targetP - a.target);
      a.prevTarget = a.target;
      a.target = targetP;

      // Splash: kick wave amplitude based on jump size.
      a.ampKick = Math.min(10, a.ampKick + dp * 60);

      // Morph wave shape (not only stretch): blend into a new random noise profile + slightly different frequency.
      const currentNoise = new Array(a.noiseA.length).fill(0).map((_, i) => {
        const na = a.noiseA[i] ?? 0;
        const nb = a.noiseB[i] ?? 0;
        return na * (1 - a.noiseMix) + nb * a.noiseMix;
      });
      a.noiseA = currentNoise;
      a.noiseB = Array.from({ length: a.noiseA.length }, () => (Math.random() * 2 - 1) * 0.55);
      a.noiseMix = 1;

      const currentCycles2 = a.cycles2A * (1 - a.cyclesMix) + a.cycles2B * a.cyclesMix;
      a.cycles2A = currentCycles2;
      a.cycles2B = 2.0 + Math.random() * 1.2;
      a.cyclesMix = 1;
    }
  }, [targetP]);

  React.useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const a = animRef.current;
      const dt = Math.min(1 / 30, Math.max(1 / 120, (t - (a.lastT || t)) / 1000));
      a.lastT = t;

      // Spring for fill level (slight overshoot for big changes).
      const dp = Math.abs(a.target - a.p);
      const bigJump = Math.abs(a.target - a.prevTarget) > 0.14;
      const stiffness = bigJump ? 320 : 240;
      const damping = bigJump ? 18 : 22;

      const x = a.p - a.target;
      const accel = -stiffness * x - damping * a.v;
      a.v += accel * dt;
      a.p += a.v * dt;

      // Prevent crazy runaway; allow a little overshoot.
      a.p = Math.max(-0.06, Math.min(1.06, a.p));
      if (dp < 0.0008 && Math.abs(a.v) < 0.002) {
        a.p = a.target;
        a.v = 0;
      }

      // Phase and splash decay.
      a.phase += dt * 2.0;
      a.ampKick *= Math.pow(0.02, dt); // fast decay (~0.02 per second)
      a.noiseMix *= Math.pow(0.02, dt);
      a.cyclesMix *= Math.pow(0.02, dt);

      // Update bubbles (spawn rarely, float up, disappear near surface).
      const pNow = Math.max(-0.03, Math.min(1.03, a.p));
      const surfaceNowY = innerY + innerH * (1 - pNow);
      const bottomNowY = innerY + innerH;

      // Spawn only when there is enough liquid.
      if (pNow > 0.12 && t >= a.nextBubbleAt && a.bubbles.length < 10) {
        const x = innerX + 6 + Math.random() * (innerW - 12);
        const y = surfaceNowY + 8 + Math.random() * Math.max(6, bottomNowY - surfaceNowY - 18);
        const r = 0.8 + Math.random() * 1.8;
        const vy = 7 + Math.random() * 12; // viewBox units per second
        const drift = (Math.random() * 2 - 1) * 4;
        a.bubbles.push({
          id: `${t.toFixed(0)}_${Math.random().toString(16).slice(2)}`,
          x,
          y,
          r,
          vy,
          drift,
          wobblePhase: Math.random() * Math.PI * 2,
        });
        a.nextBubbleAt = t + 700 + Math.random() * 2400;
      }

      const timeS = t / 1000;
      a.bubbles = a.bubbles
        .map((b) => {
          const wobble = Math.sin(timeS * 1.2 + b.wobblePhase) * 0.35;
          return {
            ...b,
            y: b.y - b.vy * dt,
            x: b.x + (b.drift * dt + wobble * dt * 10),
          };
        })
        .filter((b) => b.y > surfaceNowY - 6 && b.y < bottomNowY + 10);

      forceTick();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const a = animRef.current;
  // Allow slight overshoot to be visible (parent clips it anyway).
  const pVis = Math.max(-0.03, Math.min(1.03, a.p));
  const surfaceY = innerY + innerH * (1 - pVis);

  // Smaller, more varied waves: combine a couple of small sine components + stable per-point noise.
  const baseAmp = 0.32 + (1 - Math.abs(0.5 - clamp01(pVis)) * 2) * 0.18;
  const amp = baseAmp + a.ampKick * 0.35;
  const cycles1 = 1.15;
  const cycles2 = a.cycles2A * (1 - a.cyclesMix) + a.cycles2B * a.cyclesMix;
  const omega1 = (Math.PI * 2 * cycles1) / innerW;
  const omega2 = (Math.PI * 2 * cycles2) / innerW;
  const phase1 = a.phase * 1.0;
  const phase2 = a.phase * 1.65 + 1.2;

  const waveTop = buildWavePath({
    left: innerX,
    top: surfaceY,
    width: innerW,
    sampleY: (x, i) => {
      const na = a.noiseA[i] ?? 0;
      const nb = a.noiseB[i] ?? 0;
      const n = na * (1 - a.noiseMix) + nb * a.noiseMix;
      const y1 = Math.sin(phase1 + x * omega1) * amp;
      const y2 = Math.sin(phase2 + x * omega2) * (amp * 0.55);
      return y1 + y2 + n;
    },
  });

  const liquidColor = energyToColor(value);

  const defsId = React.useId().replace(/:/g, '_');
  const clipId = `energy_liquid_shape_${defsId}`;
  const liquidGradId = `energy_liquid_grad_${defsId}`;

  // Liquid shape: wave top + closed polygon down to the bottom.
  const bottomY = innerY + innerH + 2; // extend slightly so it always fully fills
  const rightX = innerX + innerW;
  const liquidPath = `${waveTop} L ${rightX} ${bottomY} L ${innerX} ${bottomY} Z`;

  return (
    <div
      className={className}
      style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${vbW} ${vbH}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <path d={liquidPath} />
          </clipPath>
          <linearGradient
            id={liquidGradId}
            x1="0"
            y1={innerY}
            x2="0"
            y2={innerY + innerH}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor={liquidColor} stopOpacity="0.92" />
            <stop offset="60%" stopColor={liquidColor} stopOpacity="0.98" />
            <stop offset="100%" stopColor={liquidColor} stopOpacity="0.78" />
          </linearGradient>
        </defs>

        {/* Liquid fill (deformed top surface). */}
        <path d={liquidPath} fill={`url(#${liquidGradId})`} />

        {/* Bubbles inside the liquid, clipped by the liquid shape */}
        <g clipPath={`url(#${clipId})`}>
          {a.bubbles.map((b) => {
            const fade = clamp01((b.y - surfaceY) / 10);
            return (
              <g key={b.id} opacity={0.22 + fade * 0.6}>
                <circle
                  cx={b.x}
                  cy={b.y}
                  r={b.r}
                  fill="rgba(255,255,255,0.34)"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth={0.6}
                />
                <circle cx={b.x - b.r * 0.25} cy={b.y - b.r * 0.25} r={b.r * 0.35} fill="rgba(255,255,255,0.42)" />
                <circle cx={b.x} cy={b.y} r={Math.max(0.4, b.r - 0.4)} fill="rgba(0,0,0,0.06)" opacity={0.25} />
              </g>
            );
          })}
        </g>

        {/* Subtle surface specular highlight (attached to the surface, not a separate “stripe”). */}
        <path d={waveTop} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1.2} strokeLinecap="round" />
      </svg>
    </div>
  );
}
