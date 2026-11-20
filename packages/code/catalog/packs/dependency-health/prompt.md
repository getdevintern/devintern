# Dependency health

Review the project's declared dependencies and their available updates.

1. Using the project's own tooling, list outdated dependencies and known
   vulnerabilities.
2. If a vulnerability has a safe, non-major fix, apply that fix. Otherwise pick
   at most **one** outdated dependency and upgrade it within the same major
   version.
3. Run the project's test suite and any documented verification command.
4. If anything breaks and cannot be fixed with a small, in-scope change, revert
   the upgrade and report what you tried.

Scope this run to a single dependency change. Do not reformat unrelated files,
do not upgrade across major versions, and do not add new dependencies.
