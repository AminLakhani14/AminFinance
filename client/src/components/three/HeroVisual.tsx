/**
 * Gate around the 3D hero.
 *
 * Three conditions must all hold before three.js is even fetched: the user
 * hasn't disabled it, the OS isn't asking for reduced motion, and WebGL exists.
 * Otherwise this renders a CSS-only gradient that carries the same up/down cue
 * at zero cost.
 */
import { Suspense, lazy, useMemo } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useAppSelector } from '@/app/hooks';
import { cn } from '@/lib/utils';

const PortfolioScene = lazy(() => import('./PortfolioScene'));

function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

interface HeroVisualProps {
  changePercent: number;
  className?: string;
}

export function HeroVisual({ changePercent, className }: HeroVisualProps) {
  const enable3D = useAppSelector((s) => s.settings.enable3D);
  const reduceMotion = useReducedMotion();
  const webgl = useMemo(hasWebGL, []);

  const show3D = enable3D && !reduceMotion && webgl;

  return (
    <div className={cn('relative overflow-hidden rounded-card', className)}>
      {show3D ? (
        <Suspense fallback={<StaticBackdrop changePercent={changePercent} />}>
          <PortfolioScene changePercent={changePercent} />
        </Suspense>
      ) : (
        <StaticBackdrop changePercent={changePercent} />
      )}
    </div>
  );
}

/** Zero-JS fallback with the same directional cue. */
function StaticBackdrop({ changePercent }: { changePercent: number }) {
  const up = changePercent >= 0;
  return (
    <div
      className="h-40 w-full"
      style={{
        background: up
          ? 'radial-gradient(ellipse at 50% 120%, color-mix(in oklab, var(--positive) 22%, transparent), transparent 70%)'
          : 'radial-gradient(ellipse at 50% 120%, color-mix(in oklab, var(--negative) 22%, transparent), transparent 70%)',
      }}
      aria-hidden="true"
    />
  );
}
