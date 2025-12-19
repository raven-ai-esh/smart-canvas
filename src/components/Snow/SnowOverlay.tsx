import { useEffect, useRef } from 'react';
import { useStore } from '../../store/useStore';

type ThemeMode = 'dark' | 'light';

type Flake = {
  wx: number; // world
  wy: number; // world
  r: number; // screen px
  vy: number; // screen px/sec
  vx: number; // screen px/sec
  wobble: number;
  wobbleSpeed: number; // rad/sec
  rot: number; // rad
  vr: number; // rad/sec
  a: number; // 0..1
};

export function SnowOverlay({ enabled, theme }: { enabled: boolean; theme: ThemeMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const flakesRef = useRef<Flake[]>([]);
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const targetCountRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const updateTargetCount = () => {
      const base = theme === 'dark' ? 80 : 60;
      if (typeof window === 'undefined') {
        targetCountRef.current = base;
        return;
      }
      const isSmall = window.matchMedia?.('(max-width: 520px)')?.matches ?? window.innerWidth <= 520;
      targetCountRef.current = isSmall ? Math.floor(base * 0.6) : base;
    };

    const resize = () => {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const w = window.innerWidth;
      const h = window.innerHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      updateTargetCount();
    };

    const ensureFlakes = () => {
      const { w, h } = sizeRef.current;
      const targetCount = targetCountRef.current || (theme === 'dark' ? 80 : 60);
      const c = useStore.getState().canvas;
      const scale = Math.max(0.0001, Number.isFinite(c.scale) ? c.scale : 1);
      const worldLeft = -(Number.isFinite(c.x) ? c.x : 0) / scale;
      const worldTop = -(Number.isFinite(c.y) ? c.y : 0) / scale;
      const worldW = w / scale;
      const worldH = h / scale;

      const arr = flakesRef.current;
      while (arr.length < targetCount) {
        const r = 0.6 + Math.random() * 1.4;
        arr.push({
          wx: worldLeft + Math.random() * worldW,
          wy: worldTop + Math.random() * worldH,
          r,
          vy: 14 + Math.random() * 30 + r * 5,
          vx: (-12 + Math.random() * 24) * (0.25 + r * 0.06),
          wobble: Math.random() * Math.PI * 2,
          wobbleSpeed: 0.8 + Math.random() * 1.4,
          rot: Math.random() * Math.PI * 2,
          vr: (-1 + Math.random() * 2) * (0.5 + Math.random() * 1.2),
          a: 0.62 + Math.random() * 0.38,
        });
      }
      if (arr.length > targetCount) arr.splice(targetCount);
    };

    resize();
    ensureFlakes();

    let lastT = performance.now();
    const tick = (t: number) => {
      const dtMs = Math.min(40, t - lastT);
      lastT = t;
      const dt = dtMs / 1000;

      const { w, h } = sizeRef.current;
      const c = useStore.getState().canvas;
      const scale = Math.max(0.0001, Number.isFinite(c.scale) ? c.scale : 1);
      const cx = Number.isFinite(c.x) ? c.x : 0;
      const cy = Number.isFinite(c.y) ? c.y : 0;
      const worldLeft = -cx / scale;
      const worldTop = -cy / scale;
      const worldW = w / scale;
      const worldH = h / scale;
      ensureFlakes();

      ctx.clearRect(0, 0, w, h);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (theme === 'dark') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.16)';
        ctx.shadowBlur = 4;
      } else {
        ctx.strokeStyle = 'rgba(46, 52, 64, 0.55)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.08)';
        ctx.shadowBlur = 3;
      }

      const wind = theme === 'dark' ? 5 : 3.5; // px/sec
      for (const f of flakesRef.current) {
        f.wobble += f.wobbleSpeed * dt;
        const wob = Math.sin(f.wobble) * (10 + f.r * 3); // px/sec

        // Keep the snow tied to world space, but preserve the same visual (screen) speed across zoom levels.
        f.wx += ((f.vx + wind + wob) * dt) / scale;
        f.wy += (f.vy * dt) / scale;
        f.rot += f.vr * dt;

        const marginWorld = 40 / scale;
        if (f.wy > worldTop + worldH + marginWorld) {
          f.wy = worldTop - marginWorld - (Math.random() * 160) / scale;
          f.wx = worldLeft + Math.random() * worldW;
        }
        if (f.wx < worldLeft - marginWorld) f.wx = worldLeft + worldW + marginWorld;
        if (f.wx > worldLeft + worldW + marginWorld) f.wx = worldLeft - marginWorld;

        const armLen = 1.5 + f.r * 1.35;
        const branchAt = armLen * 0.62;
        const branchLen = armLen * 0.28;

        const sx = cx + f.wx * scale;
        const sy = cy + f.wy * scale;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(f.rot);
        ctx.globalAlpha = f.a;
        ctx.lineWidth = Math.max(0.65, f.r * 0.3);

        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k * Math.PI) / 3;
          const ax = Math.cos(a);
          const ay = Math.sin(a);

          ctx.moveTo(0, 0);
          ctx.lineTo(ax * armLen, ay * armLen);

          const bx1 = Math.cos(a + Math.PI / 6);
          const by1 = Math.sin(a + Math.PI / 6);
          const bx2 = Math.cos(a - Math.PI / 6);
          const by2 = Math.sin(a - Math.PI / 6);
          const px = ax * branchAt;
          const py = ay * branchAt;
          ctx.moveTo(px, py);
          ctx.lineTo(px + bx1 * branchLen, py + by1 * branchLen);
          ctx.moveTo(px, py);
          ctx.lineTo(px + bx2 * branchLen, py + by2 * branchLen);
        }
        ctx.stroke();
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('orientationchange', resize, { passive: true });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      ctx.clearRect(0, 0, sizeRef.current.w, sizeRef.current.h);
      flakesRef.current = [];
    };
  }, [enabled, theme]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 1400,
        pointerEvents: 'none',
        opacity: 0.88,
      }}
    />
  );
}
