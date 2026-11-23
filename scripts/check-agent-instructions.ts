// AGENTS.md is the single agent instruction file in this repo. Claude Code
// loads only CLAUDE.md when both exist in a directory, so a tracked CLAUDE.md
// silently shadows AGENTS.md for Claude and lets the two drift apart.
const result = Bun.spawnSync(["git", "ls-files", "-z"]);
if (result.exitCode !== 0) {
  console.error(result.stderr.toString());
  process.exit(result.exitCode ?? 1);
}

const offenders = result.stdout
  .toString()
  .split("\0")
  .filter((path) => /(^|\/)CLAUDE\.md$/.test(path));

if (offenders.length > 0) {
  console.error(
    `Tracked CLAUDE.md found; put agent instructions in AGENTS.md instead:\n${offenders.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}
