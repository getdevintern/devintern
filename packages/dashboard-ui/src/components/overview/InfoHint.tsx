import { Info } from "lucide-react";
import { Tooltip } from "radix-ui";

/**
 * Keyboard- and pointer-accessible info hint: a real button that opens a
 * tooltip on hover and on focus, and exposes the text as its description.
 */
export function InfoHint({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-5 cursor-help items-center justify-center rounded-sm text-subtle-foreground transition-colors hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-72 rounded-md border border-border-strong bg-raised px-3 py-2 text-xs leading-relaxed text-foreground shadow-[0_6px_20px_-6px_rgb(0_0_0/0.5)]"
          >
            {text}
            <Tooltip.Arrow className="fill-raised" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
