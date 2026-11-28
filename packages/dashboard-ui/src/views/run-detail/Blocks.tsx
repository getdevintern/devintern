import { TaskKeyLink } from "@/components/overview/DependencyLinks";
import type { TaskDependent } from "@/lib/api";

/**
 * Queued tasks that wait on this run's task, each opening its row in the
 * Overview's queue, so after a retry the operator can jump to what it
 * unblocks. Renders nothing when no queued task waits on it.
 */
export function BlocksSection({ blocks }: { blocks: readonly TaskDependent[] | undefined }) {
  if (!blocks?.length) return null;
  return (
    <section aria-labelledby="rd-blocks">
      <h3 id="rd-blocks" className="section-title mb-2">
        Blocks
      </h3>
      <ul className="space-y-2">
        {blocks.map((dependent) => (
          <li key={dependent.queuedItemId} className="text-[0.8125rem]">
            <TaskKeyLink taskKey={dependent.key} queuedItemId={dependent.queuedItemId}>
              {dependent.title}
            </TaskKeyLink>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-subtle-foreground">
              {dependent.title !== dependent.key ? (
                <code className="font-mono">{dependent.key}</code>
              ) : null}
              {dependent.dependencyState ? (
                <span
                  className={dependent.dependencyState === "blocked" ? "text-danger" : undefined}
                >
                  {dependent.dependencyState === "blocked" ? "Blocked" : "Waiting"}
                  {dependent.dependencyReason ? `: ${dependent.dependencyReason}` : ""}
                </span>
              ) : (
                <span>Ready to start</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
