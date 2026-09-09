/**
 * Route-level error boundary.
 *
 * React unmounts the whole tree when a render throws, so one bad field in one
 * card takes the entire app to a blank white page — no nav, no way back except
 * a reload. Catching at the route keeps the shell and every other page usable,
 * and shows the message instead of hiding it in the console.
 *
 * Must be a class: `getDerivedStateFromError` has no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Card, CardBody, CardHeader } from './Card';
import { Button } from './Button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the useful half: the message alone rarely says
    // which card threw when several render off the same response.
    console.error('Render error:', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Card>
        <CardHeader
          title="This view failed to render"
          description="The rest of the app is unaffected — other pages still work."
        />
        <CardBody>
          <p className="text-sm text-text-muted">
            Usually this means data arrived in a shape the page did not expect.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs text-negative">
            {error.message}
          </pre>
          <Button variant="primary" size="sm" className="mt-4" onClick={this.reset}>
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardBody>
      </Card>
    );
  }
}
