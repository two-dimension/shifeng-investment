import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  uploadResearchFile,
  uploadResearchSummary,
} from './publish_cloud_research.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const KINDS = ['cninfo', 'earnings', 'earnings-report', 'risk'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_RE = /\.(?:pdf|xlsx)$/iu;

function validFilename(value) {
  return typeof value === 'string'
    && value === path.basename(value)
    && value.length > 4
    && value.length <= 180
    && !value.startsWith('~$')
    && !value.includes('..')
    && REPORT_RE.test(value);
}

async function directoryEntries(directory) {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function fileKey(file) {
  return `${file.kind}/${file.date}/${file.filename}`;
}

function summaryKey(summary) {
  return `${summary.kind}/${summary.date}`;
}

function lexicalEntryOrder(left, right) {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

function publicFile(kind, date, filename, size) {
  return {
    filename,
    type: filename.toLocaleLowerCase().endsWith('.pdf') ? 'pdf' : 'xlsx',
    size,
    url: `/api/research/files/${kind}/${date}/${encodeURIComponent(filename)}`,
  };
}

export async function buildHistoryManifest({
  researchDataDir,
  reportsDir,
  warn = (message) => process.stderr.write(`[research-migration] ${message}\n`),
}) {
  const files = [];
  for (const kind of KINDS) {
    const dateEntries = (await directoryEntries(path.join(reportsDir, kind)))
      .filter((entry) => entry.isDirectory() && DATE_RE.test(entry.name))
      .sort(lexicalEntryOrder);
    for (const dateEntry of dateEntries) {
      const reportEntries = (await directoryEntries(path.join(reportsDir, kind, dateEntry.name)))
        .filter((entry) => entry.isFile() && validFilename(entry.name))
        .sort(lexicalEntryOrder);
      for (const entry of reportEntries) {
        const filePath = path.join(reportsDir, kind, dateEntry.name, entry.name);
        const stat = await fs.promises.stat(filePath);
        files.push({
          kind,
          date: dateEntry.name,
          ...publicFile(kind, dateEntry.name, entry.name, stat.size),
          path: filePath,
        });
      }
    }
  }

  const availableFiles = new Map(files.map((file) => [fileKey(file), file]));
  const summaries = [];
  for (const kind of KINDS) {
    const entries = (await directoryEntries(path.join(researchDataDir, kind)))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort(lexicalEntryOrder);
    for (const entry of entries) {
      const date = entry.name.slice(0, -'.json'.length);
      if (!DATE_RE.test(date)) continue;
      const summaryPath = path.join(researchDataDir, kind, entry.name);
      let summary;
      try {
        summary = JSON.parse(await fs.promises.readFile(summaryPath, 'utf8'));
      } catch {
        throw new Error(`invalid JSON in historical summary ${kind}/${date}`);
      }
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error(`invalid historical summary ${kind}/${date}`);
      }

      const summaryFiles = [];
      for (const historicalFile of Array.isArray(summary.files) ? summary.files : []) {
        if (!validFilename(historicalFile?.filename)) {
          warn(`skipping invalid file reference ${kind}/${date}`);
          continue;
        }
        const available = availableFiles.get(`${kind}/${date}/${historicalFile.filename}`);
        if (!available) {
          warn(`missing report ${kind}/${date}/${historicalFile.filename}`);
          continue;
        }
        summaryFiles.push(publicFile(kind, date, available.filename, available.size));
      }
      summaries.push({ ...summary, kind, date, files: summaryFiles });
    }
  }

  return {
    jobId: 'history-migration',
    generatedAt: new Date().toISOString(),
    summaries,
    files,
  };
}

async function readCheckpoint(checkpointPath) {
  try {
    const value = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8'));
    return {
      uploadedFiles: Array.isArray(value?.uploadedFiles)
        ? value.uploadedFiles.filter((item) => typeof item === 'string')
        : [],
      uploadedSummaries: Array.isArray(value?.uploadedSummaries)
        ? value.uploadedSummaries.filter((item) => typeof item === 'string')
        : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { uploadedFiles: [], uploadedSummaries: [] };
    throw error;
  }
}

async function writeCheckpoint(checkpointPath, checkpoint) {
  await fs.promises.mkdir(path.dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temporaryPath, checkpointPath);
}

export async function migrateResearchHistory({
  manifest,
  checkpointPath,
  baseUrl,
  token,
  uploadFile = uploadResearchFile,
  uploadSummary = uploadResearchSummary,
  log = (message) => process.stdout.write(`[research-migration] ${message}\n`),
}) {
  const checkpoint = await readCheckpoint(checkpointPath);
  const uploadedFiles = new Set(checkpoint.uploadedFiles);
  const uploadedSummaries = new Set(checkpoint.uploadedSummaries);

  for (const file of manifest.files) {
    const key = fileKey(file);
    if (uploadedFiles.has(key)) continue;
    await uploadFile({ baseUrl, token, file });
    uploadedFiles.add(key);
    checkpoint.uploadedFiles = [...uploadedFiles];
    await writeCheckpoint(checkpointPath, checkpoint);
    log(`uploaded file ${key}`);
  }

  for (const summary of manifest.summaries) {
    const key = summaryKey(summary);
    if (uploadedSummaries.has(key)) continue;
    await uploadSummary({ baseUrl, token, summary });
    uploadedSummaries.add(key);
    checkpoint.uploadedSummaries = [...uploadedSummaries];
    await writeCheckpoint(checkpointPath, checkpoint);
    log(`uploaded summary ${key}`);
  }

  return {
    files: { total: manifest.files.length, uploaded: uploadedFiles.size },
    summaries: { total: manifest.summaries.length, uploaded: uploadedSummaries.size },
    checkpointPath,
  };
}

async function main() {
  const researchDataDir = process.env.RESEARCH_DATA_DIR || path.join(SERVER_ROOT, 'data/research');
  const reportsDir = process.env.RESEARCH_REPORTS_DIR || path.join(SERVER_ROOT, 'public/reports');
  const checkpointPath = process.env.RESEARCH_MIGRATION_CHECKPOINT
    || path.join(SERVER_ROOT, '.cloud-research-migration-checkpoint.json');
  const manifest = await buildHistoryManifest({ researchDataDir, reportsDir });
  const result = await migrateResearchHistory({
    manifest,
    checkpointPath,
    baseUrl: process.env.CLOUD_RESEARCH_BASE_URL,
    token: process.env.RESEARCH_PUBLISH_TOKEN,
  });
  process.stdout.write(
    `[research-migration] complete files=${result.files.uploaded}/${result.files.total} summaries=${result.summaries.uploaded}/${result.summaries.total}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[research-migration] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
