import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Styled native <select> — desktop-native dropdown behavior, zero popover code. */
function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "flex h-8 w-full appearance-none rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
