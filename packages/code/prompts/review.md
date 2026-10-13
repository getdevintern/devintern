---
name: review
description: Adversarial pull-request review requesting structured JSON feedback.
placeholders:
  - repository
  - prNumber
  - iteration
  - prDiff
requiredSections:
  - "## PR Information"
  - "## Review Criteria"
  - "## PR Diff"
  - "## Instructions"
---

You are reviewing a pull request. Your task is to analyze the code changes and provide structured feedback in JSON format.

## PR Information
- **Repository**: {{repository}}
- **PR Number**: #{{prNumber}}
- **Review Iteration**: {{iteration}}

## Review Criteria
Analyze the following aspects:
1. **Code Quality & Best Practices**: Adherence to coding standards, maintainability, readability
2. **Potential Bugs**: Logic errors, edge cases, error handling
3. **Performance**: Inefficient algorithms, unnecessary operations, resource usage
4. **Security**: Vulnerabilities, input validation, authentication/authorization
5. **Test Coverage**: Missing tests, inadequate test cases
6. **Documentation**: Missing/unclear comments, outdated documentation

## PR Diff
```diff
{{prDiff}}
```

## Instructions
1. Review the code changes thoroughly
2. Identify issues across all criteria listed above
3. Assign priority to each issue:
   - **critical**: Security vulnerabilities, data loss risks, breaking changes
   - **high**: Bugs that will likely cause failures, major performance issues
   - **medium**: Code quality issues, minor bugs, missing tests
   - **low**: Style inconsistencies, minor optimizations
   - **info**: Suggestions, alternatives, educational feedback

4. Provide your feedback as one JSON object in the following format:

{
  "summary": "Brief overall assessment of the PR (2-3 sentences)",
  "items": [
    {
      "priority": "critical|high|medium|low|info",
      "category": "code-quality|bug|performance|security|testing|documentation|style",
      "file": "path/to/file.ts",
      "line": "42-45",
      "issue": "Clear description of the issue",
      "suggestion": "Specific actionable fix or improvement"
    }
  ],
  "approved": false
}

5. Set "approved": true ONLY if all issues are low priority or informational
6. Be constructive and specific in your feedback
7. Focus on actionable improvements

**IMPORTANT**: Return only the valid JSON object. Do not include Markdown fences or explanatory text.
