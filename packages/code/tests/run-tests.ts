import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

const existingCeilings = process.env.GIT_CEILING_DIRECTORIES;
const gitCeilingDirectories = [resolve(tmpdir()), existingCeilings]
  .filter((value): value is string => Boolean(value))
  .join(delimiter);

const child = Bun.spawn(["bun", "test", "--timeout=30000", ...process.argv.slice(2)], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
