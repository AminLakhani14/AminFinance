import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'border border-white/15 bg-gradient-to-r from-accent to-violet-500 text-accent-fg shadow-[0_8px_28px_-10px_var(--accent)] hover:brightness-110',
  secondary:
    'bg-surface-raised/80 text-text border border-border backdrop-blur hover:border-accent/45 hover:bg-surface-raised',
  ghost: 'text-text-muted hover:bg-surface-raised hover:text-text',
  danger: 'bg-negative text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
};

/**
 * Forwards its ref so callers can focus a button imperatively — which modals
 * need on open, to be keyboard-operable the way a native dialog was.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium',
        'transition-all duration-200 active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
