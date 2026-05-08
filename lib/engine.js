/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { parse: parseYaml } = require('yaml');

const VALID_CATEGORIES = new Set(['tool-calling', 'rag-faithfulness', 'model-migration', 'agent-workflows', 'all']);
const VALID_DIMENSIONS = new Set(['quality', 'safety', 'latency', 'cost']);
const SCORE_DIMENSIONS = ['quality', 'safety', 'latency', 'cost'];

function readGitValue(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function getProject(cwd) {
  const repoUrl = readGitValue(['config', '--get', 'remote.origin.url'], cwd);
  const commit = readGitValue(['rev-parse', 'HEAD'], cwd);
  const root = readGitValue(['rev-parse', '--show-toplevel'], cwd) || cwd;
  return { name: path.basename(root), repoUrl, commit };
}

function redactText(value, redactions) {
  if (typeof value !== 'string') return value;
  const patterns = [
    { label: 'openai_key', regex: /sk-[A-Za-z0-9_-]{20,}/g },
    { label: 'github_token', regex: /(ghp_|github_pat_)[A-Za-z0-9_]{20,}/g },
    { label: 'slack_token', regex: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
    { label: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g }
  ];
  let output = value;
  for (const pattern of patterns) {
    if (pattern.regex.test(output)) {
      redactions.add(pattern.label);
      output = output.replace(pattern.regex, `[REDACTED:${pattern.label}]`);
    }
  }
  return output;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function includesAll(text, values) {
  const lower = String(text || '').toLowerCase();
  return values.every((item) => lower.includes(String(item).toLowerCase()));
}

function includesAny(text, values) {
  const lower = String(text || '').toLowerCase();
  return values.some((item) => lower.includes(String(item).toLowerCase()));
}

function matchesAll(text, patterns) {
  return patterns.every((pattern) => buildRegex(pattern).test(String(text || '')));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => buildRegex(pattern).test(String(text || '')));
}

function buildRegex(pattern) {
  if (pattern instanceof RegExp) return pattern;
  return new RegExp(String(pattern), 'i');
}

function scoreOutput(output, rules) {
  if (!output && typeof rules.candidate !== 'number') return 0;
  let score = typeof rules.candidate === 'number' ? Number(rules.candidate) : 100;
  const expected = Array.isArray(rules.expectedContains) ? rules.expectedContains : [];
  const forbidden = Array.isArray(rules.forbiddenContains) ? rules.forbiddenContains : [];
  const expectedRegex = Array.isArray(rules.expectedRegex) ? rules.expectedRegex : [];
  const forbiddenRegex = Array.isArray(rules.forbiddenRegex) ? rules.forbiddenRegex : [];
  for (const item of expected) {
    if (!includesAll(output, [item])) score -= 16;
  }
  if (forbidden.length > 0 && includesAny(output, forbidden)) score -= 24;
  if (expectedRegex.length > 0 && !matchesAll(output, expectedRegex)) score -= 18;
  if (forbiddenRegex.length > 0 && matchesAny(output, forbiddenRegex)) score -= 26;
  if (typeof rules.maxOutputChars === 'number' && String(output || '').length > rules.maxOutputChars) score -= 14;
  if (typeof rules.minOutputChars === 'number' && String(output || '').length < rules.minOutputChars) score -= 10;
  return clampScore(score);
}

async function runOpenAICompletion(execution, item) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for packs with execution.provider=openai.');
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: item.model,
      temperature: typeof execution.temperature === 'number' ? execution.temperature : 0,
      max_tokens: typeof execution.maxTokens === 'number' ? execution.maxTokens : 300,
      messages: [...(item.system ? [{ role: 'system', content: item.system }] : []), { role: 'user', content: item.input }]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `OpenAI request failed with status ${response.status}.`);
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

async function maybeExecuteCase(pack, item, options = {}) {
  if (!pack.execution || !item.input) return item;
  const execution = applyExecutionOverrides(pack.execution, options.modelOverrides);
  if (execution.provider !== 'openai') throw new Error(`Unsupported execution provider: ${execution.provider}`);
  const system = item.system || execution.system;
  const [baselineOutput, candidateOutput] = await Promise.all([
    execution.baselineModel
      ? runOpenAICompletion(execution, { model: execution.baselineModel, system, input: item.input })
      : Promise.resolve(item.baselineOutput || ''),
    execution.candidateModel
      ? runOpenAICompletion(execution, { model: execution.candidateModel, system, input: item.input })
      : Promise.resolve(item.candidateOutput || '')
  ]);
  return { ...item, baselineOutput: baselineOutput || item.baselineOutput, candidateOutput: candidateOutput || item.candidateOutput };
}

function applyExecutionOverrides(execution, overrides = {}) {
  if (!overrides.baselineModel && !overrides.candidateModel) return execution;
  return {
    ...execution,
    ...(overrides.baselineModel ? { baselineModel: overrides.baselineModel } : {}),
    ...(overrides.candidateModel ? { candidateModel: overrides.candidateModel } : {})
  };
}

function validatePack(pack, source) {
  if (!pack || typeof pack !== 'object') throw new Error(`${source}: pack must be an object.`);
  if (!pack.id || typeof pack.id !== 'string') throw new Error(`${source}: pack.id is required.`);
  if (!pack.name || typeof pack.name !== 'string') throw new Error(`${source}: pack.name is required.`);
  if (!VALID_CATEGORIES.has(pack.category)) throw new Error(`${source}: pack.category must be one of ${Array.from(VALID_CATEGORIES).join(', ')}.`);
  if (!Array.isArray(pack.cases) || pack.cases.length === 0) throw new Error(`${source}: pack.cases must contain at least one case.`);
  pack.cases.forEach((item, index) => {
    if (!item.name) throw new Error(`${source}: cases[${index}].name is required.`);
    if (!VALID_DIMENSIONS.has(item.dimension)) throw new Error(`${source}: cases[${index}].dimension must be quality, safety, latency, or cost.`);
    if (typeof item.weight !== 'number') throw new Error(`${source}: cases[${index}].weight must be a number.`);
    validateRegexList(item.expectedRegex, `${source}: cases[${index}].expectedRegex`);
    validateRegexList(item.forbiddenRegex, `${source}: cases[${index}].forbiddenRegex`);
  });
  return pack;
}

function validateRegexList(value, label) {
  if (typeof value === 'undefined') return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  value.forEach((pattern, index) => {
    try {
      buildRegex(pattern);
    } catch (error) {
      throw new Error(`${label}[${index}] is not a valid regular expression: ${error.message}`);
    }
  });
}

function loadPack(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return validatePack(parseYaml(text), filePath);
}

async function runPack(pack, project, createdAt, options = {}) {
  const redactions = new Set();
  const cases = [];
  const execution = pack.execution ? applyExecutionOverrides(pack.execution, options.modelOverrides) : null;
  for (const originalCase of pack.cases) {
    const item = await maybeExecuteCase(pack, originalCase, options);
    const baselineOutput = redactText(item.baselineOutput || '', redactions);
    const candidateOutput = redactText(item.candidateOutput || '', redactions);
    const baselineScore = typeof item.baseline === 'number' ? clampScore(item.baseline) : scoreOutput(baselineOutput, { ...item, candidate: undefined });
    const candidateScore = scoreOutput(candidateOutput, item);
    const threshold = typeof item.threshold === 'number' ? item.threshold : 75;
    const passed = candidateScore >= threshold;
    cases.push({
      packId: pack.id,
      packName: pack.name,
      name: item.name,
      dimension: item.dimension,
      weight: item.weight,
      baseline: baselineScore,
      candidate: candidateScore,
      score: candidateScore,
      delta: candidateScore - baselineScore,
      threshold,
      passed,
      notes: item.notes || '',
      failureExample: passed ? '' : item.failureExample || candidateOutput || item.notes || 'Candidate output did not satisfy this check.',
      baselineOutput,
      candidateOutput
    });
  }
  return {
    schemaVersion: '1',
    project,
    pack: { id: pack.id, name: pack.name, category: pack.category },
    ...(execution
      ? {
          execution: {
            provider: execution.provider,
            baselineModel: execution.baselineModel || '',
            candidateModel: execution.candidateModel || ''
          }
        }
      : {}),
    scores: summarizeScores(cases),
    cases,
    redactions: Array.from(redactions),
    createdAt
  };
}

function summarizeScores(cases) {
  const byDimension = {};
  for (const dimension of SCORE_DIMENSIONS) byDimension[dimension] = weightedAverage(cases.filter((item) => item.dimension === dimension));
  return { overall: weightedAverage(cases), quality: byDimension.quality, safety: byDimension.safety, latency: byDimension.latency, cost: byDimension.cost };
}

function weightedAverage(cases) {
  const totalWeight = cases.reduce((sum, item) => sum + Number(item.weight || 1), 0);
  if (totalWeight <= 0) return 0;
  const total = cases.reduce((sum, item) => sum + Number(item.score || item.candidate || 0) * Number(item.weight || 1), 0);
  return clampScore(total / totalWeight);
}

function combineReports(reports, project, createdAt) {
  if (reports.length === 1) return reports[0];
  const cases = reports.flatMap((report) => report.cases);
  return {
    schemaVersion: '1',
    project,
    pack: { id: 'all', name: 'DriftCheck Starter Packs', category: 'all' },
    scores: summarizeScores(cases),
    cases,
    redactions: Array.from(new Set(reports.flatMap((report) => report.redactions || []))),
    createdAt
  };
}

function renderMarkdown(report) {
  const failed = report.cases.filter((item) => !item.passed);
  const lines = [
    '# DriftCheck Report',
    '',
    `Project: ${report.project.name || 'unknown'}`,
    `Pack: ${report.pack.name}`,
    `Created: ${report.createdAt}`,
    '',
    '## Scores',
    '',
    '| Dimension | Score |',
    '| --- | ---: |',
    `| Overall | ${report.scores.overall} |`,
    `| Quality | ${report.scores.quality} |`,
    `| Safety | ${report.scores.safety} |`,
    `| Latency | ${report.scores.latency} |`,
    `| Cost | ${report.scores.cost} |`,
    '',
    '## Cases',
    '',
    '| Case | Pack | Dimension | Score | Threshold | Result |',
    '| --- | --- | --- | ---: | ---: | --- |',
    ...report.cases.map((item) =>
      `| ${escapeMarkdown(item.name)} | ${escapeMarkdown(item.packName || report.pack.name)} | ${item.dimension} | ${item.score} | ${item.threshold} | ${item.passed ? 'pass' : 'review'} |`
    ),
    ''
  ];
  if (failed.length > 0) {
    lines.push('## Needs Review', '');
    failed.forEach((item) => lines.push(`- ${item.name}: ${item.failureExample || item.notes || 'Candidate did not satisfy the check.'}`));
    lines.push('');
  }
  if (report.redactions?.length) lines.push('## Redactions', '', `DriftCheck redacted: ${report.redactions.join(', ')}`, '');
  return lines.join('\n');
}

function renderGithubSummary(report, options = {}) {
  const threshold = typeof options.failThreshold === 'number' ? options.failThreshold : 70;
  const failed = report.cases.filter((item) => !item.passed);
  const passing = report.cases.length - failed.length;
  const status = report.scores.overall >= threshold && failed.length === 0 ? 'Passing' : 'Needs review';
  const lines = [
    '# DriftCheck Summary',
    '',
    `**Status:** ${status}`,
    `**Overall:** ${report.scores.overall}/100`,
    `**Pack:** ${report.pack.name}`,
    `**Project:** ${report.project.name || 'unknown'}`,
    ''
  ];

  if (report.execution?.baselineModel || report.execution?.candidateModel) {
    lines.push(
      `**Models:** ${report.execution.baselineModel || 'baseline'} → ${report.execution.candidateModel || 'candidate'}`,
      ''
    );
  }

  lines.push(
    '## Scores',
    '',
    '| Dimension | Score |',
    '| --- | ---: |',
    `| Overall | ${report.scores.overall} |`,
    `| Quality | ${report.scores.quality} |`,
    `| Safety | ${report.scores.safety} |`,
    `| Latency | ${report.scores.latency} |`,
    `| Cost | ${report.scores.cost} |`,
    '',
    '## Cases',
    '',
    `- Passing: ${passing}`,
    `- Needs review: ${failed.length}`,
    ''
  );

  if (failed.length > 0) {
    lines.push('## Needs Review', '');
    failed.slice(0, 8).forEach((item) => {
      lines.push(`- **${escapeMarkdown(item.name)}** (${item.dimension}, ${item.score}/${item.threshold}): ${escapeMarkdown(item.failureExample || item.notes || 'Candidate did not satisfy the check.')}`);
    });
    if (failed.length > 8) lines.push(`- ${failed.length - 8} more cases need review.`);
    lines.push('');
  }

  if (report.redactions?.length) {
    lines.push('## Redactions', '', `DriftCheck redacted: ${report.redactions.join(', ')}`, '');
  }

  if (options.diff) {
    lines.push(...renderDiffSummarySection(options.diff));
  }

  return lines.join('\n');
}

function diffReports(baseReport, headReport) {
  if (!baseReport || !headReport) throw new Error('diffReports requires base and head reports.');
  const baseCases = new Map(baseReport.cases.map((item) => [caseKey(item), item]));
  const headCases = new Map(headReport.cases.map((item) => [caseKey(item), item]));
  const matched = [];
  const newCases = [];
  const removedCases = [];

  for (const [key, headCase] of headCases.entries()) {
    const baseCase = baseCases.get(key);
    if (!baseCase) {
      newCases.push(toCaseSnapshot(headCase));
      continue;
    }
    matched.push({
      key,
      name: headCase.name,
      packId: headCase.packId || headReport.pack?.id || '',
      packName: headCase.packName || headReport.pack?.name || '',
      dimension: headCase.dimension,
      baselineScore: Number(baseCase.score ?? baseCase.candidate ?? 0),
      headScore: Number(headCase.score ?? headCase.candidate ?? 0),
      delta: Number(headCase.score ?? headCase.candidate ?? 0) - Number(baseCase.score ?? baseCase.candidate ?? 0),
      threshold: Number(headCase.threshold || baseCase.threshold || 0),
      wasPassing: Boolean(baseCase.passed),
      isPassing: Boolean(headCase.passed),
      failureExample: headCase.failureExample || headCase.notes || ''
    });
  }

  for (const [key, baseCase] of baseCases.entries()) {
    if (!headCases.has(key)) removedCases.push(toCaseSnapshot(baseCase));
  }

  const newRegressions = matched
    .filter((item) => item.wasPassing && !item.isPassing)
    .sort((a, b) => a.delta - b.delta);
  const recovered = matched
    .filter((item) => !item.wasPassing && item.isPassing)
    .sort((a, b) => b.delta - a.delta);
  const biggestDrops = matched
    .filter((item) => item.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 8);

  return {
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    project: headReport.project || baseReport.project || {},
    base: reportSnapshot(baseReport),
    head: reportSnapshot(headReport),
    scores: {
      overallDelta: scoreDelta(baseReport.scores?.overall, headReport.scores?.overall),
      dimensions: Object.fromEntries(SCORE_DIMENSIONS.map((dimension) => [dimension, scoreDelta(baseReport.scores?.[dimension], headReport.scores?.[dimension])]))
    },
    newRegressions,
    recovered,
    biggestDrops,
    newCases,
    removedCases
  };
}

function caseKey(item) {
  return `${item.packId || item.packName || ''}::${item.name || ''}::${item.dimension || ''}`.toLowerCase();
}

function toCaseSnapshot(item) {
  return {
    name: item.name,
    packId: item.packId || '',
    packName: item.packName || '',
    dimension: item.dimension,
    score: Number(item.score ?? item.candidate ?? 0),
    threshold: Number(item.threshold || 0),
    passed: Boolean(item.passed)
  };
}

function reportSnapshot(report) {
  return {
    createdAt: report.createdAt || '',
    pack: report.pack || {},
    overall: Number(report.scores?.overall || 0),
    scores: {
      overall: Number(report.scores?.overall || 0),
      quality: Number(report.scores?.quality || 0),
      safety: Number(report.scores?.safety || 0),
      latency: Number(report.scores?.latency || 0),
      cost: Number(report.scores?.cost || 0)
    },
    caseCount: Array.isArray(report.cases) ? report.cases.length : 0
  };
}

function scoreDelta(baseScore, headScore) {
  return Number(headScore || 0) - Number(baseScore || 0);
}

function renderDiffMarkdown(diff) {
  const lines = [
    '# DriftCheck Diff',
    '',
    `Project: ${diff.project?.name || 'unknown'}`,
    `Base: ${diff.base.createdAt || 'unknown'} (${diff.base.pack.name || diff.base.pack.id || 'run'})`,
    `Head: ${diff.head.createdAt || 'unknown'} (${diff.head.pack.name || diff.head.pack.id || 'run'})`,
    '',
    '## Score Delta',
    '',
    '| Dimension | Base | Head | Delta |',
    '| --- | ---: | ---: | ---: |',
    `| Overall | ${diff.base.overall} | ${diff.head.overall} | ${formatDelta(diff.scores.overallDelta)} |`,
    ...SCORE_DIMENSIONS.map((dimension) => {
      const base = Number(diff.base?.scores?.[dimension] || 0);
      const head = Number(diff.head?.scores?.[dimension] || 0);
      return `| ${titleCase(dimension)} | ${base} | ${head} | ${formatDelta(diff.scores.dimensions[dimension])} |`;
    }),
    ''
  ];

  lines.push(...renderDiffSummarySection(diff));
  return lines.join('\n');
}

function renderDiffSummarySection(diff) {
  const lines = [
    '## Regression Review',
    '',
    `- New regressions: ${diff.newRegressions.length}`,
    `- Recovered cases: ${diff.recovered.length}`,
    `- New cases: ${diff.newCases.length}`,
    `- Removed cases: ${diff.removedCases.length}`,
    ''
  ];

  if (diff.newRegressions.length > 0) {
    lines.push('### New Regressions', '');
    diff.newRegressions.slice(0, 8).forEach((item) => {
      lines.push(`- **${escapeMarkdown(item.name)}** (${item.dimension}): ${item.baselineScore} → ${item.headScore} (${formatDelta(item.delta)})`);
    });
    lines.push('');
  }

  if (diff.recovered.length > 0) {
    lines.push('### Recovered', '');
    diff.recovered.slice(0, 8).forEach((item) => {
      lines.push(`- **${escapeMarkdown(item.name)}** (${item.dimension}): ${item.baselineScore} → ${item.headScore} (${formatDelta(item.delta)})`);
    });
    lines.push('');
  }

  if (diff.biggestDrops.length > 0) {
    lines.push('### Biggest Drops', '');
    diff.biggestDrops.slice(0, 8).forEach((item) => {
      lines.push(`- **${escapeMarkdown(item.name)}** (${item.dimension}): ${formatDelta(item.delta)} points`);
    });
    lines.push('');
  }

  lines.push('### Suggested Next Checks', '');
  if (diff.newRegressions.length > 0) {
    lines.push('- Review the candidate output for each new regression before merging.');
  }
  if (diff.biggestDrops.length > 0) {
    lines.push('- Inspect the largest score drops even when they still pass threshold.');
  }
  if (diff.newCases.length > 0) {
    lines.push('- Confirm new checks reflect real production risks and are not duplicate coverage.');
  }
  if (diff.newRegressions.length === 0 && diff.biggestDrops.length === 0 && diff.newCases.length === 0 && diff.removedCases.length === 0) {
    lines.push('- No new regression pattern found. Keep the run as a baseline candidate if it reflects production behavior.');
  }
  lines.push('');

  return lines;
}

function formatDelta(value) {
  const delta = Number(value || 0);
  return delta > 0 ? `+${delta}` : String(delta);
}

function titleCase(value) {
  return String(value || '').slice(0, 1).toUpperCase() + String(value || '').slice(1);
}

function escapeMarkdown(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = {
  combineReports,
  diffReports,
  getProject,
  loadPack,
  renderDiffMarkdown,
  renderGithubSummary,
  renderMarkdown,
  runPack,
  scoreOutput,
  validatePack
};
