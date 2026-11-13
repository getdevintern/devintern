import { useEffect, useState } from "react";

/**
 * Current time, refreshed on an interval while the tab is visible, so
 * countdowns and elapsed times stay current between data polls.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
