import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const KINDS = ['cninfo', 'earnings', 'earnings-report', 'risk'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAIL_LISTS = ['topGood', 'topBad', 'allGood', 'allBad', 'allItems'];

function assertDate(value) {
  if (!DATE_RE.test(value || '')) throw new Error('target date must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('target date must be a real calendar date');
  }
}

function previousCalendarDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function resolveResearchRunPlan(targetDate, root, { pythonBin = 'python3' } = {}) {
  assertDate(targetDate);
  const tasksRoot = path.resolve(root);
  const previousDate = previousCalendarDate(targetDate);
  const earningsOutput = path.join(tasksRoot, 'earnings', 'output', targetDate);

  return [
    {
      kind: 'cninfo',
      cwd: path.join(tasksRoot, 'cninfo'),
      outputRoot: path.join(tasksRoot, 'cninfo', 'output', targetDate),
      commands: [{
        command: pythonBin,
        args: [
          path.join(tasksRoot, 'cninfo', 'run.py'),
          '--date', previousDate,
          '--report-date', targetDate,
          '--skip-recap',
        ],
      }],
    },
    {
      kind: 'earnings',
      cwd: path.join(tasksRoot, 'earnings'),
      outputRoot: earningsOutput,
      commands: [
        {
          command: pythonBin,
          args: [path.join(tasksRoot, 'earnings', 'fetch_cninfo.py'), targetDate, earningsOutput],
        },
        {
          command: pythonBin,
          args: [
            path.join(tasksRoot, 'earnings', 'build_report.py'),
            path.join(earningsOutput, 'input.json'),
            earningsOutput,
          ],
        },
      ],
    },
    {
      kind: 'earnings-report',
      cwd: path.join(tasksRoot, 'earnings-report'),
      outputRoot: path.join(tasksRoot, 'earnings-report', 'output', targetDate),
      commands: [{
        command: pythonBin,
        args: [
          path.join(tasksRoot, 'earnings-report', 'run.py'),
          '--date', targetDate,
          '--no-mail',
          '--force',
        ],
      }],
    },
    {
      kind: 'risk',
      cwd: path.join(tasksRoot, 'risk'),
      outputRoot: path.join(tasksRoot, 'risk', 'output', targetDate),
      commands: [{
        command: pythonBin,
        args: [path.join(tasksRoot, 'risk', 'run.py'), '--scan-date', targetDate],
      }],
    },
  ];
}

function spawnProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(args[0] || command)} exited with ${signal || code}`));
    });
  });
}

export async function runResearchPlan(
  plan,
  { runProcess = spawnProcess, env = process.env } = {},
) {
  for (const group of plan) {
    for (const command of group.commands) {
      await runProcess(command.command, command.args, {
        cwd: group.cwd,
        env: { ...process.env, ...env },
        shell: false,
      });
    }
  }
}

export function isPublishableResearchSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  if (Number.isFinite(summary.totalCount) && summary.totalCount > 0) return true;
  return DETAIL_LISTS.some((key) => Array.isArray(summary[key]) && summary[key].length > 0);
}

function safeFilename(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === path.basename(value)
    && !value.includes('\0');
}

export async function buildResearchManifest({
  jobId,
  generatedAt = new Date().toISOString(),
  targetDate,
  researchDataDir,
  reportsDir,
  syncResult,
}) {
  assertDate(targetDate);
  const summaries = [];
  const files = [];
  const successful = new Set(
    (syncResult?.results || [])
      .filter((result) => result?.success && result?.date === targetDate)
      .map((result) => result.kind),
  );

  for (const kind of KINDS) {
    if (!successful.has(kind)) continue;
    const summaryPath = path.join(researchDataDir, kind, `${targetDate}.json`);
    const summary = JSON.parse(await fs.promises.readFile(summaryPath, 'utf8'));
    if (!isPublishableResearchSummary(summary)) continue;

    const publishedFiles = [];
    for (const entry of Array.isArray(summary.files) ? summary.files : []) {
      if (!safeFilename(entry?.filename)) {
        throw new Error(`invalid report filename for ${kind}`);
      }
      const reportPath = path.join(reportsDir, kind, targetDate, entry.filename);
      const stat = await fs.promises.stat(reportPath);
      if (!stat.isFile()) throw new Error(`report is not a file: ${entry.filename}`);
      const published = {
        filename: entry.filename,
        type: entry.type,
        size: stat.size,
        url: `/api/research/files/${kind}/${targetDate}/${encodeURIComponent(entry.filename)}`,
      };
      publishedFiles.push(published);
      files.push({
        kind,
        date: targetDate,
        ...published,
        path: reportPath,
      });
    }

    summaries.push({
      ...summary,
      kind,
      date: targetDate,
      files: publishedFiles,
    });
  }

  return { jobId, generatedAt, summaries, files };
}

async function copyTaskSources(sourceRoot, destinationRoot) {
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  for (const kind of KINDS) {
    await fs.promises.cp(path.join(sourceRoot, kind), path.join(destinationRoot, kind), {
      recursive: true,
      filter(source) {
        const basename = path.basename(source);
        return !['.venv', '__pycache__', '.cache_pdfs', 'output', 'state'].includes(basename);
      },
    });
  }
}

export async function runCloudResearch({
  targetDate,
  jobId,
  taskSourceRoot = path.join(REPO_ROOT, 'automation/research-tasks'),
  workRoot,
  manifestPath = path.join(REPO_ROOT, 'cloud-research-manifest.json'),
  pythonBin = process.env.PYTHON_BIN || 'python3',
  runProcess = spawnProcess,
} = {}) {
  assertDate(targetDate);
  const safeJobId = String(jobId || `local-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
  const runRoot = workRoot
    ? path.resolve(workRoot)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), `shifeng-research-${safeJobId}-`));
  const tasksRoot = path.join(runRoot, 'tasks');
  const researchDataDir = path.join(runRoot, 'normalized', 'data');
  const reportsDir = path.join(runRoot, 'normalized', 'reports');
  await copyTaskSources(path.resolve(taskSourceRoot), tasksRoot);

  const taskEnv = {
    ...process.env,
    SHIFENG_TASKS_DIR: tasksRoot,
    CNINFO_OUTPUT_DIR: path.join(tasksRoot, 'cninfo', 'output'),
    EARNINGS_OUTPUT_DIR: path.join(tasksRoot, 'earnings', 'output'),
    EARNINGS_REPORT_OUTPUT_DIR: path.join(tasksRoot, 'earnings-report', 'output'),
    RISK_OUTPUT_DIR: path.join(tasksRoot, 'risk', 'output'),
    RESEARCH_CNINFO_DIR: path.join(tasksRoot, 'cninfo'),
    RESEARCH_DATA_DIR: researchDataDir,
    RESEARCH_REPORTS_DIR: reportsDir,
  };
  const plan = resolveResearchRunPlan(targetDate, tasksRoot, { pythonBin });
  await runResearchPlan(plan, { runProcess, env: taskEnv });

  const previousEnv = {};
  for (const [key, value] of Object.entries(taskEnv)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  let syncResult;
  try {
    const syncModuleUrl = new URL('../lib/researchSync.js', import.meta.url);
    syncModuleUrl.searchParams.set('cloudRun', safeJobId);
    const { syncResearch } = await import(syncModuleUrl.href);
    syncResult = await syncResearch({ kind: 'all', date: targetDate, force: true });
  } finally {
    for (const key of Object.keys(taskEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }

  const failed = (syncResult?.results || []).filter((result) => !result.success);
  if (failed.length > 0) {
    throw new Error(`research normalization failed: ${failed.map((item) => `${item.kind}: ${item.error}`).join('; ')}`);
  }
  const manifest = await buildResearchManifest({
    jobId: safeJobId,
    targetDate,
    researchDataDir,
    reportsDir,
    syncResult,
  });
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, runRoot, syncResult };
}

async function main() {
  const targetDate = process.env.RESEARCH_TARGET_DATE;
  const jobId = process.env.RESEARCH_JOB_ID || process.env.GITHUB_RUN_ID;
  const result = await runCloudResearch({ targetDate, jobId });
  process.stdout.write(
    `[cloud-research] ready job=${result.manifest.jobId} summaries=${result.manifest.summaries.length} files=${result.manifest.files.length}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[cloud-research] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
