import { ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CODE_PRODUCT_URL } from "../../../shared/code-discovery.ts";

export type CodeDiscoveryVariant = "card" | "sidebar" | "post-create";

interface CodeDiscoveryCardProps {
  onLearnMore: (url: string) => void;
  onDismiss: () => void;
  /** Inline note when dismissing failed to persist; tip stays visible. */
  dismissError?: string | null;
  /** Layout for empty state, sidebar footer, or post-create tip. */
  variant?: CodeDiscoveryVariant;
}

function ProductName() {
  return (
    <span className="font-mono">
      <span className="product-code">devintern</span>
      <span className="product-sep">/</span>
      <span className="product-code">code</span>
    </span>
  );
}

function DismissIconButton({ onDismiss, testId }: { onDismiss: () => void; testId: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onDismiss}
      title="Don't show again"
      aria-label="Don't show this tip again"
      data-testid={testId}
    >
      <X />
    </Button>
  );
}

function DismissError({ error }: { error: string }) {
  return (
    <p className="text-xs text-destructive" role="alert" data-testid="code-discovery-dismiss-error">
      {"Couldn't save preference: "}
      {error}
    </p>
  );
}

/**
 * Soft tip pointing PM Desktop users at unattended Code workflows.
 * Never a modal — card (empty state), sidebar footer, or post-create.
 */
export function CodeDiscoveryCard({
  onLearnMore,
  onDismiss,
  dismissError = null,
  variant = "card",
}: CodeDiscoveryCardProps) {
  if (variant === "sidebar") {
    return (
      <aside
        className="border-t border-border/60 bg-card/60 p-2.5 text-left ring-inset ring-product-code/15"
        data-testid="code-discovery-sidebar"
        role="complementary"
        aria-label="Discover overnight Code automation"
      >
        <div className="flex items-start justify-between gap-1">
          <p className="text-[0.7rem] leading-snug font-medium">
            Ready tickets clear overnight with <ProductName />
          </p>
          <DismissIconButton onDismiss={onDismiss} testId="code-discovery-dismiss" />
        </div>
        <p className="mt-1 text-[0.65rem] leading-relaxed text-muted-foreground">
          {"Workers pick up ready tickets and open PRs while you're away."}
        </p>
        {dismissError && (
          <div className="mt-1">
            <DismissError error={dismissError} />
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 h-7 w-full text-[0.7rem]"
          onClick={() => onLearnMore(CODE_PRODUCT_URL)}
          data-testid="code-discovery-learn-more"
        >
          See how
          <ExternalLink data-icon="inline-end" />
        </Button>
      </aside>
    );
  }

  if (variant === "post-create") {
    return (
      <aside
        className="rounded-md border border-product-code/25 bg-product-code/5 p-3 text-left"
        data-testid="code-discovery-post-create"
        role="complementary"
        aria-label="Discover overnight Code automation"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">
            You just filed this at the desk. <ProductName /> can implement ready tickets and open
            PRs overnight.
          </p>
          <DismissIconButton onDismiss={onDismiss} testId="code-discovery-dismiss" />
        </div>
        {dismissError && (
          <div className="mt-2">
            <DismissError error={dismissError} />
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            data-testid="code-discovery-dismiss-link"
          >
            {"Don't show again"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onLearnMore(CODE_PRODUCT_URL)}
            data-testid="code-discovery-learn-more"
          >
            See how Code runs unattended
            <ExternalLink data-icon="inline-end" />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <Card
      size="sm"
      className="mt-8 w-full max-w-md text-left ring-product-code/20"
      data-testid="code-discovery-card"
      role="complementary"
      aria-label="Discover overnight Code automation"
    >
      <CardHeader>
        <CardTitle className="text-sm">
          Ready tickets can clear overnight with <ProductName />
        </CardTitle>
        <CardAction>
          <DismissIconButton onDismiss={onDismiss} testId="code-discovery-dismiss" />
        </CardAction>
        <CardDescription>
          {
            "Same tracker you already use. Workers pick up ready tickets, implement them, and open PRs on a schedule or in a loop, so throughput isn't capped by who's at this desk."
          }
        </CardDescription>
        {dismissError && <DismissError error={dismissError} />}
      </CardHeader>
      <CardFooter className="justify-between gap-2 border-t border-border/60">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          data-testid="code-discovery-dismiss-link"
        >
          {"Don't show again"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onLearnMore(CODE_PRODUCT_URL)}
          data-testid="code-discovery-learn-more"
        >
          See how Code runs unattended
          <ExternalLink data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  );
}
