import { useReducedMotion } from 'framer-motion';

/**
 * Ambient space layer shared by every route.
 * Footage: Borys Zaitsev via Pexels (video 12275372).
 */
export function CosmicBackground() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="cosmic-background" aria-hidden="true">
      {!reduceMotion ? (
        <video
          className="cosmic-background__video"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          disablePictureInPicture
          tabIndex={-1}
        >
          <source src="/galaxy-stars.mp4" type="video/mp4" />
        </video>
      ) : null}
      <div className="cosmic-background__veil" />
      <div className="cosmic-background__aurora" />
      <div className="cosmic-background__grid" />
      <div className="cosmic-background__noise" />
    </div>
  );
}
