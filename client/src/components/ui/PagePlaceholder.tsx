import type { LucideIcon } from 'lucide-react';
import { Card, CardBody } from './Card';

/**
 * Honest placeholder for routes whose feature lands in a later phase.
 *
 * States which phase builds it rather than showing a fake empty state — a
 * dashboard that looks broken and a dashboard that isn't built yet should not
 * be indistinguishable.
 */
export function PagePlaceholder({
  icon: Icon,
  title,
  phase,
  description,
  features,
}: {
  icon: LucideIcon;
  title: string;
  phase: string;
  description: string;
  features: string[];
}) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-4 py-16 text-center">
        <div className="rounded-2xl border border-border bg-surface-raised p-3">
          <Icon className="size-6 text-accent" strokeWidth={1.75} />
        </div>

        <div className="max-w-md">
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-text">{title}</h2>
            <span className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-text-muted">
              {phase}
            </span>
          </div>
          <p className="mt-2 text-sm text-text-muted">{description}</p>
        </div>

        <ul className="mt-2 grid gap-1.5 text-left text-sm text-text-subtle">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2">
              <span className="size-1 rounded-full bg-text-subtle" aria-hidden />
              {feature}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
