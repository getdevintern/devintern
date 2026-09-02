/**
 * React error boundary: last-resort crash screen.
 *
 * Reports the crash through the renderer error-reporting path (forwarded to
 * main for error tracking) and offers a reload, so a render crash is neither
 * invisible nor a dead white window.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { reportRendererError } from "../lib/error-reporting.ts";
import { Button } from "@/components/ui/button";

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
    reportRendererError({
      kind: "react",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(info.componentStack ? { componentStack: info.componentStack } : {}),
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          The app hit an unexpected error and cannot continue rendering. Reloading usually fixes
          this; the error has been reported automatically.
        </p>
        <p className="max-w-xl truncate font-mono text-xs text-muted-foreground">{error.message}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}
