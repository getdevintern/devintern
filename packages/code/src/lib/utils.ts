// oxlint-disable-next-line import/no-unassigned-import -- registers the general domain's methods on the shared Utils registry
import "./utils/general";
// oxlint-disable-next-line import/no-unassigned-import -- registers the git-exec domain's methods on the shared Utils registry
import "./utils/git-exec";
// oxlint-disable-next-line import/no-unassigned-import -- registers the git-branch domain's methods on the shared Utils registry
import "./utils/git-branch";
// oxlint-disable-next-line import/no-unassigned-import -- registers the git-commit-push domain's methods on the shared Utils registry
import "./utils/git-commit-push";
// oxlint-disable-next-line import/no-unassigned-import -- registers the git-hooks domain's methods on the shared Utils registry
import "./utils/git-hooks";
// oxlint-disable-next-line import/no-unassigned-import -- registers the feature-branch domain's methods on the shared Utils registry
import "./utils/feature-branch";
// oxlint-disable-next-line import/no-unassigned-import -- registers the review-worktree domain's methods on the shared Utils registry
import "./utils/review-worktree";
// oxlint-disable-next-line import/no-unassigned-import -- registers the worktree-setup domain's methods on the shared Utils registry
import "./utils/worktree-setup";

export { GIT_CLEAN_ARGS } from "./utils/constants";
export { Utils } from "./utils/registry";
