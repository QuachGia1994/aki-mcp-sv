import { z } from 'zod';

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const clean = (value) => String(value ?? '').trim();
const list = (value) => (value ?? []).map(clean).filter(Boolean);

const phaseGuidance = {
  brainstorm: ['Clarify the outcome and non-goals.', 'List constraints and unknowns.', 'Compare 2-3 viable approaches.', 'Choose one approach and record why.', 'Define acceptance criteria before implementation.'],
  plan: ['Name exact deliverables and likely files.', 'Split work into independently verifiable tasks.', 'Attach one verification command or observable result to each task.', 'Record risks, rollback, and dependencies.', 'Persist the plan under the shared taskKey.'],
  debug: ['Reproduce the failure with the smallest reliable case.', 'Capture expected versus actual behavior.', 'Gather evidence before proposing causes.', 'Test one hypothesis at a time.', 'Add a regression test and verify the fix.'],
  tdd: ['Write one behavior-focused failing test.', 'Run it and confirm the failure is relevant.', 'Implement the smallest passing change.', 'Run focused tests, then refactor.', 'Run the broader risk-appropriate suite.'],
  execute: ['Recover the shared checkpoint first.', 'Continue the first unfinished plan item.', 'Keep changes bounded to the active item.', 'Verify and checkpoint each material milestone.', 'Stop when acceptance criteria and required checks pass.'],
  review: ['Compare the diff with requirements and non-goals.', 'Inspect security, data-loss, compatibility, and concurrency risks.', 'Check tests cover changed behavior and failure paths.', 'Confirm docs and attribution are current.', 'Report findings by severity with file evidence.'],
};

export function buildWorkflow({ phase, goal, context = '', constraints = [], evidence = [], taskKey = '', cwd = '' }) {
  const normalizedGoal = clean(goal);
  if (!normalizedGoal) throw new Error('goal is required');
  return {
    phase,
    goal: normalizedGoal,
    taskKey: clean(taskKey) || null,
    cwd: clean(cwd) || null,
    context: clean(context) || null,
    constraints: list(constraints),
    evidence: list(evidence),
    checklist: phaseGuidance[phase],
    completion: phase === 'review'
      ? 'All material findings are resolved or explicitly accepted, and verification evidence is recorded.'
      : 'The checklist is satisfied, evidence is recorded, and the next action or outcome is explicit.',
  };
}

export function buildDebugWorkflow({ symptom, expected, reproduction = '', observations = [], hypotheses = [], taskKey = '', cwd = '' }) {
  const goal = `Find and verify the root cause of: ${clean(symptom)}`;
  const workflow = buildWorkflow({ phase: 'debug', goal, context: reproduction, evidence: observations, taskKey, cwd });
  return {
    ...workflow,
    expected: clean(expected),
    hypotheses: list(hypotheses).map((hypothesis, index) => ({ priority: index + 1, hypothesis, falsification: 'Name the smallest observation or experiment that would disprove this hypothesis.' })),
    nextExperiment: 'Run the cheapest discriminating experiment for the highest-priority unfalsified hypothesis.',
  };
}

export function buildReviewWorkflow({ goal, changedFiles = [], verification = [], risks = [], taskKey = '', cwd = '' }) {
  return {
    ...buildWorkflow({ phase: 'review', goal, constraints: risks, evidence: verification, taskKey, cwd }),
    changedFiles: list(changedFiles),
    findingFormat: { severity: 'critical|high|medium|low', location: 'file:line', issue: 'observable problem', recommendation: 'smallest safe correction' },
  };
}

export function register(server) {
  server.registerTool('workflow_guide', {
    title: 'Aki Workflow Guide',
    description: 'Create a compact, structured engineering workflow inspired by proven design, planning, TDD, execution, debugging, and review practices. This guides work without mutating the repository.',
    inputSchema: {
      phase: z.enum(['brainstorm', 'plan', 'tdd', 'execute']),
      goal: z.string().min(1),
      context: z.string().optional().default(''),
      constraints: z.array(z.string()).optional().default([]),
      evidence: z.array(z.string()).optional().default([]),
      taskKey: z.string().optional().default(''),
      cwd: z.string().optional().default(''),
    },
  }, async (input) => ok(buildWorkflow(input)));

  server.registerTool('debug_workflow', {
    title: 'Aki Systematic Debug Workflow',
    description: 'Turn a failure into a bounded evidence-first root-cause workflow with falsifiable hypotheses and regression verification.',
    inputSchema: {
      symptom: z.string().min(1),
      expected: z.string().min(1),
      reproduction: z.string().optional().default(''),
      observations: z.array(z.string()).optional().default([]),
      hypotheses: z.array(z.string()).optional().default([]),
      taskKey: z.string().optional().default(''),
      cwd: z.string().optional().default(''),
    },
  }, async (input) => ok(buildDebugWorkflow(input)));

  server.registerTool('review_workflow', {
    title: 'Aki Code Review Workflow',
    description: 'Create a risk-ranked review checklist tied to requirements, changed files, verification evidence, and a shared task checkpoint.',
    inputSchema: {
      goal: z.string().min(1),
      changedFiles: z.array(z.string()).optional().default([]),
      verification: z.array(z.string()).optional().default([]),
      risks: z.array(z.string()).optional().default([]),
      taskKey: z.string().optional().default(''),
      cwd: z.string().optional().default(''),
    },
  }, async (input) => ok(buildReviewWorkflow(input)));
}
