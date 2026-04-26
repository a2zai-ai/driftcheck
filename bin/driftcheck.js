#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { LIVE_MODEL_COMPARE_PACK, LIVE_PACKS, STARTER_PACKS } = require('../lib/starter-packs');
const { combineReports, getProject, loadPack, renderMarkdown, runPack } = require('../lib/engine');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === 'force' || key === 'live' || key === 'public') {
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
  driftcheck check [--pack tool-calling] [--baseline-model gpt-4o-mini] [--candidate-model gpt-4.1-mini]
  driftcheck compare --baseline-model gpt-4o-mini --candidate-model gpt-4.1-mini
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
    console.log(`Running ${pack.name}...`);
    reports.push(await runPack(pack, project, createdAt, { modelOverrides }));
  }

  const report = combineReports(reports, project, createdAt);
  writeReport(cwd, report, createdAt);
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
  console.log(`Comparing ${modelOverrides.baselineModel} → ${modelOverrides.candidateModel}...`);
  const report = await runPack(pack, project, createdAt, { modelOverrides });
  writeReport(cwd, report, createdAt);
}

function loadInlinePack(pack) {
  const tmpDir = path.join(process.cwd(), '.driftcheck', 'tmp');
  ensureDir(tmpDir);
  const filePath = path.join(tmpDir, pack.filename);
  fs.writeFileSync(filePath, pack.yaml, 'utf8');
  return loadPack(filePath);
}

function writeReport(cwd, report, createdAt) {
  const runsDir = path.join(cwd, '.driftcheck', 'runs');
  ensureDir(runsDir);
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const runPath = path.join(runsDir, `${timestamp}-${report.pack.id}.json`);
  const latestPath = path.join(runsDir, 'latest.json');
  const markdownPath = path.join(cwd, 'driftcheck-report.md');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(runPath, json, 'utf8');
  fs.writeFileSync(latestPath, json, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  console.log(`Score: ${report.scores.overall}/100`);
  console.log(`Wrote ${path.relative(cwd, latestPath)} and driftcheck-report.md`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === 'help' || command === '--help') return printHelp();
    if (command === 'init') return init(args);
    if (command === 'check') return await check(args);
    if (command === 'compare') return await compare(args);
    if (command === 'publish') return await publish(args);
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`DriftCheck error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
