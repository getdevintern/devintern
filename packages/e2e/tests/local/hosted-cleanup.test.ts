import { expect, test } from "bun:test";
import { join } from "node:path";
import { FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand, command } from "../../helpers/process";

test("hosted fixture cleanup deletes only its owned refs and supports the Bitbucket Git username", async () => {
  const run = new FixtureWorkspace("BITBUCKET_TOKEN");
  const remote = join(run.root, "remote.git");
  try {
    await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
    await run.prepare(remote, "test-token", { BITBUCKET_TOKEN: "test-token" }, "x-token-auth");
    await run.git("branch", "keep-this-branch");
    await run.git("push", "origin", "keep-this-branch");
    expect(
      await checkedCommand([run.env.GIT_ASKPASS, "Username for fixture"], run.cwd, run.env),
    ).toBe("x-token-auth");
    await expect(run.deleteRemoteBranch("keep-this-branch")).rejects.toThrow("not owned");
    await run.deleteRemoteBranch(run.base);
    // Cleanup is idempotent when setup failed before pushing a head branch.
    await run.deleteRemoteBranch(run.head);
    await run.deleteRemoteBranch(run.base);
    const gone = await command(
      ["git", "ls-remote", "--exit-code", "origin", `refs/heads/${run.base}`],
      run.cwd,
      run.env,
    );
    expect(gone.exitCode).toBe(2);
    expect(await run.git("ls-remote", "origin", "refs/heads/keep-this-branch")).toContain(
      "refs/heads/keep-this-branch",
    );
  } finally {
    run.dispose();
  }
});
