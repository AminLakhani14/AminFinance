/**
 * Resolve a CSS custom property to an `rgb()` string.
 *
 * The design tokens are authored in `oklch()` for perceptually even lightness
 * steps, but third-party canvas/WebGL libraries parse only hex/rgb/hsl —
 * lightweight-charts throws `Failed to parse color: oklch(...)` and three.js's
 * THREE.Color silently falls back to white.
 *
 * Rather than maintaining a second hex copy of every token (which would drift),
 * this asks the browser to do the conversion: assign the value to a detached
 * element's `color` and read it back, which every engine normalizes to `rgb()`.
 */

const cache = new Map<string, string>();

export function resolveCssColor(varName: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;

  const cacheKey = `${varName}|${document.documentElement.className}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;

  // Already in a format the consumers understand.
  if (raw.startsWith('#') || raw.startsWith('rgb') || raw.startsWith('hsl')) {
    cache.set(cacheKey, raw);
    return raw;
  }

  try {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = raw;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();

    // A browser that can't parse the value leaves `color` at its initial value.
    if (!resolved || !resolved.startsWith('rgb')) return fallback;
    cache.set(cacheKey, resolved);
    return resolved;
  } catch {
    return fallback;
  }
}

/** Clear on theme change — resolved values differ between light and dark. */
export function clearColorCache(): void {
  cache.clear();
}

/** `rgb(a, b, c)` → `#rrggbb`, for consumers that insist on hex. */
export function rgbToHex(rgb: string): string {
  const match = rgb.match(/rgba?\(([^)]+)\)/);
  if (!match?.[1]) return rgb;
  const [r = 0, g = 0, b = 0] = match[1].split(',').map((p) => Number(p.trim()));
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
      .join('')
  );
}
