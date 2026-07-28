import { Link } from 'react-router-dom';
import { Card, CardBody } from '@/components/ui/Card';

export function NotFound() {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3 py-20 text-center">
        <span className="text-3xl font-semibold tracking-tight text-text-subtle nums">
          404
        </span>
        <p className="text-sm text-text-muted">That page doesn&apos;t exist.</p>
        <Link
          to="/"
          className="mt-2 text-sm font-medium text-accent transition-colors hover:text-accent-hover"
        >
          Back to dashboard
        </Link>
      </CardBody>
    </Card>
  );
}
