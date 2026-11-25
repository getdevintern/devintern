Keep this repository's direct dependencies reasonably current without breaking changes. Detect the package manager and workspace layout from the lockfiles and manifests.

0. Read the repository's contributor docs (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, package READMEs) for dependency constraints, such as exact-version pins or packages with a special release process, and leave those packages alone. Deduplicate: if an open pull request from this automation (search open PRs whose title contains this automation's id, the task title above) or another open dependency PR already covers a package, skip that package.

1. List outdated direct dependencies across every workspace or module (for example `npm outdated --workspaces`, `pnpm outdated -r`, `bun outdated`, `pip list --outdated`, `cargo outdated`, `go list -u -m all`).

2. Upgrade only within the current major version (for 0.x packages, only within the current minor). Never cross a major. Group packages that are released together (the same scope or family, such as a framework with its types and plugins) into one upgrade, and pick at most 5 groups, preferring the largest version lag. Respect any configured minimum release age or quarantine setting; never bypass it.

3. Run each update in the workspace that declares the dependency, so workspace packages are not skipped by a bare root update.

4. Verify with the repository's documented install (with a frozen lockfile), build, lint, typecheck, and test commands. If a group causes a failure, drop that group and verify the rest again. Never leave a broken lockfile.

5. If nothing is outdated within range, make no changes and report that. List the available major upgrades for information only.

Security advisories belong to a separate pass; fix one here only when an in-range upgrade happens to resolve it. The pipeline commits your changes and opens a pull request. Report each group upgraded (package, workspace, from and to version), each group dropped and why, the available major upgrades, and the verification results.
