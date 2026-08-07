import { useEffect, useRef, useState } from "react";

function ease(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

/** Animated circular score gauge. Re-animates from 0 whenever `score` changes (e.g. on re-sort/filter, since cards remount by key). */
export default function ScoreRing({
  score,
  size = 64,
  strokeWidth = 5,
  fontSize = 19,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  fontSize?: number;
}) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    const t0 = performance.now();
    const dur = 600;
    cancelAnimationFrame(raf.current);
    setProgress(0);
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      setProgress(p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [score]);

  const animScore = Math.round(score * ease(progress));
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, animScore / 100));
  const color = score >= 75 ? "#cdae6d" : score >= 50 ? "#9a9182" : "#5f5c52";

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          style={{ transition: "stroke-dashoffset .6s cubic-bezier(.22,1,.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif font-semibold leading-none text-foreground" style={{ fontSize }}>
          {animScore}
        </span>
      </div>
    </div>
  );
}
