/**
 * `git clean` arguments used everywhere the tool wipes a working directory.
 *
 * `.devintern-code/` is excluded on purpose: it holds durable state (the
 * `queue.db` SQLite database with run records, webhook queue, and worker
 * cursors) and is not gitignored in every project. Deleting it mid-run pulls
 * the database file — and its rollback journal directory — out from under an
 * open connection, so the next write fails with "disk I/O error".
 */
export const GIT_CLEAN_ARGS = ["clean", "-fd", "-e", ".devintern-code"];
