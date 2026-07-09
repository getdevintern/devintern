import { TrelloClient } from "@devintern/task-trackers";
import type { CreatedTask, ProjectInfo, TaskBackend } from "./types";

/**
 * Trello backend adapter.
 *
 * @see {@link TrelloClient} for REST API implementation details.
 */
export class TrelloBackend implements TaskBackend {
  readonly name = "Trello";
  readonly supportsIssueTypes = false;
  // Trello has no native epic/parent hierarchy; linkToEpic only adds an
  // attachment, so epic linking is treated as unsupported.
  readonly supportsEpicLinking = false;
  private client: TrelloClient;
  private defaultBoardId?: string;
  private defaultListName?: string;
  private listsCache = new Map<string, Array<{ id: string; name: string }>>();

  /**
   * Create a Trello backend from API credentials and optional defaults.
   *
   * @param config - Trello API key/token and optional default board/list.
   */
  constructor(config: {
    apiKey: string;
    apiToken: string;
    defaultBoardId?: string;
    defaultListName?: string;
  }) {
    this.client = new TrelloClient({
      apiKey: config.apiKey,
      apiToken: config.apiToken,
    });
    this.defaultBoardId = config.defaultBoardId;
    this.defaultListName = config.defaultListName;
  }

  /**
   * Resolve a Trello list ID from a board ID or configured defaults.
   *
   * @param projectKey - Optional board ID override.
   * @returns Trello list UUID for card creation.
   * @throws When no boards or lists are available.
   */
  private async resolveListId(projectKey?: string): Promise<string> {
    const boardId = projectKey || this.defaultBoardId;

    if (!boardId) {
      const boards = await this.client.getBoards();
      if (boards.length === 0) {
        throw new Error("No Trello boards found. Please create a board first.");
      }
      const firstBoard = boards[0]!;
      return this.resolveListForBoard(firstBoard.id);
    }

    return this.resolveListForBoard(boardId);
  }

  /**
   * Pick a list on a board, preferring the configured default list name.
   *
   * @param boardId - Trello board ID.
   * @returns List ID to create cards in.
   * @throws When the board has no lists.
   */
  private async resolveListForBoard(boardId: string): Promise<string> {
    const cached = this.listsCache.get(boardId);
    const lists = cached ?? (await this.client.getLists(boardId));

    if (lists.length === 0) {
      throw new Error(`No lists found on Trello board ${boardId}`);
    }

    if (!cached) {
      this.listsCache.set(boardId, lists);
    }

    if (this.defaultListName) {
      const match = lists.find((l) => l.name.toLowerCase() === this.defaultListName!.toLowerCase());
      if (match) return match.id;
    }

    return lists[0]!.id;
  }

  /**
   * Create a Trello card in the resolved list.
   *
   * @param summary - Card title.
   * @param description - Card description.
   * @param _issueType - Ignored; Trello does not use issue types.
   * @param projectKey - Optional board ID override.
   * @returns Card short link and URL.
   * @throws When list resolution or card creation fails.
   */
  async createTask(
    summary: string,
    description: string,
    _issueType: string,
    projectKey?: string,
  ): Promise<CreatedTask> {
    const listId = await this.resolveListId(projectKey);
    const card = await this.client.createCard(summary, description, listId);

    return {
      key: card.shortLink,
      url: card.url,
    };
  }

  /**
   * Add a checklist item on the parent card as a subtask surrogate.
   *
   * @param parentKey - Parent card ID or short link.
   * @param summary - Checklist item title.
   * @param description - Optional item description appended to the name.
   * @param _projectKey - Ignored for subtasks.
   * @returns Composite key and parent card URL.
   * @throws When the parent card is not found or checklist creation fails.
   */
  async createSubtask(
    parentKey: string,
    summary: string,
    description?: string,
    _projectKey?: string,
  ): Promise<CreatedTask> {
    const parentCard = await this.client.getCard(parentKey);
    const checkItem = await this.client.createChecklistItem(parentCard.id, summary, description);

    return {
      key: `${parentKey}-${checkItem.id}`,
      url: parentCard.url,
    };
  }

  /**
   * Link a card to an epic card via a named attachment.
   *
   * @param storyKey - Child card ID or short link.
   * @param epicKey - Epic card ID or short link.
   * @throws When either card is not found or attachment creation fails.
   */
  async linkToEpic(storyKey: string, epicKey: string): Promise<void> {
    const storyCard = await this.client.getCard(storyKey);
    const epicCard = await this.client.getCard(epicKey);
    await this.client.addAttachment(storyCard.id, epicCard.url, "Epic");
  }

  /**
   * List Trello boards as selectable projects.
   *
   * @returns Board ID/name pairs.
   * @throws When the Trello API request fails.
   */
  async getProjects(): Promise<ProjectInfo[]> {
    const boards = await this.client.getBoards();
    return boards.map((b) => ({ key: b.id, name: b.name }));
  }

  /**
   * Return static issue-type labels for UI compatibility.
   *
   * @returns Default type names (not enforced by Trello).
   */
  async getIssueTypes(): Promise<string[]> {
    return ["Task", "Story", "Bug", "Epic"];
  }
}
