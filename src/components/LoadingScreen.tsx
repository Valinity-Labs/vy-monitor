import { useEffect, useState } from 'react';

/**
 * The full-screen cover the page opens behind. Everything mounts and loads underneath it, so when
 * it lifts the chart is already drawn and the balance sheet already filled — the page appears at
 * once instead of piece by piece.
 *
 * The clock counts from navigation (performance.now()), not from this component's mount, so it
 * keeps running across the code-split handoff from App's Suspense fallback to Mainnet.
 */
export function LoadingScreen({ done = false }: { done?: boolean }) {
  const [seconds, setSeconds] = useState(() => performance.now() / 1000);
  const [gone, setGone] = useState(false);

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

  if (gone) return null;

  return (
    <div className={`vy-loader${done ? ' vy-loader--done' : ''}`} role="status" aria-live="polite" aria-busy={!done}>
      <div className="vy-loader__inner">
        <svg className="vy-loader__eth" viewBox="0 0 256 417" aria-hidden="true">
          <path d="M127.9 0 125 9.5v275.7l2.9 2.9 127.9-75.6z" />
          <path d="M127.9 0 0 212.5l127.9 75.6V154.3z" />
          <path d="m127.9 312.2-1.6 1.9v98.2l1.6 4.7L256 236.6z" />
          <path d="M127.9 416.9V312.2L0 236.6z" />
        </svg>
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
