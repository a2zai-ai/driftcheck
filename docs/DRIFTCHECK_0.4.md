# DriftCheck 0.4

## Release Theme

DriftCheck 0.4 moves the package from "CI summary output" to actionable regression review for AI builders.

0.3 made AI regression checks visible in GitHub Actions. 0.4 makes the report more useful in a PR by comparing two runs and telling the builder what actually changed.

## What Ships In 0.4

### 1. Regression Diff Command

New command:

```bash
npx @a2zai-ai/driftcheck diff \
  --base .driftcheck/runs/baseline.json \
  --head .driftcheck/runs/latest.json
```

The diff report shows:

- overall score delta
- quality, safety, latency, and cost deltas
- newly failing cases
- recovered cases
- new or removed checks
- biggest score drops, even when they still pass threshold

Why builders care: a single score is not enough during model, prompt, tool, or RAG changes. The useful question is "what regressed since the last known-good run?"

### 2. GitHub Summary Can Include Diff Context

The existing summary command now accepts a base run:

```bash
npx @a2zai-ai/driftcheck summary \
  --run .driftcheck/runs/latest.json \
  --base .driftcheck/runs/baseline.json
```

The GitHub Action also supports:

```yaml
with:
  baseline-run: .driftcheck/runs/baseline.json
```

When provided, the workflow summary includes regression review sections directly in the PR check output.

### 3. Agent Workflow Starter Pack

New starter pack:

```bash
npx @a2zai-ai/driftcheck init --force
```

Adds `.driftcheck/checks/agent-workflows.yml` with coverage for:

- retry or escalation after tool failure
- refusal when permission is missing
- confirmation before sensitive actions
- state consistency across workflow steps

Why builders care: more teams are shipping agents, and agent failures are often workflow failures, not just answer-quality failures.

### 4. Regex-Based Assertions

Pack cases now support:

```yaml
expectedRegex:
  - "manual (review|handoff|escalation)"
forbiddenRegex:
  - "deleting .* now"
```

Why builders care: substring checks are useful, but production behavior often needs pattern checks for IDs, structured action names, confirmations, citations, and refusal language.

### 5. Machine-Readable Output Hooks

The CLI now supports `--json` for check/diff flows and `--output` for writing markdown reports to a custom path.

Examples:

```bash
npx @a2zai-ai/driftcheck check --json --output reports/driftcheck.md
npx @a2zai-ai/driftcheck diff --base baseline.json --head latest.json --json
```

Why builders care: this makes DriftCheck easier to wire into CI, coding agents, custom dashboards, and future hosted A2ZAI proof cards.

## Test Plan

Before publishing:

```bash
npm test
npm run smoke
npx @a2zai-ai/driftcheck diff \
  --base .driftcheck/runs/baseline.json \
  --head .driftcheck/runs/latest.json
npm pack --dry-run
```

## LinkedIn Draft

Shipping DriftCheck 0.4.

0.3 made AI regression checks visible in CI.
0.4 makes them actionable in PR review.

New in this release:

- `driftcheck diff` compares a baseline run against the latest run
- PR summaries can show new regressions, recovered cases, and biggest score drops
- new Agent Workflows starter pack for tool failures, permissions, sensitive actions, and state consistency
- regex assertions for more realistic checks
- `--json` and custom output paths for CI and agent workflows

The main idea: AI builders do not just need another score. They need to know what changed, what regressed, and what is risky to merge.

DriftCheck remains local-first: checks stay in your repo, reports are local by default, and publishing a proof card is opt-in.

Package: `@a2zai-ai/driftcheck`

## Short X/Threads Version

DriftCheck 0.4 is about actionable AI regression review.

New:
- `driftcheck diff`
- PR summaries with new regressions and recovered cases
- Agent Workflows starter pack
- regex assertions
- JSON/custom output for CI

AI builders do not just need a score. They need to know what changed.
