/**
 * Trello REST API client
 *
 * API docs:
 * - Cards: https://developer.atlassian.com/cloud/trello/rest/api-group-cards/
 *   - Create card: POST /1/cards (idList required)
 *   - Get card: GET /1/cards/{id}
 * - Boards: https://developer.atlassian.com/cloud/trello/rest/api-group-boards/
 *   - Get member boards: GET /1/members/me/boards
 * - Lists: https://developer.atlassian.com/cloud/trello/rest/api-group-lists/
 *   - Get board lists: GET /1/boards/{id}/lists
 * - Checklists: https://developer.atlassian.com/cloud/trello/rest/api-group-checklists/
 *   - Create checklist: POST /1/checklists
 *   - Create checkItem: POST /1/checklists/{id}/checkItems
 * - Attachments: https://developer.atlassian.com/cloud/trello/rest/api-group-cards/#api-cards-id-attachments-post
 *   - Create attachment: POST /1/cards/{id}/attachments
 */

export interface TrelloBoard {
  id: string;
  name: string;
  shortUrl: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloCard {
  id: string;
  shortLink: string;
  url: string;
  name: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloCardDetail extends TrelloCard {
  desc: string;
  idList: string;
  idBoard: string;
  board?: {
    id: string;
    shortLink?: string;
  };
  labels: TrelloLabel[];
  idMembers: string[];
  dateLastActivity: string;
  shortUrl: string;
}

export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  memberCreator: {
    id: string;
    username: string;
    fullName: string;
  };
  data: {
    text?: string;
  };
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  bytes: number;
  date: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
}

/**
 * Normalize a Trello card reference to an ID or short link for API calls.
 *
 * Accepts short links (e.g. `4uWKPOTv`), 24-character card IDs, or full card URLs
 * (e.g. `https://trello.com/c/4uWKPOTv/card-slug`).
 */
export function parseTrelloCardReference(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:[\w-]+\.)?trello\.com\/c\/([a-zA-Z0-9]+)/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  return trimmed;
}

export class TrelloClient {
  private apiKey: string;
  private apiToken: string;
  private baseUrl = "https://api.trello.com/1";

  /**
   * Create a Trello REST API client.
   *
   * @param config - Power-Up API key and user token.
   */
  constructor(config: { apiKey: string; apiToken: string }) {
    this.apiKey = config.apiKey;
    this.apiToken = config.apiToken;
  }

  /**
   * Build a fully qualified Trello API URL with auth query parameters.
   *
   * @param endpoint - API path (e.g. `/cards`).
   * @param params - Additional query parameters.
   * @returns Absolute request URL including key and token.
   */
  private buildUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("token", this.apiToken);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Send an authenticated request to the Trello REST API.
   *
   * @param endpoint - API path.
   * @param method - HTTP method (default `GET`).
   * @param body - Optional form-urlencoded body for non-GET requests.
   * @returns Parsed JSON response body.
   * @throws When the response status is not OK.
   */
  private async request<T>(
    endpoint: string,
    method: string = "GET",
    body?: Record<string, string>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint);
    const options: RequestInit = { method };

    if (body && method !== "GET") {
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        formData.append(key, value);
      }
      options.body = formData.toString();
      options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trello API error (${response.status}): ${errorText}`);
    }

    return response.json() as T;
  }

  private normalizeCardId(cardIdOrShortLink: string): string {
    return parseTrelloCardReference(cardIdOrShortLink);
  }

  /**
   * List boards for the authenticated member.
   *
   * @returns Board id, name, and short URL records.
   * @throws When the Trello API request fails.
   */
  async getBoards(): Promise<TrelloBoard[]> {
    return this.request<TrelloBoard[]>("/members/me/boards");
  }

  /**
   * List lists on a board.
   *
   * @param boardId - Trello board ID.
   * @returns List id and name records.
   * @throws When the Trello API request fails.
   */
  async getLists(boardId: string): Promise<TrelloList[]> {
    return this.request<TrelloList[]>(`/boards/${boardId}/lists`);
  }

  /**
   * Fetch a card by ID or short link.
   *
   * @param cardIdOrShortLink - Card ID or short link token.
   * @returns Card metadata including URL.
   * @throws When the card is not found or the API request fails.
   */
  async getCard(cardIdOrShortLink: string): Promise<TrelloCard> {
    const cardId = this.normalizeCardId(cardIdOrShortLink);
    return this.request<TrelloCard>(`/cards/${cardId}`);
  }

  /**
   * Create a card on a list.
   *
   * @param name - Card title.
   * @param description - Card description.
   * @param listId - Target list ID.
   * @returns Created card metadata.
   * @throws When the Trello API request fails.
   */
  async createCard(name: string, description: string, listId: string): Promise<TrelloCard> {
    return this.request<TrelloCard>("/cards", "POST", {
      idList: listId,
      name,
      desc: description,
    });
  }

  /**
   * Add a checklist item to a card, creating a "Subtasks" checklist if needed.
   *
   * @param parentCardId - Parent card ID.
   * @param name - Checklist item title.
   * @param description - Optional description appended to the item name.
   * @returns Created check item id and name.
   * @throws When the Trello API request fails.
   */
  async createChecklistItem(
    parentCardId: string,
    name: string,
    description?: string,
  ): Promise<TrelloCheckItem> {
    const cardId = this.normalizeCardId(parentCardId);
    // Ensure the card has a checklist
    const checklists = await this.request<Array<{ id: string }>>(`/cards/${cardId}/checklists`);

    let checklistId: string;
    if (checklists.length === 0) {
      const newChecklist = await this.request<{ id: string }>("/checklists", "POST", {
        idCard: cardId,
        name: "Subtasks",
      });
      checklistId = newChecklist.id;
    } else {
      checklistId = checklists[0]!.id;
    }

    // Add check item
    const itemName = description ? `${name}: ${description}` : name;
    const checkItem = await this.request<TrelloCheckItem>(
      `/checklists/${checklistId}/checkItems`,
      "POST",
      { name: itemName },
    );

    return checkItem;
  }

  /**
   * Attach an external URL to a card.
   *
   * @param cardId - Target card ID.
   * @param url - URL to attach.
   * @param name - Optional attachment display name (default `Linked issue`).
   * @throws When the Trello API request fails.
   */
  async addAttachment(cardId: string, url: string, name?: string): Promise<void> {
    const normalizedCardId = this.normalizeCardId(cardId);
    await this.request(`/cards/${normalizedCardId}/attachments`, "POST", {
      url,
      name: name || "Linked issue",
    });
  }

  /**
   * Fetch full card details including description, list, board, and labels.
   *
   * @param cardIdOrShortLink - Card ID or short link token.
   * @returns Detailed card metadata.
   * @throws When the card is not found or the API request fails.
   */
  async getCardWithDetails(cardIdOrShortLink: string): Promise<TrelloCardDetail> {
    const cardId = this.normalizeCardId(cardIdOrShortLink);
    return this.request<TrelloCardDetail>(`/cards/${cardId}`, "GET", {
      fields:
        "id,name,desc,shortLink,url,shortUrl,idList,idBoard,labels,idMembers,dateLastActivity",
      board: "true",
      board_fields: "id,shortLink",
    } as Record<string, string>);
  }

  /**
   * Fetch comments (commentCard actions) on a card.
   *
   * @param cardId - Card ID or short link.
   * @returns Array of comment actions, newest first.
   * @throws When the Trello API request fails.
   */
  async getCardComments(cardId: string): Promise<TrelloAction[]> {
    const normalizedCardId = this.normalizeCardId(cardId);
    return this.request<TrelloAction[]>(`/cards/${normalizedCardId}/actions`, "GET", {
      filter: "commentCard",
    } as Record<string, string>);
  }

  /**
   * Post a text comment on a card.
   *
   * @param cardId - Card ID or short link.
   * @param text - Comment body (plain text).
   * @throws When the Trello API request fails.
   */
  async postCardComment(cardId: string, text: string): Promise<void> {
    const normalizedCardId = this.normalizeCardId(cardId);
    await this.request(`/cards/${normalizedCardId}/actions/comments`, "POST", { text });
  }

  /**
   * Move a card to a different list.
   *
   * @param cardId - Card ID or short link.
   * @param listId - Target list ID.
   * @throws When the Trello API request fails.
   */
  async moveCardToList(cardId: string, listId: string): Promise<void> {
    const normalizedCardId = this.normalizeCardId(cardId);
    await this.request(`/cards/${normalizedCardId}`, "PUT", { idList: listId });
  }

  /**
   * Fetch file/URL attachments on a card.
   *
   * @param cardId - Card ID or short link.
   * @returns Array of attachment metadata.
   * @throws When the Trello API request fails.
   */
  async getCardAttachments(cardId: string): Promise<TrelloAttachment[]> {
    const normalizedCardId = this.normalizeCardId(cardId);
    return this.request<TrelloAttachment[]>(`/cards/${normalizedCardId}/attachments`);
  }

  /**
   * Search cards using Trello search operators.
   *
   * Query syntax: free text plus operators like `list:"To Do"`, `label:bug`,
   * `is:open`, `due:week`. See
   * https://support.atlassian.com/trello/docs/searching-for-cards-all-boards/
   *
   * @param query - Trello search query.
   * @param boardId - Optional board ID to scope the search to.
   * @returns Matching cards (first 100) and total count of returned cards.
   * @throws When the Trello API request fails.
   */
  async searchCards(
    query: string,
    boardId?: string,
  ): Promise<{ cards: TrelloCard[]; total: number }> {
    const params: Record<string, string> = {
      query,
      modelTypes: "cards",
      cards_limit: "100",
      card_fields: "id,shortLink,url,name",
    };
    if (boardId) {
      params.idBoards = boardId;
    }

    const url = this.buildUrl("/search", params);
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trello API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { cards?: TrelloCard[] };
    const cards = data.cards || [];
    return { cards, total: cards.length };
  }
}
