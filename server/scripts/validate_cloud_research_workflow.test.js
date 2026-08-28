import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.resolve(HERE, '../../.github/workflows/cloud-research.yml');

test('cloud research workflow has the required triggers, runtime, and failure reporting', async () => {
  const text = await fs.promises.readFile(WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(text);
  const triggers = workflow.on;
  const job = workflow.jobs.research;

  assert.deepEqual(triggers.repository_dispatch.types, ['research-refresh']);
  assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'));
  assert.deepEqual(triggers.schedule, [{ cron: '35 14 * * 1-5' }]);
  assert.deepEqual(workflow.concurrency, {
    group: 'cloud-research-all',
    'cancel-in-progress': false,
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.env.CLOUD_RESEARCH_BASE_URL, '${{ secrets.CLOUD_RESEARCH_BASE_URL }}');
  assert.equal(job.env.RESEARCH_PUBLISH_TOKEN, '${{ secrets.RESEARCH_PUBLISH_TOKEN }}');
  assert.equal(
    job.env.RESEARCH_JOB_ID,
    '${{ github.event.client_payload.job_id || github.run_id }}',
  );

  const serializedSteps = JSON.stringify(job.steps);
  assert.match(serializedSteps, /actions\/setup-node@v4/);
  assert.match(serializedSteps, /"node-version":"24"/);
  assert.match(serializedSteps, /actions\/setup-python@v5/);
  assert.match(serializedSteps, /"python-version":"3\.12"/);
  assert.match(serializedSteps, /"cache":"pip"/);
  assert.match(serializedSteps, /fonts-noto-cjk/);
  assert.match(serializedSteps, /npm ci/);
  assert.match(serializedSteps, /pip install -r automation\/research-tasks\/requirements\.txt/);
  assert.match(serializedSteps, /Asia\/Shanghai/);
  assert.match(serializedSteps, /node server\/scripts\/cloud_research_runner\.mjs/);
  assert.match(serializedSteps, /node server\/scripts\/publish_cloud_research\.mjs/);

  const failureStep = job.steps.find((step) => String(step.run || '').includes('--mark-failed'));
  assert.ok(failureStep, 'missing failed-state reporting step');
  assert.match(failureStep.if, /always\(\)/);
  assert.match(failureStep.if, /failure\(\)|outcome/);
  assert.equal(failureStep.env.RESEARCH_FAILURE_MESSAGE, 'GitHub Actions research workflow failed');
});
