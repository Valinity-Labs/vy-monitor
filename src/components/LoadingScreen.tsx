import { useEffect, useRef, useState } from 'react';
// Inlined into the bundle, not fetched: as separate files they arrived a moment after the cover
// painted, so it first showed bare blocks and text — the old loader — before Ethereum popped in.
import ethMetal from '../assets/eth-metal.webp?inline';
import vPoster from '../assets/v-poster.webp?inline';
import { tr } from '../utils/i18n';

/**
 * The loading scene for the part of the monitor that is still arriving.
 *
 * `inline` is how the page uses it: it sits in the flow under the price chart, holding the space
 * the balance sheet will take, because the chart and the tape draw from the bundle immediately
 * and have no reason to wait behind a cover for the ~15s of RPC round trips below them. Without
 * `inline` it is the full-screen cover it used to be, and locks scrolling while it shows.
 *
 * The centrepiece is the website's metallic Ethereum, floating, with the website's small 3D
 * Valinity V (the same Three.js scene as valinity.io) spinning as it orbits it. Until the 3D scene
 * is ready — or where WebGL is unavailable — the website's still render of the V orbits instead;
 * nothing flat ever spins. The clock counts from navigation (performance.now()), so it includes the
 * time before this component mounted.
 */

const ORBIT_MS = 3600;
const TILT = (-14 * Math.PI) / 180;
const TILT_COS = Math.cos(TILT);
const TILT_SIN = Math.sin(TILT);
const FLOAT_MS = 4200;

export function LoadingScreen({ done = false, inline = false }: { done?: boolean; inline?: boolean }) {
  const [seconds, setSeconds] = useState(() => performance.now() / 1000);
  const [gone, setGone] = useState(false);
  const [webgl, setWebgl] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ethRef = useRef<HTMLImageElement>(null);
  const orbiterRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setSeconds(performance.now() / 1000), 100);
    return () => clearInterval(t);
  }, [done]);

  // The page behind must not scroll while it is covered. In flow it covers nothing, so it must
  // not touch scrolling at all.
  useEffect(() => {
    if (gone || inline) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [gone, inline]);

  // Removed after the fade, so it never sits invisibly on top of the page.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(t);
  }, [done]);

  // One animation loop drives the floating Ethereum, the V's spin and its orbit.
  useEffect(() => {
    if (gone) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scene: { render: (ms: number) => void; dispose: () => void } | null = null;
    let frame = 0;
    let stopped = false;

    const orbit = (ms: number) => {
      const eth = ethRef.current;
      const v = orbiterRef.current;
      const size = stageRef.current?.clientWidth ?? 0;
      if (!eth || !v || !size) return;
      // Ethereum drifts slowly up and down in the middle.
      const float = still ? 0 : Math.sin((ms / FLOAT_MS) * Math.PI * 2) * size * 0.035;
      eth.style.transform = `translate(-50%, -50%) translateY(${float}px)`;
      // The V rides a tilted ellipse: the lower half passes in front of Ethereum, the upper behind.
      const theta = still ? 0.3 * Math.PI : (ms / ORBIT_MS) * Math.PI * 2;
      const front = Math.sin(theta);
      const ex = Math.cos(theta) * size * 0.45;
      const ey = front * size * 0.12;
      const x = ex * TILT_COS - ey * TILT_SIN;
      const y = ex * TILT_SIN + ey * TILT_COS + float * 0.4;
      const near = (front + 1) / 2;
      v.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${0.7 + 0.3 * near})`;
      v.style.zIndex = front > 0 ? '3' : '1';
      v.style.filter = `brightness(${0.72 + 0.28 * near}) drop-shadow(0 0 0.7rem rgba(214, 170, 90, ${0.15 + 0.3 * near}))`;
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
      .catch(() => { /* the website's still V keeps orbiting */ });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      scene?.dispose();
    };
  }, [gone]);

  if (gone) return null;

  return (
    <div className={`vy-loader${inline ? ' vy-loader--inline' : ''}${done ? ' vy-loader--done' : ''}`} role="status" aria-live="polite" aria-busy={!done}>
      <div className="vy-loader__inner">
        <div ref={stageRef} className="vy-loader__stage" aria-hidden="true">
          <img ref={ethRef} className="vy-loader__eth" src={ethMetal} alt="" draggable={false} />
          <div ref={orbiterRef} className="vy-loader__orbiter">
            <canvas ref={canvasRef} className={`vy-loader__v${webgl ? ' vy-loader__v--on' : ''}`} />
            <img className={`vy-loader__v-still${webgl ? ' vy-loader__v-still--off' : ''}`} src={vPoster} alt="" draggable={false} />
          </div>
        </div>
        <div className="vy-loader__blocks" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 0.14}s` }} />)}
        </div>
        <div className="vy-loader__title">{tr('Loading data directly from the Ethereum blockchain', 'Cargando datos directamente desde la blockchain de Ethereum')}</div>
        <div className="vy-loader__clock">{seconds.toFixed(1)}s</div>
        {seconds >= 12 && (
          <div className="vy-loader__slow">{tr('The blockchain connection is slower than usual — still working on it.', 'La conexión con la blockchain está más lenta de lo normal — seguimos trabajando en ello.')}</div>
        )}
      </div>
    </div>
  );
}
