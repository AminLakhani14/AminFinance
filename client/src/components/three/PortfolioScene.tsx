/**
 * Dashboard hero — a particle field whose colour and motion are driven by the
 * portfolio's day change.
 *
 * This is the one place 3D earns its place: it encodes a real value (today's
 * direction and magnitude) rather than decorating. Everything about it is
 * defensive:
 *
 *   - lives in its own lazy chunk (three.js is ~600kb — never on the critical path)
 *   - `frameloop="demand"` plus an explicit invalidate loop, so it costs no GPU
 *     when nothing is moving
 *   - disabled entirely under `prefers-reduced-motion` or the Settings toggle
 *
 * The accessible reading is the stat tiles above it; this is atmosphere.
 */
import { useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { resolveCssColor } from '@/lib/cssColor';

interface PortfolioSceneProps {
  /** Today's move, percent. Drives colour and speed. */
  changePercent: number;
  height?: number;
}

const PARTICLE_COUNT = 900;

function ParticleField({ changePercent }: { changePercent: number }) {
  const pointsRef = useRef<THREE.Points>(null);
  const { invalidate } = useThree();

  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const speeds = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 8;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6;
      speeds[i] = 0.15 + Math.random() * 0.5;
    }
    return { positions, speeds };
  }, []);

  // Direction drives drift; magnitude drives speed, capped so a wild day
  // doesn't turn the hero into a strobe.
  const direction = changePercent >= 0 ? 1 : -1;
  const intensity = Math.min(Math.abs(changePercent) / 3, 1);

  const color = useMemo(() => {
    // Read the theme's own token, resolved to rgb() first — THREE.Color cannot
    // parse oklch() and silently yields white, which reads as a bug.
    const token = changePercent >= 0 ? '--positive' : '--negative';
    const fallback = changePercent >= 0 ? '#1baf7a' : '#e34948';
    try {
      return new THREE.Color(resolveCssColor(token, fallback));
    } catch {
      return new THREE.Color(fallback);
    }
  }, [changePercent]);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    if (!points) return;

    const array = points.geometry.attributes.position?.array as Float32Array | undefined;
    if (!array) return;

    const step = delta * (0.2 + intensity * 0.8) * direction;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      array[i * 3 + 1] = (array[i * 3 + 1] ?? 0) + step * (speeds[i] ?? 0.3);
      // Wrap so the field never empties.
      const y = array[i * 3 + 1] ?? 0;
      if (y > 4) array[i * 3 + 1] = -4;
      if (y < -4) array[i * 3 + 1] = 4;
    }
    const attr = points.geometry.attributes.position;
    if (attr) attr.needsUpdate = true;

    points.rotation.y += delta * 0.02;

    // frameloop="demand" means we must ask for the next frame explicitly.
    invalidate();
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.06}
        color={color}
        transparent
        opacity={0.55}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

export default function PortfolioScene({ changePercent, height = 160 }: PortfolioSceneProps) {
  return (
    <div style={{ height }} aria-hidden="true">
      <Canvas
        frameloop="demand"
        camera={{ position: [0, 0, 9], fov: 55 }}
        dpr={[1, 1.5]}
        gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      >
        <ParticleField changePercent={changePercent} />
      </Canvas>
    </div>
  );
}
