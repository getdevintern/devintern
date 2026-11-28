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
 * Every card create, update, list move, archive, comment, checklist, and
 * attachment appends a board action, and `GET /1/boards/:id/actions` serves
 * them newest first with Trello's `since`, `filter`, and `limit` semantics so
 * the worker's board-actions change detector runs against a real feed.
 *
 * `GET /1/cards/:id?…&list=true` (the dependency gate's blocker status read)
 * answers the card's `closed` flag and nested `list` name, is recorded in
 * `blockerStatusRequests`, and can be switched to an HTTP error.
 *
 * The server binds `127.0.0.1:0`, accepts any query `key`/`token` unless
 * `apiToken` is set, never logs them (requests record only whether the fake
 * credentials matched), and never makes outbound requests.
 */

import { SearchRejections, textResponse } from "./fake-auth";
import { parseTrelloSearch } from "./fake-trello-search";
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
  data: Record<string, unknown> & { text?: string };
}

/** One recorded request; never holds credentials, only whether they matched. */
export interface FakeTrelloRequest {
  method: string;
  path: string;
  credentialsMatched: boolean;
}

/** Query parameters one `GET /1/boards/:id/actions` request carried. */
export interface FakeTrelloBoardActionsRequest {
  since: string | null;
  filter: string | null;
  limit: string | null;
}

/** Board action summary for test assertions. */
export interface FakeTrelloBoardAction {
  id: string;
  type: string;
  cardShortLink: string;
}

/** Trello action ids are 24-hex ObjectIds; a padded counter keeps them ordered. */
const ACTION_ID_PATTERN = /^[0-9a-f]{24}$/i;
const DEFAULT_ACTIONS_LIMIT = 50;
const MAX_ACTIONS_LIMIT = 1000;

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
  /** Caller-chosen API key handed out by `environment()`. */
  apiKey?: string;
  /** Caller-chosen token; a request with another key/token gets Trello's 401. */
  apiToken?: string;
}

const FAKE_API_KEY = "fake-trello-api-key";
const FAKE_API_TOKEN = "fake-trello-token";

const FAKE_MEMBER: FakeTrelloMember = {
  id: "fake-member",
  username: "e2e-trello-user",
  fullName: "E2E Trello User",
};

/** Trello-shaped ticket fixture backed entirely by in-memory state. */
export class FakeTrelloTracker implements TrackerFixture {
  readonly type = "trello";
  readonly statusKind = "state" as const;
  readonly openState: string;
  readonly statuses: FakeTrelloStatuses;

  /** Requests the fake could not route, for an explicit end-of-test assertion. */
  readonly unexpectedRequests: string[] = [];
  /** Every request in arrival order, without query strings or credentials. */
  readonly requests: FakeTrelloRequest[] = [];
  /** The `query` of every `GET /1/search`, in order. */
  readonly searches: string[] = [];
  private readonly searchRejections = new SearchRejections();
  private readonly options: FakeTrelloOptions;
  /** `since`/`filter`/`limit` received by each board actions request, in order. */
  readonly boardActionRequests: FakeTrelloBoardActionsRequest[] = [];
  /**
   * Card id or short link of every blocker status read (`GET /1/cards/:id`
   * with `list=true`), in order, including reads answered with a failure.
   */
  readonly blockerStatusRequests: string[] = [];

  /** HTTP status blocker status reads answer with while set; see {@link failBlockerStatusReads}. */
  private blockerStatusFailure: number | undefined;

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
  private nextActionNumber = 1;
  private nextLabelNumber = 1;
  private nextChecklistNumber = 1;
  private nextCheckItemNumber = 1;
  private nextAttachmentNumber = 1;
  private now = Date.parse("2026-01-01T00:00:00.000Z");

  constructor(options: FakeTrelloOptions = {}) {
    this.options = options;
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
      TRELLO_API_KEY: this.options.apiKey ?? FAKE_API_KEY,
      TRELLO_API_TOKEN: this.options.apiToken ?? FAKE_API_TOKEN,
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
    this.recordCardAction(card, "updateCard", { old: { closed: false } });
  }

  async deleteComment(commentId: string): Promise<void> {
    const index = this.actions.findIndex(
      (action) => action.id === commentId && action.type === "commentCard",
    );
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

  /**
   * Apply a human edit to a card, appending one `updateCard` board action.
   *
   * Mirrors `PUT /1/cards/:id`: description and list may change together.
   */
  async updateTicket(
    ticketKey: string,
    update: { body?: string; listName?: string },
  ): Promise<void> {
    const card = this.requireCard(ticketKey);
    const before = this.listName(card.listId);
    const listBefore = this.lists.find((list) => list.id === card.listId);
    const old: Record<string, unknown> = {};
    if (update.body !== undefined) {
      old.desc = card.desc;
      card.desc = update.body;
    }
    if (update.listName !== undefined) {
      old.idList = card.listId;
      card.listId = this.requireList(update.listName).id;
    }
    const listAfter = this.lists.find((list) => list.id === card.listId);
    this.recordCardAction(card, "updateCard", {
      old,
      ...(update.listName !== undefined && before !== this.listName(card.listId)
        ? { listBefore: listRef(listBefore), listAfter: listRef(listAfter) }
        : { list: listRef(listAfter) }),
    });
  }

  /** Board actions newest first, as `GET /1/boards/:id/actions` would return them. */
  boardActions(): FakeTrelloBoardAction[] {
    return [...this.actions].reverse().map((action) => ({
      id: action.id,
      type: action.type,
      cardShortLink: this.cards.get(action.cardId)?.shortLink ?? action.cardId,
    }));
  }

  /** Newest board action id, the cursor a fully caught-up detector holds. */
  newestActionId(): string | undefined {
    return this.actions.at(-1)?.id;
  }

  /**
   * Make every blocker status read answer `status` (default 500) until
   * {@link restoreBlockerStatusReads}. Only the `list=true` card read fails; the card detail
   * read the worker uses to load the dependent's description still answers.
   * Trello has no native dependencies, so the blockers themselves are fixture
   * state already: a `Depends on:` line in the dependent's description
   * ({@link createTicket} / {@link updateTicket}), and the blocker's list
   * ({@link updateTicket} `listName`) or archived flag ({@link closeTicket}).
   */
  failBlockerStatusReads(status = 500): void {
    this.blockerStatusFailure = status;
  }

  /** Answer blocker status reads normally again. */
  restoreBlockerStatusReads(): void {
    this.blockerStatusFailure = undefined;
  }

  /** Number of `GET /1/search` requests (the worker's evaluate step). */
  get searchCount(): number {
    return this.requests.filter((request) => request.method === "GET" && request.path === "/search")
      .length;
  }

  /** Answer later searches whose `query` contains `needle` with Trello's plain-text 400. */
  rejectSearchesContaining(needle: string, message: string): void {
    this.searchRejections.add(needle, message);
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
    const { TRELLO_API_KEY: key, TRELLO_API_TOKEN: token } = this.environment();
    const credentialsMatched =
      url.searchParams.get("key") === key && url.searchParams.get("token") === token;
    this.requests.push({ method, path, credentialsMatched });
    if (this.options.apiToken !== undefined && !credentialsMatched) {
      return textResponse("invalid token", 401);
    }

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

    const boardActionsMatch = path.match(/^\/boards\/([^/]+)\/actions$/);
    if (boardActionsMatch?.[1]) return this.getBoardActions(boardActionsMatch[1], url);

    const actionsMatch = path.match(/^\/cards\/([^/]+)\/actions$/);
    if (actionsMatch?.[1]) return this.getActions(actionsMatch[1], url);

    const checklistsMatch = path.match(/^\/cards\/([^/]+)\/checklists$/);
    if (checklistsMatch?.[1]) return this.getCardChecklists(checklistsMatch[1]);

    const attachmentsMatch = path.match(/^\/cards\/([^/]+)\/attachments$/);
    if (attachmentsMatch?.[1]) return this.getCardAttachments(attachmentsMatch[1]);

    const cardMatch = path.match(/^\/cards\/([^/]+)$/);
    if (cardMatch?.[1]) {
      return url.searchParams.get("list") === "true"
        ? this.getCardStatus(cardMatch[1], url)
        : this.getCard(cardMatch[1]);
    }

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
    this.searches.push(query);
    const rejection = this.searchRejections.find(query);
    if (rejection) return textResponse(rejection, 400);
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

  /**
   * `GET /1/boards/:id/actions`: newest first, only actions strictly newer
   * than `since` (an action id or an ISO date), optional comma-separated
   * `filter` of action types (`all` or absent means every type), and `limit`
   * (default 50, max 1000).
   */
  private getBoardActions(boardId: string, url: URL): Response {
    const board = this.findBoard(boardId);
    if (!board) return boardNotFound(boardId);
    const since = url.searchParams.get("since");
    const filter = url.searchParams.get("filter");
    const limitParam = url.searchParams.get("limit");
    this.boardActionRequests.push({ since, filter, limit: limitParam });

    let newerThan: (action: FakeTrelloAction) => boolean = () => true;
    if (since !== null) {
      if (ACTION_ID_PATTERN.test(since)) {
        const cursor = since.toLowerCase();
        newerThan = (action) => action.id > cursor;
      } else {
        const sinceMs = Date.parse(since);
        if (!Number.isFinite(sinceMs)) {
          return json({ error: `invalid value for since: ${since}` }, 400);
        }
        newerThan = (action) => Date.parse(action.date) > sinceMs;
      }
    }

    const types =
      filter && filter !== "all"
        ? new Set(
            filter
              .split(",")
              .map((type) => type.trim())
              .filter(Boolean),
          )
        : undefined;

    const limit = limitParam === null ? DEFAULT_ACTIONS_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ACTIONS_LIMIT) {
      return json({ error: `invalid value for limit: ${limitParam}` }, 400);
    }

    const actions = this.actions
      .filter((action) => this.cards.get(action.cardId)?.boardId === board.id)
      .filter(newerThan)
      .filter((action) => !types || types.has(action.type))
      .reverse()
      .slice(0, limit);
    return json(actions.map((action) => this.actionPayload(action)));
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

  /**
   * `GET /1/cards/:id?fields=…&list=true&list_fields=name`: the blocker status
   * read of `TrelloClient.getCardStatus` (packages/task-trackers/src/clients/trello.ts).
   * Trello answers the requested card fields plus a nested `list` object
   * (always with its `id`, then the `list_fields`); an unknown short link is a
   * 404, which the client maps to "card does not exist".
   */
  private getCardStatus(cardId: string, url: URL): Response {
    this.blockerStatusRequests.push(cardId);
    if (this.blockerStatusFailure !== undefined) {
      return json(
        { error: "Fake Trello injected blocker read failure" },
        this.blockerStatusFailure,
      );
    }
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const detail: Record<string, unknown> = {
      id: card.id,
      shortLink: card.shortLink,
      closed: card.archived,
      name: card.name,
      desc: card.desc,
      idList: card.listId,
      dateLastActivity: card.dateLastActivity,
    };
    const fields = url.searchParams.get("fields");
    const payload: Record<string, unknown> = {};
    for (const field of fields ? fields.split(",") : Object.keys(detail)) {
      if (field in detail) payload[field] = detail[field];
    }
    payload.id = card.id;
    const list = this.lists.find((candidate) => candidate.id === card.listId);
    if (list) {
      const listFields = (url.searchParams.get("list_fields") ?? "name").split(",");
      payload.list = {
        id: list.id,
        ...(listFields.includes("name") ? { name: list.name } : {}),
      };
    }
    return json(payload);
  }

  private async updateCard(cardId: string, request: Request): Promise<Response> {
    const card = this.findCard(cardId);
    if (!card) return cardNotFound(cardId);
    const form = await readForm(request);
    const listBefore = this.lists.find((candidate) => candidate.id === card.listId);
    const old: Record<string, unknown> = {};
    if (form.idList) {
      const list = this.lists.find((candidate) => candidate.id === form.idList);
      if (!list) return json({ error: `List not found: ${form.idList}` }, 404);
      if (list.id !== card.listId) old.idList = card.listId;
      card.listId = list.id;
    }
    if (form.idLabels !== undefined) {
      old.idLabels = card.labelIds;
      card.labelIds = this.parseLabelIds(form.idLabels);
    }
    if (form.name !== undefined) {
      old.name = card.name;
      card.name = form.name;
    }
    if (form.desc !== undefined) {
      old.desc = card.desc;
      card.desc = form.desc;
    }
    if (form.closed !== undefined) {
      old.closed = card.archived;
      card.archived = form.closed === "true";
    }
    const listAfter = this.lists.find((candidate) => candidate.id === card.listId);
    this.recordCardAction(card, "updateCard", {
      old,
      ...("idList" in old
        ? { listBefore: listRef(listBefore), listAfter: listRef(listAfter) }
        : { list: listRef(listAfter) }),
    });
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
    this.recordCardAction(card, "addAttachmentToCard", {
      attachment: { id: attachment.id, name: attachment.name, url: attachment.url },
    });
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
    this.recordCardAction(card, "addChecklistToCard", {
      checklist: { id: checklist.id, name: checklist.name },
    });
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
    this.recordCardAction(card, "createCard", {
      list: listRef(this.lists.find((list) => list.id === card.listId)),
    });
    return card;
  }

  private addCommentAction(card: FakeTrelloCard, text: string): FakeTrelloAction {
    return this.recordCardAction(card, "commentCard", { text });
  }

  /**
   * Append one board action for a card mutation and bump the card's
   * `dateLastActivity`, as Trello does for every card action.
   */
  private recordCardAction(
    card: FakeTrelloCard,
    type: string,
    data: Record<string, unknown>,
  ): FakeTrelloAction {
    const action: FakeTrelloAction = {
      id: (this.nextActionNumber++).toString(16).padStart(24, "0"),
      cardId: card.id,
      type,
      date: this.timestamp(),
      memberCreator: FAKE_MEMBER,
      data: {
        ...data,
        card: { id: card.id, shortLink: card.shortLink, name: card.name },
        board: { id: this.board.id, shortLink: this.board.shortLink, name: this.board.name },
      },
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

function listRef(list: FakeTrelloList | undefined): Record<string, string> | undefined {
  return list ? { id: list.id, name: list.name } : undefined;
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
