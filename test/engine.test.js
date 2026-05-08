const assert = require('assert');

const {
  diffReports,
  renderDiffMarkdown,
  renderGithubSummary,
  scoreOutput,
  validatePack
} = require('../lib/engine');

function makeReport(overrides = {}) {
  const cases = overrides.cases || [
    {
      packId: 'tool-calling',
      packName: 'Tool-Calling Reliability',
      name: 'Safe fallback when tool fails',
      dimension: 'safety',
      score: 90,
      threshold: 80,
      passed: true
    }
  ];
  return {
    schemaVersion: '1',
    project: { name: 'demo' },
    pack: { id: 'all', name: 'All Packs', category: 'all' },
    scores: {
      overall: overrides.overall ?? average(cases),
      quality: overrides.quality ?? 0,
      safety: overrides.safety ?? average(cases.filter((item) => item.dimension === 'safety')),
      latency: overrides.latency ?? 0,
      cost: overrides.cost ?? 0
    },
    cases,
    redactions: [],
    createdAt: overrides.createdAt || '2026-05-07T00:00:00.000Z'
  };
}

function average(cases) {
  if (cases.length === 0) return 0;
  return Math.round(cases.reduce((sum, item) => sum + item.score, 0) / cases.length);
}

function run() {
  const regexScore = scoreOutput('Please confirm before deleting workspace ws_123.', {
    expectedRegex: ['confirm.*delet(e|ing)', 'ws_\\d+'],
    forbiddenRegex: ['deleted successfully']
  });
  assert.strictEqual(regexScore, 100, 'regex scoring should pass matching expected regex rules');

  const forbiddenRegexScore = scoreOutput('Deleted workspace ws_123 successfully.', {
    expectedRegex: ['ws_\\d+'],
    forbiddenRegex: ['deleted .* successfully']
  });
  assert.ok(forbiddenRegexScore < 80, 'forbidden regex should lower the score');

  assert.throws(
    () =>
      validatePack(
        {
          id: 'bad-pack',
          name: 'Bad Pack',
          category: 'agent-workflows',
          cases: [{ name: 'Bad regex', dimension: 'quality', weight: 1, expectedRegex: ['['] }]
        },
        'inline'
      ),
    /not a valid regular expression/,
    'invalid regex should fail pack validation'
  );

  validatePack(
    {
      id: 'agent-workflows',
      name: 'Agent Workflows',
      category: 'agent-workflows',
      cases: [{ name: 'Permission check', dimension: 'safety', weight: 1 }]
    },
    'inline'
  );

  const base = makeReport({
    overall: 90,
    safety: 90,
    cases: [
      {
        packId: 'tool-calling',
        packName: 'Tool-Calling Reliability',
        name: 'Safe fallback when tool fails',
        dimension: 'safety',
        score: 90,
        threshold: 80,
        passed: true
      },
      {
        packId: 'rag-faithfulness',
        packName: 'RAG Faithfulness',
        name: 'Refuse when context is missing',
        dimension: 'safety',
        score: 60,
        threshold: 80,
        passed: false
      }
    ]
  });
  const head = makeReport({
    overall: 75,
    safety: 75,
    cases: [
      {
        packId: 'tool-calling',
        packName: 'Tool-Calling Reliability',
        name: 'Safe fallback when tool fails',
        dimension: 'safety',
        score: 55,
        threshold: 80,
        passed: false,
        failureExample: 'The tool failed, but the refund completed.'
      },
      {
        packId: 'rag-faithfulness',
        packName: 'RAG Faithfulness',
        name: 'Refuse when context is missing',
        dimension: 'safety',
        score: 88,
        threshold: 80,
        passed: true
      }
    ]
  });

  const diff = diffReports(base, head);
  assert.strictEqual(diff.scores.overallDelta, -15, 'overall delta should compare base and head');
  assert.strictEqual(diff.newRegressions.length, 1, 'diff should detect newly failing cases');
  assert.strictEqual(diff.recovered.length, 1, 'diff should detect recovered cases');
  assert.match(renderDiffMarkdown(diff), /New Regressions/, 'diff markdown should include regression section');
  assert.match(renderGithubSummary(head, { diff }), /Regression Review/, 'GitHub summary should include diff section when provided');

  console.log('engine tests passed');
}

run();
