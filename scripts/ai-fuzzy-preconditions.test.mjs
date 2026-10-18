import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionPlan,
  buildPreconditionReport,
  inspectGoldenMessages,
  requireFixtureWorkspace,
} from './ai-fuzzy-preconditions.mjs';

function turn(number, tall = false) {
  const userId = `user-${String(number)}`;
  return [
    {
      info: { id: userId, role: 'user' },
      parts: [{ type: 'text', text: `[VFZ:test:T${String(number).padStart(3, '0')}] prompt` }],
    },
    {
      info: {
        id: `assistant-${String(number)}`,
        role: 'assistant',
        parentID: userId,
        time: { completed: 1 },
      },
      parts: [
        {
          type: 'text',
          text: `${tall ? `${'long line\n'.repeat(60)}` : 'short'}END-${String(number)}`,
        },
      ],
    },
  ];
}

test('validates reusable history against scenario-specific static gates', () => {
  const messages = Array.from({ length: 110 }, (_, index) =>
    turn(index + 1, (index + 1) % 10 === 0)
  ).flat();
  const summary = inspectGoldenMessages(messages);
  const report = buildPreconditionReport(summary);

  assert.equal(summary.completeMarkedTurnCount, 110);
  assert.equal(summary.tallMarkedTurnCount, 11);
  assert.equal(report.staticReady, true);
  assert.equal(report.checks['AI-05'], true);
  assert.equal(report.checks['AI-07'], null);
});

test('reports unmet history gates instead of treating them as passes', () => {
  const messages = Array.from({ length: 32 }, (_, index) => turn(index + 1, index < 3)).flat();
  const report = buildPreconditionReport(inspectGoldenMessages(messages));

  assert.equal(report.staticReady, false);
  assert.equal(report.checks['AI-01'], true);
  assert.equal(report.checks['AI-04'], false);
  assert.equal(report.checks['AI-05'], false);
});

test('creates a stable 50-step mixed-ownership action plan', () => {
  const first = buildActionPlan('seed-1');
  const second = buildActionPlan('seed-1');

  assert.equal(first.length, 50);
  assert.deepEqual(first, second);
  assert.equal(first[0].action, 'switch session away and back');
  assert.deepEqual(
    first.slice(4, 7).map(({ action }) => action),
    ['PageDown in composer', 'Space in composer', 'Shift+Space in composer']
  );
  assert.equal(
    first.some(({ action }) => action.includes('inline editor')),
    false
  );
  assert.deepEqual(
    first.slice(13, 19).map(({ action }) => action),
    [
      'hide file diffs',
      'held scrollbar to top',
      'held scrollbar to bottom',
      'show file diffs',
      'held scrollbar to top',
      'held scrollbar to bottom',
    ]
  );
});

test('both planned diff toggles change the enabled AI-08 starting state', () => {
  let enabled = true;
  const transitions = [];
  for (const step of buildActionPlan('visibility-regression')) {
    if (!['show file diffs', 'hide file diffs'].includes(step.action)) continue;
    const next = step.action === 'show file diffs';
    assert.notEqual(next, enabled, `step ${step.step} requests an already-active setting`);
    transitions.push([enabled, next]);
    enabled = next;
  }
  assert.deepEqual(transitions, [
    [true, false],
    [false, true],
  ]);
});

test('rejects AI workspaces outside the canonical fixture', async () => {
  await assert.rejects(requireFixtureWorkspace(process.cwd()), /must be exactly/);
});
