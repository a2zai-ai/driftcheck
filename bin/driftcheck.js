#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { LIVE_MODEL_COMPARE_PACK, LIVE_PACKS, STARTER_PACKS } = require('../lib/starter-packs');
const { combineReports, diffReports, getProject, loadPack, renderDiffMarkdown, renderGithubSummary, renderMarkdown, runPack } = require('../lib/engine');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === 'force' || key === 'live' || key === 'public' || key === 'json') {
      args[key] = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileIfSafe(filePath, content, force) {
  if (!force && fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function printHelp() {
  console.log(`DriftCheck local-first regression intelligence for AI builders

Usage:
  driftcheck init [--force] [--live]
  driftcheck check [--pack tool-calling] [--baseline-model gpt-4o-mini] [--candidate-model gpt-4.1-mini] [--json] [--output driftcheck-report.md]
  driftcheck compare --baseline-model gpt-4o-mini --candidate-model gpt-4.1-mini
  driftcheck diff --base .driftcheck/runs/baseline.json --head .driftcheck/runs/latest.json [--json] [--output driftcheck-diff.md]
  driftcheck summary [--run .driftcheck/runs/latest.json] [--base .driftcheck/runs/baseline.json] [--fail-threshold 70]
  driftcheck publish --run .driftcheck/runs/latest.json [--public]

Environment:
  OPENAI_API_KEY        Required only for packs with execution.provider=openai
  DRIFTCHECK_API_URL    Defaults to https://www.a2zai.ai
  DRIFTCHECK_TOKEN      Optional publish token
  A2ZAI_API_URL         Also accepted for hosted A2ZAI publish
  A2ZAI_TOKEN           Also accepted as a publish token
  A2ZAI_PUBLISH_TOKEN   Also accepted as a publish token
`);
}

function getModelOverrides(args) {
  return {
    baselineModel: args['baseline-model'] || process.env.DRIFTCHECK_BASELINE_MODEL || '',
    candidateModel: args['candidate-model'] || process.env.DRIFTCHECK_CANDIDATE_MODEL || '',
  };
}

function writeInfo(args, message) {
  if (args.json) {
    console.error(message);
    return;
  }
  console.log(message);
}

function init(args) {
  const cwd = process.cwd();
  const checksDir = path.join(cwd, '.driftcheck', 'checks');
  ensureDir(checksDir);
  let written = 0;
  const packs = args.live ? [...STARTER_PACKS, ...LIVE_PACKS] : STARTER_PACKS;
  for (const pack of packs) {
    const didWrite = writeFileIfSafe(path.join(checksDir, pack.filename), pack.yaml, Boolean(args.force));
    if (didWrite) written += 1;
  }
  console.log(`DriftCheck initialized ${written} starter pack${written === 1 ? '' : 's'} in .driftcheck/checks.`);
  console.log('Run: driftcheck check');
  if (!args.live) console.log('For live model comparison packs, run: driftcheck init --live');
}

function findPackFiles(cwd) {
  const checksDir = path.join(cwd, '.driftcheck', 'checks');
  if (!fs.existsSync(checksDir)) throw new Error('No .driftcheck/checks directory found. Run `driftcheck init` first.');
  return fs
    .readdirSync(checksDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(checksDir, name));
}

async function check(args) {
  const cwd = process.cwd();
  const project = getProject(cwd);
  const createdAt = new Date().toISOString();
  const selected = args.pack ? String(args.pack).toLowerCase() : '';
  const packs = findPackFiles(cwd)
    .map(loadPack)
    .filter((pack) => {
      if (!selected) return true;
      return [pack.id, pack.name, pack.category].some((value) => String(value || '').toLowerCase() === selected);
    });

  if (packs.length === 0) throw new Error(`No pack matched "${selected}".`);

  const reports = [];
  const modelOverrides = getModelOverrides(args);
  for (const pack of packs) {
    writeInfo(args, `Running ${pack.name}...`);
    reports.push(await runPack(pack, project, createdAt, { modelOverrides }));
  }

  const report = combineReports(reports, project, createdAt);
  writeReport(cwd, report, createdAt, args);
}

async function compare(args) {
  const cwd = process.cwd();
  const project = getProject(cwd);
  const createdAt = new Date().toISOString();
  const modelOverrides = getModelOverrides(args);
  if (!modelOverrides.baselineModel || !modelOverrides.candidateModel) {
    throw new Error('compare requires --baseline-model and --candidate-model.');
  }
  const pack = loadInlinePack(LIVE_MODEL_COMPARE_PACK);
  writeInfo(args, `Comparing ${modelOverrides.baselineModel} → ${modelOverrides.candidateModel}...`);
  const report = await runPack(pack, project, createdAt, { modelOverrides });
  writeReport(cwd, report, createdAt, args);
}

function loadInlinePack(pack) {
  const tmpDir = path.join(process.cwd(), '.driftcheck', 'tmp');
  ensureDir(tmpDir);
  const filePath = path.join(tmpDir, pack.filename);
  fs.writeFileSync(filePath, pack.yaml, 'utf8');
  return loadPack(filePath);
}

function writeReport(cwd, report, createdAt, args = {}) {
  const runsDir = path.join(cwd, '.driftcheck', 'runs');
  ensureDir(runsDir);
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const runPath = path.join(runsDir, `${timestamp}-${report.pack.id}.json`);
  const latestPath = path.join(runsDir, 'latest.json');
  const markdownPath = path.resolve(cwd, args.output || 'driftcheck-report.md');
  ensureDir(path.dirname(markdownPath));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(runPath, json, 'utf8');
  fs.writeFileSync(latestPath, json, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  writeInfo(args, `Score: ${report.scores.overall}/100`);
  writeInfo(args, `Wrote ${path.relative(cwd, latestPath)} and ${path.relative(cwd, markdownPath)}`);
  if (args.json) console.log(json.trim());
}

async function publish(args) {
  const cwd = process.cwd();
  const runPath = path.resolve(cwd, args.run || path.join('.driftcheck', 'runs', 'latest.json'));
  if (!fs.existsSync(runPath)) throw new Error(`Run report not found: ${runPath}`);
  const apiUrl = (process.env.DRIFTCHECK_API_URL || process.env.A2ZAI_API_URL || 'https://www.a2zai.ai').replace(/\/+$/, '');
  const token = process.env.DRIFTCHECK_TOKEN || process.env.A2ZAI_TOKEN || process.env.A2ZAI_PUBLISH_TOKEN || '';
  const report = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const response = await fetch(`${apiUrl}/api/checks/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ report, visibility: args.public ? 'public' : 'private' })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Publish endpoint was not found at ${apiUrl}/api/checks/publish. Deploy the latest A2ZAI code first, or set DRIFTCHECK_API_URL=http://localhost:3000 while testing against a local dev server.`
      );
    }
    throw new Error(body?.error || `Publish failed with status ${response.status}`);
  }
  console.log(`Published ${body.visibility} proof: ${body.url}`);
}

function summary(args) {
  const cwd = process.cwd();
  const runPath = path.resolve(cwd, args.run || path.join('.driftcheck', 'runs', 'latest.json'));
  if (!fs.existsSync(runPath)) throw new Error(`Run report not found: ${runPath}`);
  const report = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const diff = args.base ? loadDiff(cwd, args.base, args.run || path.join('.driftcheck', 'runs', 'latest.json')) : null;
  const failThreshold = Number(args['fail-threshold'] || 70);
  console.log(renderGithubSummary(report, { failThreshold: Number.isFinite(failThreshold) ? failThreshold : 70, diff }));
}

function diff(args) {
  const cwd = process.cwd();
  const basePath = args.base || args.baseline;
  const headPath = args.head || args.run || path.join('.driftcheck', 'runs', 'latest.json');
  if (!basePath) throw new Error('diff requires --base <run.json>.');
  const diffReport = loadDiff(cwd, basePath, headPath);
  if (args.json) {
    console.log(JSON.stringify(diffReport, null, 2));
    return;
  }
  const markdown = renderDiffMarkdown(diffReport);
  if (args.output) {
    const outputPath = path.resolve(cwd, args.output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, markdown, 'utf8');
    console.log(`Wrote ${path.relative(cwd, outputPath)}`);
    return;
  }
  console.log(markdown);
}

function loadDiff(cwd, basePath, headPath) {
  const resolvedBase = path.resolve(cwd, basePath);
  const resolvedHead = path.resolve(cwd, headPath);
  if (!fs.existsSync(resolvedBase)) throw new Error(`Base run report not found: ${resolvedBase}`);
  if (!fs.existsSync(resolvedHead)) throw new Error(`Head run report not found: ${resolvedHead}`);
  const baseReport = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
  const headReport = JSON.parse(fs.readFileSync(resolvedHead, 'utf8'));
  return diffReports(baseReport, headReport);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === 'help' || command === '--help') return printHelp();
    if (command === 'init') return init(args);
    if (command === 'check') return await check(args);
    if (command === 'compare') return await compare(args);
    if (command === 'diff') return diff(args);
    if (command === 'summary') return summary(args);
    if (command === 'publish') return await publish(args);
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`DriftCheck error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
