/** Parsed Trello search operators the offline scenario uses (see `fake-trello.ts`). */
export interface TrelloSearch {
  openOnly: boolean;
  listName?: string;
  terms: string[];
}

/**
 * Parse the narrow search subset the product and scenario rely on.
 *
 * Supported operators: `is:open` (not archived) and `list:"<name>"` (or the
 * unquoted `list:<name>` form). Every remaining whitespace-separated term must
 * appear in the card name or description.
 */
export function parseTrelloSearch(query: string): TrelloSearch {
  let rest = query;
  let listName: string | undefined;
  rest = rest.replace(/list:"([^"]+)"|list:([^\s]+)/gi, (_match, quoted, bare) => {
    listName = String(quoted ?? bare);
    return " ";
  });

  const openOnly = /(?:^|\s)is:open(?:\s|$)/i.test(rest);
  rest = rest.replace(/(?:^|\s)is:open(?:\s|$)/gi, " ");

  const terms = rest
    .split(/\s+/)
    .map((term) => term.replace(/^["']|["']$/g, ""))
    .filter((term) => term.length > 0 && !term.toLowerCase().startsWith("is:"));

  return { openOnly, listName, terms };
}
