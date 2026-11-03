/**
 * In-process Trello REST fake.
 *
 * The fake implements only the endpoints the built Code CLI calls for a task
 * lifecycle. It is deliberately independent of the product Trello client: the
 * server parses raw HTTP requests and the fixture reads its own in-memory
 * state, so a client regression (wrong path, payload, or field) fails instead
 * of being mirrored by shared code.
 *
 * Routing is strict. Any request the fake does not implement returns a 404
 * whose body names the method and path, and the request is recorded so a test
 * can fail loudly even if the product ignores the error response.
 *
 * The server binds `127.0.0.1:0`, accepts any query `key`/`token` credentials,
 * never logs them, and never makes outbound requests.
 */

import type { TrackerComment, TrackerFixture, TrackerTicket, TrackerTicketState } from "./tracker";

interface FakeTrelloBoard {
  id: string;
  name: string;
  shortLink: string;
}

interface FakeTrelloList {
  id: string;
  name: string;
  boardId: string;
}

interface FakeTrelloLabel {
  id: string;
  name: string;
  color: string;
  boardId: string;
}

interface FakeTrelloCard {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  listId: string;
  boardId: string;
  labelIds: string[];
  archived: boolean;
  dateLastActivity: string;
}

interface FakeTrelloMember {
  id: string;
  username: string;
  fullName: string;
}

interface FakeTrelloAction {
  id: string;
  cardId: string;
  type: string;
  date: string;
  memberCreator: FakeTrelloMember;
  data: { text?: string };
}

interface FakeTrelloCheckItem {
  id: string;
  name: string;
}

interface FakeTrelloChecklist {
  id: string;
  cardId: string;
  name: string;
  items: FakeTrelloCheckItem[];
}

interface FakeTrelloAttachment {
  id: string;
  cardId: string;
  name: string;
  url: string;
  mimeType: string;
  bytes: number;
  date: string;
}

/** Board lists the fake exposes; the list name is the card status. */
export interface FakeTrelloStatuses {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/** Distinct list names used by the fake by default. */
export const FAKE_TRELLO_STATUSES: FakeTrelloStatuses = {
  todo: "To Do",
  inProgress: "Doing",
  pr: "Review",
  done: "Done",
};

export interface FakeTrelloOptions {
  /** Override one or more board list names. */
  statuses?: Partial<FakeTrelloStatuses>;
}

const FAKE_API_KEY = "fake-trello-api-key";
const FAKE_API_TOKEN = "fake-trello-token";

const FAKE_MEMBER: FakeTrelloMember = {
  id: "fake-member",
  username: "e2e-trello-user",
  fullName: "E2E Trello User",
};

/** Parsed Trello search operators the offline scenario uses. */
interface TrelloSearch {
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
function parseTrelloSearch(query: string): TrelloSearch {
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

/** Trello-shaped ticket fixture backed entirely by in-memory state. */
export class FakeTrelloTracker implements TrackerFixture {
  readonly type = "trello";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeTrelloStatuses;

  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];

  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly baseUrl: string;
  private readonly board: FakeTrelloBoard;
  private readonly lists: FakeTrelloList[] = [];
  private readonly labels = new Map<string, FakeTrelloLabel>();
  private readonly cards = new Map<string, FakeTrelloCard>();
  private readonly actions: FakeTrelloAction[] = [];
  private readonly checklists = new Map<string, FakeTrelloChecklist>();
  private readonly attachments: FakeTrelloAttachment[] = [];
  private nextCardNumber = 1;
  private nextCommentId = 10_000;
  private nextLabelNumber = 1;
  private nextChecklistNumber = 1;
  private nextCheckItemNumber = 1;
  private nextAttachmentNumber = 1;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeTrelloOptions = {}) {
    this.statuses = { ...FAKE_TRELLO_STATUSES, ...options.statuses };
    this.openState = this.statuses.todo;
    this.board = {
      id: "e2eb0a4d0000000000000001",
      name: "E2E Trello Board",
      shortLink: "e2eboard",
    };

    [
      ...new Set([
        this.statuses.todo,
        this.statuses.inProgress,
        this.statuses.pr,
        this.statuses.done,
      ]),
    ].forEach((name, index) => {
      this.lists.push({ id: `list-${index + 1}`, name, boardId: this.board.id });
    });

    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** Base URL the CLI subprocess must use. */
  get url(): string {
    return this.baseUrl;
  }

  /** Tracker configuration/credentials for the isolated CLI subprocess. */
  environment(): Record<string, string> {
    return {
      TASK_TRACKER: this.type,
      TRELLO_API_KEY: FAKE_API_KEY,
      TRELLO_API_TOKEN: FAKE_API_TOKEN,
      TRELLO_API_BASE_URL: this.baseUrl,
      TRELLO_DEFAULT_BOARD_ID: this.board.id,
      TRELLO_DEFAULT_LIST_NAME: this.statuses.todo,
    };
  }

  /** Board short link the CLI resolves through `resolveProjectKey`. */
  projectKey(): string {
    return this.board.shortLink;
  }

  /** Create every requested board label idempotently. */
  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) this.ensureLabel(label);
  }

  /** Create a card in the todo list, applying the requested labels by name. */
  async createTicket(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<TrackerTicket> {
    const card = this.createCard({
      name: input.title,
      desc: input.body,
      listId: this.requireList(this.statuses.todo).id,
      labelIds: (input.labels ?? []).map((label) => this.ensureLabel(label).id),
    });
    return { key: card.shortLink, url: this.cardUrl(card) };
  }

  async addComment(ticketKey: string, body: string): Promise<string> {
    const card = this.requireCard(ticketKey);
    return this.addCommentAction(card, body).id;
  }

  /** Archive a scenario-owned card; the containing board is never deleted. */
  async closeTicket(ticketKey: string): Promise<void> {
    const card = this.requireCard(ticketKey);
    card.archived = true;
    card.dateLastActivity = this.timestamp();
  }

  async deleteComment(commentId: string): Promise<void> {
    const index = this.actions.findIndex((action) => action.id === commentId);
    if (index < 0) throw new Error(`Fake Trello comment not found: ${commentId}`);
    this.actions.splice(index, 1);
  }

  async getTicket(ticketKey: string): Promise<TrackerTicketState> {
    const card = this.requireCard(ticketKey);
    return {
      state: this.listName(card.listId),
      labels: card.labelIds
        .map((id) => this.labels.get(id)?.name)
        .filter((name): name is string => Boolean(name)),
      body: card.desc,
    };
  }

  /** Current list name, which is what {@link TrackerTicketState.state} holds. */
  async getStatus(ticketKey: string): Promise<string> {
    return this.listName(this.requireCard(ticketKey).listId);
  }

  async listComments(ticketKey: string): Promise<TrackerComment[]> {
    const card = this.requireCard(ticketKey);
    return this.actions
      .filter((action) => action.cardId === card.id && action.type === "commentCard")
      .map((action) => ({ id: action.id, body: action.data.text ?? "" }));
  }

  /** Search open cards on the fixture board with the narrow Trello query subset. */
  async findTickets(query: string): Promise<TrackerTicket[]> {
    return this.matchingCards(query, this.board.id, true).map((card) => ({
      key: card.shortLink,
      url: this.cardUrl(card),
    }));
  }

  /** Stop the HTTP server and release the ephemeral port. */
  async cleanup(): Promise<void> {
    this.server.stop(true);
  }

  /** Stop the server when a test cannot reach the normal cleanup path. */
  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The product's default base URL ends in `/1`; the fixture base does not.
    const path = decodeURIComponent(url.pathname).replace(/^\/1(?=\/|$)/, "");
    const method = request.method.toUpperCase();

    const response = await this.route(method, path, url, request);
    if (response) return response;

    const diagnostic = `Unmatched fake Trello request: ${method} ${path}`;
    this.unexpectedRequests.push(diagnostic);
    return json({ error: diagnostic }, 404);
  }

  private route(
    method: string,
    path: string,
    url: URL,
    request: Request,
  ): Promise<Response> | Response | undefined {
    if (method === "GET") return this.routeGet(path, url);
    if (method === "POST") return this.routePost(path, request);
    if (method === "PUT") return this.routePut(path, request);
    return undefined;
  }

  private routeGet(path: string, url: URL): Response | undefined {
    if (path === "/members/me/boards") {
      return json([
        {
          id: this.board.id,
          name: this.board.name,
          shortUrl: `https://trello.com/b/${this.board.shortLink}`,
        },
      ]);
    }
    if (path === "/search") return this.search(url);

    const listsMatch = path.match(/^\/boards\/([^/]+)\/lists$/);
    if (listsMatch?.[1]) return this.getLists(listsMatch[1]);

    const labelsMatch = path.match(/^\/boards\/([^/]+)\/labels$/);
    if (labelsMatch?.[1]) return this.getBoardLabels(labelsMatch[1]);

    const actionsMatch = path.match(/^\/cards\/([^/]+)\/actions$/);
    if (actionsMatch?.[1]) return this.getActions(actionsMatch[1], url);

    const checklistsMatch = path.match(/^\/cards\/([^/]+)\/checklists$/);
    if (checklistsMatch?.[1]) return this.getCardChecklists(checklistsMatch[1]);

    const attachmentsMatch = path.match(/^\/cards\/([^/]+)\/attachments$/);
    if (attachmentsMatch?.[1]) return this.getCardAttachments(attachmentsMatch[1]);

    const cardMatch = path.match(/^\/cards\/([^/]+)$/);
    if (cardMatch?.[1]) return this.getCard(cardMatch[1]);

    return undefined;
  }

  private routePost(path: string, request: Request): Promise<Response> | undefined {
    if (path === "/cards") return this.postCard(request);
    if (path === "/checklists") return this.postChecklist(request);

    const commentsMatch = path.match(/^\/cards\/([^/]+)\/actions\/comments$/);
    if (commentsMatch?.[1]) return this.postComment(commentsMatch[1], request);

    const attachmentsMatch = path.match(/^\/cards\/([^/]+)\/attachments$/);
    if (attachmentsMatch?.[1]) return this.postCardAttachment(attachmentsMatch[1], request);

    const checkItemMatch = path.match(/^\/checklists\/([^/]+)\/checkItems$/);
    if (checkItemMatch?.[1]) return this.postCheckItem(checkItemMatch[1], request);

    return undefined;
  }

  private routePut(path: string, request: Request): Promise<Response> | undefined {
    const cardMatch = path.match(/^\/cards\/([^/]+)$/);
    if (cardMatch?.[1]) return this.updateCard(cardMatch[1], request);

    return undefined;
  }

  private search(url: URL): Response {
    const query = url.searchParams.get("query") ?? "";
    const boardId = url.searchParams.get("idBoards") ?? undefined;
    const cards = this.matchingCards(query, boardId).map((card) => this.cardSummary(card));
    return json({ cards });
  }

  private matchingCards(query: string, boardId?: string, forceOpen = false): FakeTrelloCard[] {
    const search = parseTrelloSearch(query);
    const openOnly = forceOpen || search.openOnly;
    return [...this.cards.values()].filter((card) => {
      if (boardId && card.boardId !== boardId) return false;
      if (openOnly && card.archived) return false;
      if (
        search.listName &&
        this.listName(card.listId).toLowerCase() !== search.listName.toLowerCase()
      ) {
        return false;
      }
      const searchable = `${card.name}\n${card.desc}`.toLowerCase();
      return search.terms.every((term) => searchable.includes(term.toLowerCase()));
    });
  }

  private getLists(boardId: string): Response {
    const board = this.findBoard(boardId);
    if (!board) return boardNotFound(boardId);
    return json(
      this.lists
        .filter((list) => list.boardId === board.id)
        .map((list) => ({ id: list.id, name: list.name })),
    );
  }

  private getBoardLabels(boardId: string): Response {
    const board = this.findBoard(boardId);
    if (!board) return boardNotFound(boardId);
    return json(
      [...this.labels.values()]
        .filter((label) => label.boardId === board.id)
        .map((label) => ({ id: label.id, name: label.name, color: label.color })),
    );
  }

  private async postCard(request: Request): Promise<Response> {
    const form = await readForm(request);
    const listId = form.idList;
    if (!listId) return json({ error: "idList is required" }, 400);
    const list = this.lists.find((candidate) => candidate.id === listId);
    if (!list) return json({ error: `List not found: ${listId}` }, 404);
    const card = this.createCard({
      name: form.name ?? "",
      desc: form.desc ?? "",
      listId: list.id,
      labelIds: this.parseLabelIds(form.idLabels),
    });
    return json(this.cardSummary(card));
  }

  private getCard(cardId: string): Response {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    return json(this.cardDetail(card));
  }

  private async updateCard(cardId: string, request: Request): Promise<Response> {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const form = await readForm(request);
    if (form.idList) {
      const list = this.lists.find((candidate) => candidate.id === form.idList);
      if (!list) return json({ error: `List not found: ${form.idList}` }, 404);
      card.listId = list.id;
    }
    if (form.idLabels !== undefined) {
      card.labelIds = this.parseLabelIds(form.idLabels);
    }
    if (form.name !== undefined) card.name = form.name;
    if (form.desc !== undefined) card.desc = form.desc;
    if (form.closed !== undefined) card.archived = form.closed === "true";
    card.dateLastActivity = this.timestamp();
    return json(this.cardDetail(card));
  }

  private getActions(cardId: string, url: URL): Response {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const filter = url.searchParams.get("filter");
    const actions = this.actions
      .filter((action) => action.cardId === card.id)
      .filter((action) => !filter || action.type === filter)
      .reverse();
    return json(actions.map((action) => this.actionPayload(action)));
  }

  private async postComment(cardId: string, request: Request): Promise<Response> {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const form = await readForm(request);
    if (form.text === undefined) return json({ error: "text is required" }, 400);
    const action = this.addCommentAction(card, form.text);
    return json(this.actionPayload(action), 201);
  }

  private getCardChecklists(cardId: string): Response {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    return json(
      [...this.checklists.values()]
        .filter((checklist) => checklist.cardId === card.id)
        .map((checklist) => ({
          id: checklist.id,
          name: checklist.name,
          idCard: checklist.cardId,
          checkItems: checklist.items,
        })),
    );
  }

  private getCardAttachments(cardId: string): Response {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    return json(this.attachments.filter((attachment) => attachment.cardId === card.id));
  }

  private async postCardAttachment(cardId: string, request: Request): Promise<Response> {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const form = await readForm(request);
    const attachment: FakeTrelloAttachment = {
      id: `attachment-${this.nextAttachmentNumber++}`,
      cardId: card.id,
      name: form.name ?? "Linked issue",
      url: form.url ?? "",
      mimeType: "text/uri-list",
      bytes: 0,
      date: this.timestamp(),
    };
    this.attachments.push(attachment);
    return json(attachment, 201);
  }

  private async postChecklist(request: Request): Promise<Response> {
    const form = await readForm(request);
    const card = form.idCard ? this.findCard(form.idCard) : undefined;
    if (!card) return cardNotFound(form.idCard ?? "");
    const checklist: FakeTrelloChecklist = {
      id: `checklist-${this.nextChecklistNumber++}`,
      cardId: card.id,
      name: form.name ?? "Checklist",
      items: [],
    };
    this.checklists.set(checklist.id, checklist);
    return json({ id: checklist.id, name: checklist.name, idCard: checklist.cardId }, 201);
  }

  private async postCheckItem(checklistId: string, request: Request): Promise<Response> {
    const checklist = this.checklists.get(checklistId);
    if (!checklist) return json({ error: `Checklist not found: ${checklistId}` }, 404);
    const form = await readForm(request);
    const item: FakeTrelloCheckItem = {
      id: `checkItem-${this.nextCheckItemNumber++}`,
      name: form.name ?? "",
    };
    checklist.items.push(item);
    return json(item, 201);
  }

  private createCard(input: {
    name: string;
    desc: string;
    listId: string;
    labelIds: string[];
  }): FakeTrelloCard {
    const number = this.nextCardNumber++;
    const card: FakeTrelloCard = {
      id: `card-${number}`,
      shortLink: `e2e${String(number).padStart(5, "0")}`,
      name: input.name,
      desc: input.desc,
      listId: input.listId,
      boardId: this.board.id,
      labelIds: input.labelIds,
      archived: false,
      dateLastActivity: this.timestamp(),
    };
    this.cards.set(card.id, card);
    return card;
  }

  private addCommentAction(card: FakeTrelloCard, text: string): FakeTrelloAction {
    const action: FakeTrelloAction = {
      id: String(this.nextCommentId++),
      cardId: card.id,
      type: "commentCard",
      date: this.timestamp(),
      memberCreator: FAKE_MEMBER,
      data: { text },
    };
    this.actions.push(action);
    card.dateLastActivity = action.date;
    return action;
  }

  private ensureLabel(name: string): FakeTrelloLabel {
    const existing = [...this.labels.values()].find(
      (label) => label.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing;
    const colors = ["green", "yellow", "orange", "red", "purple", "blue", "sky", "lime"];
    const label: FakeTrelloLabel = {
      id: `label-${this.nextLabelNumber}`,
      name,
      color: colors[(this.nextLabelNumber - 1) % colors.length] ?? "green",
      boardId: this.board.id,
    };
    this.nextLabelNumber += 1;
    this.labels.set(label.id, label);
    return label;
  }

  private parseLabelIds(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => this.labels.has(id));
  }

  private cardSummary(card: FakeTrelloCard): Record<string, unknown> {
    return {
      id: card.id,
      shortLink: card.shortLink,
      url: this.cardUrl(card),
      name: card.name,
    };
  }

  private cardDetail(card: FakeTrelloCard): Record<string, unknown> {
    return {
      ...this.cardSummary(card),
      desc: card.desc,
      shortUrl: this.cardUrl(card),
      idList: card.listId,
      idBoard: card.boardId,
      labels: card.labelIds
        .map((id) => this.labels.get(id))
        .filter((label): label is FakeTrelloLabel => Boolean(label))
        .map((label) => ({ id: label.id, name: label.name, color: label.color })),
      idMembers: [],
      dateLastActivity: card.dateLastActivity,
      board: { id: this.board.id, shortLink: this.board.shortLink },
      closed: card.archived,
    };
  }

  private actionPayload(action: FakeTrelloAction): Record<string, unknown> {
    return {
      id: action.id,
      type: action.type,
      date: action.date,
      memberCreator: action.memberCreator,
      data: action.data,
    };
  }

  private cardUrl(card: FakeTrelloCard): string {
    return `https://trello.com/c/${card.shortLink}/card`;
  }

  private listName(listId: string): string {
    return this.lists.find((list) => list.id === listId)?.name ?? listId;
  }

  private requireList(name: string): FakeTrelloList {
    const list = this.lists.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!list) throw new Error(`Fake Trello list not found: ${name}`);
    return list;
  }

  private findBoard(idOrShortLink: string): FakeTrelloBoard | undefined {
    if (idOrShortLink === this.board.id || idOrShortLink === this.board.shortLink) {
      return this.board;
    }
    return undefined;
  }

  private findCard(idOrShortLink: string): FakeTrelloCard | undefined {
    return (
      this.cards.get(idOrShortLink) ??
      [...this.cards.values()].find((card) => card.shortLink === idOrShortLink)
    );
  }

  private requireCard(idOrShortLink: string): FakeTrelloCard {
    const card = this.findCard(idOrShortLink);
    if (!card) throw new Error(`Fake Trello card not found: ${idOrShortLink}`);
    return card;
  }

  private timestamp(): string {
    this.now += 1000;
    return new Date(this.now).toISOString();
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cardNotFound(cardId: string): Response {
  return json({ error: `Fake Trello card not found: ${cardId}` }, 404);
}

function boardNotFound(boardId: string): Response {
  return json({ error: `Fake Trello board not found: ${boardId}` }, 404);
}

async function readForm(request: Request): Promise<Record<string, string>> {
  try {
    const params = new URLSearchParams(await request.text());
    const form: Record<string, string> = {};
    for (const [key, value] of params) form[key] = value;
    return form;
  } catch {
    return {};
  }
}
