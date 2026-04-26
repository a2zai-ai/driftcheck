# DriftCheck by A2ZAI

Local-first regression intelligence for AI builders.

DriftCheck helps catch behavior drift when prompts, tools, RAG flows, SDKs, or models change. It runs locally first, writes JSON and markdown reports, and publishes a hosted proof card only when you choose.

## Quick Start

```bash
npx @a2zai-ai/driftcheck init
npx @a2zai-ai/driftcheck check
```

During local package development:

```bash
npm install
npm run smoke
```

DriftCheck creates:

- `.driftcheck/checks/*.yml` starter packs
- `.driftcheck/runs/latest.json`
- `driftcheck-report.md`

## Starter Packs

- **Tool-Calling Reliability**: schema-valid tool arguments, safe fallback behavior, and hallucinated tools.
- **RAG Faithfulness**: grounded answers, citations, missing-context refusal, and source scope.
- **Model Migration**: quality, cost, latency, and safety drift when moving between models.

To also write a live model comparison pack:

```bash
npx @a2zai-ai/driftcheck init --live
```

## Run One Pack

```bash
npx @a2zai-ai/driftcheck check --pack tool-calling
npx @a2zai-ai/driftcheck check --pack rag-faithfulness
npx @a2zai-ai/driftcheck check --pack model-migration
```

## Override Models From The CLI

For packs with a live `execution` block, you can override the baseline and candidate models without editing YAML:

```bash
OPENAI_API_KEY="sk-..." npx @a2zai-ai/driftcheck check \
  --pack model-migration \
  --baseline-model gpt-4o-mini \
  --candidate-model gpt-4.1-mini
```

The same values can be set with environment variables:

```bash
DRIFTCHECK_BASELINE_MODEL=gpt-4o-mini \
DRIFTCHECK_CANDIDATE_MODEL=gpt-4.1-mini \
OPENAI_API_KEY="sk-..." \
npx @a2zai-ai/driftcheck check --pack model-migration
```

Static packs still run without API keys. Model overrides only affect packs that define `execution.provider`.

## One-Command Live Compare

Use `compare` when you want to check a model migration without editing YAML first:

```bash
OPENAI_API_KEY="sk-..." npx @a2zai-ai/driftcheck compare \
  --baseline-model gpt-4o-mini \
  --candidate-model gpt-4.1-mini
```

This runs the built-in Live Model Compare pack and writes the same `.driftcheck/runs/latest.json` and `driftcheck-report.md` outputs.

## Publish A Proof Card

Publishing is explicit. Reports stay local unless you run `publish`.

```bash
DRIFTCHECK_TOKEN="paste-token-here" npx @a2zai-ai/driftcheck publish --run .driftcheck/runs/latest.json --public
```

The hosted proof layer currently lives at A2ZAI:

```bash
DRIFTCHECK_API_URL="https://www.a2zai.ai" npx @a2zai-ai/driftcheck publish --run .driftcheck/runs/latest.json --public
```

## Pack Format

Packs live in `.driftcheck/checks/*.yml`.

```yaml
id: tool-calling
name: Tool-Calling Reliability
category: tool-calling
description: Catch schema drift, hallucinated tool calls, and weak fallback behavior before agent changes ship.
cases:
  - name: Valid tool arguments
    dimension: quality
    weight: 3
    threshold: 80
    baselineOutput: "call_tool({ user: 'acct_123', action: 'refund_review' })"
    candidateOutput: "call_tool({ userId: 'acct_123', action: 'refund_review' })"
    expectedContains:
      - userId
      - action
    forbiddenContains:
      - malformed
      - undefined
```

Supported categories:

- `tool-calling`
- `rag-faithfulness`
- `model-migration`

Supported score dimensions:

- `quality`
- `safety`
- `latency`
- `cost`

## Live Model Execution

Static outputs work without API keys. To compare live OpenAI model responses, add an `execution` block and set `OPENAI_API_KEY`.

```yaml
execution:
  provider: openai
  baselineModel: gpt-4o-mini
  candidateModel: gpt-4.1-mini
  temperature: 0
  maxTokens: 140
```

## GitHub Action

After this repo is public, use:

```yaml
name: DriftCheck

on:
  pull_request:

jobs:
  driftcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: a2zai-ai/driftcheck@v0
        with:
          fail-threshold: 70
          baseline-model: gpt-4o-mini
          candidate-model: gpt-4.1-mini
```

## Privacy

DriftCheck is local-first:

- Pack files stay in your repo.
- Reports are written locally.
- Publish is opt-in.
- Known secret patterns are redacted from generated reports before publish.

## Roadmap

- npm package publication as `@a2zai-ai/driftcheck`
- standalone `a2zai-ai/driftcheck` public repo
- richer GitHub Action summaries
- more starter packs for agents, support bots, coding workflows, and RAG apps
