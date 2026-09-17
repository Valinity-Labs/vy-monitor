import { useEffect, useId, useRef, useState } from 'react';
import ethMetal from '../assets/eth-metal.webp';
import { GOLD_STOPS, VALINITY_FACETS } from '../utils/valinityMark';

/**
 * The full-screen cover the page opens behind. Everything mounts and loads underneath it, so when
 * it lifts the chart is already drawn and the balance sheet already filled — the page appears at
 * once instead of piece by piece.
 *
 * The centrepiece is the website's 3D Valinity V (Three.js, loaded in the background; a flat gold
 * V spins in its place until it is ready or if WebGL is unavailable) with the website's metallic
 * Ethereum orbiting it. The clock counts from navigation (performance.now()), so it includes the
 * time before this component mounted.
 */

const ORBIT_MS = 3600;
const TILT = (-14 * Math.PI) / 180;
const TILT_COS = Math.cos(TILT);
const TILT_SIN = Math.sin(TILT);
const facetPath = (polygon: [number, number][]) => 'M' + polygon.map(([x, y]) => `${x} ${y}`).join('L') + 'Z';

export function LoadingScreen({ done = false }: { done?: boolean }) {
  const [seconds, setSeconds] = useState(() => performance.now() / 1000);
  const [gone, setGone] = useState(false);
  const [webgl, setWebgl] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ethRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gradientId = useId();

  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setSeconds(performance.now() / 1000), 100);
    return () => clearInterval(t);
  }, [done]);

  // The page behind must not scroll while it is covered.
  useEffect(() => {
    if (gone) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [gone]);

  // Removed after the fade, so it never sits invisibly on top of the page.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(t);
  }, [done]);

  // One animation loop drives both the V and the Ethereum orbit.
  useEffect(() => {
    if (gone) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scene: { render: (ms: number) => void; dispose: () => void } | null = null;
    let frame = 0;
    let stopped = false;

    const orbit = (ms: number) => {
      const eth = ethRef.current;
      const size = stageRef.current?.clientWidth ?? 0;
      if (!eth || !size) return;
      // A tilted ellipse around the V: lower half passes in front, upper half behind.
      const theta = still ? 0.35 * Math.PI : (ms / ORBIT_MS) * Math.PI * 2;
      const front = Math.sin(theta);
      const ex = Math.cos(theta) * size * 0.46;
      const ey = front * size * 0.11;
      const x = ex * TILT_COS - ey * TILT_SIN;
      const y = ex * TILT_SIN + ey * TILT_COS;
      const scale = 0.72 + 0.28 * ((front + 1) / 2);
      const tilt = still ? 0 : Math.sin(ms / 900) * 28;
      eth.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale}) rotateY(${tilt}deg)`;
      eth.style.zIndex = front > 0 ? '3' : '1';
      eth.style.filter = `brightness(${0.7 + 0.3 * ((front + 1) / 2)}) drop-shadow(0 0 0.8rem rgba(231, 204, 134, ${0.1 + 0.25 * ((front + 1) / 2)}))`;
    };

    const tick = (now: number) => {
      if (stopped) return;
      scene?.render(now);
      orbit(now);
      if (!still) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    import('../utils/valinityMark3d')
      .then(({ createValinityMarkScene }) => {
        if (stopped || !canvasRef.current) return;
        scene = createValinityMarkScene(canvasRef.current);
        scene.render(performance.now());
        setWebgl(true);
      })
      .catch(() => { /* the flat gold V keeps spinning */ });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      scene?.dispose();
    };
  }, [gone]);

  if (gone) return null;

  return (
    <div className={`vy-loader${done ? ' vy-loader--done' : ''}`} role="status" aria-live="polite" aria-busy={!done}>
      <div className="vy-loader__inner">
        <div ref={stageRef} className="vy-loader__stage" aria-hidden="true">
          <canvas ref={canvasRef} className={`vy-loader__v${webgl ? ' vy-loader__v--on' : ''}`} />
          {!webgl && (
            <svg className="vy-loader__v-flat" viewBox="0 0 100 100">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
                  {GOLD_STOPS.map((c, i) => <stop key={i} offset={i / (GOLD_STOPS.length - 1)} stopColor={c} />)}
                </linearGradient>
              </defs>
              {VALINITY_FACETS.map((f, i) => <path key={i} d={facetPath(f)} fill={`url(#${gradientId})`} />)}
            </svg>
          )}
          <img ref={ethRef} className="vy-loader__eth" src={ethMetal} alt="" draggable={false} />
        </div>
        <div className="vy-loader__blocks" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 0.14}s` }} />)}
        </div>
        <div className="vy-loader__title">Loading data directly from the Ethereum blockchain</div>
        <div className="vy-loader__clock">{seconds.toFixed(1)}s</div>
        {seconds >= 12 && (
          <div className="vy-loader__slow">The blockchain connection is slower than usual — still working on it.</div>
        )}
      </div>
    </div>
  );
}
