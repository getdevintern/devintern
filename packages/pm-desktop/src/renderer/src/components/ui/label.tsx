import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex flex-col gap-1 text-xs font-medium text-muted-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
