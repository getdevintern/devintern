/**
 * Label terms in a GitHub-style issue query (`is:open label:bug`), the
 * syntax the GitHub and GitLab trackers share. Setup checks these names
 * against the repository so a misspelled label is caught before the worker
 * polls a query that can never match.
 */

/**
 * The label names a query selects on: every `label:` (or GitLab's
 * `labels:`) term, quoted or not, with comma-separated values split
 * (`label:bug,docs`). Negated terms (`-label:wontfix`) are ignored: a
 * missing excluded label cannot hide tasks. Duplicates (case-insensitive)
 * are dropped, first spelling kept.
 *
 * @param query - The ready-tasks query.
 * @returns Label names in query order; empty when the query has no label term.
 */
export function extractQueryLabels(query: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  // A term starts at the query start or after whitespace; `-` negates it.
  const term = /(^|\s)(-?)labels?:/gi;
  let match: RegExpExecArray | null;
  while ((match = term.exec(query))) {
    const { values, end } = readLabelValues(query, match.index + match[0].length);
    term.lastIndex = end;
    if (match[2] === "-") continue;
    for (const value of values) {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      labels.push(value);
    }
  }
  return labels;
}

/** Comma-separated label values starting at `start`, each quoted or bare. */
function readLabelValues(query: string, start: number): { values: string[]; end: number } {
  const values: string[] = [];
  let i = start;
  for (;;) {
    const quote = query[i];
    let value: string;
    if (quote === '"' || quote === "'") {
      const close = query.indexOf(quote, i + 1);
      const stop = close < 0 ? query.length : close;
      value = query.slice(i + 1, stop);
      i = close < 0 ? stop : stop + 1;
    } else {
      let stop = i;
      while (stop < query.length && !/[\s,]/.test(query[stop]!)) stop++;
      value = query.slice(i, stop);
      i = stop;
    }
    values.push(value.trim());
    if (query[i] !== ",") break;
    i++;
  }
  return { values, end: i };
}
