/**
 * `git clean` arguments used everywhere the tool wipes a working directory.
 * DevIntern keeps all of its state in `~/.devintern`, so nothing in a
 * checkout needs protecting from the clean.
 */
export const GIT_CLEAN_ARGS = ["clean", "-fd"];
