import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function configureProjectPythonRuntime({
  env = process.env,
  projectRoot = PROJECT_ROOT,
  existsSync = fs.existsSync,
} = {}) {
  const projectPython = path.join(projectRoot, 'server', 'data', 'python-venv', 'bin', 'python3');
  const pythonBin = env.SHIFENG_PYTHON_BIN || projectPython;
  if (path.isAbsolute(pythonBin) && !existsSync(pythonBin)) return null;

  if (path.isAbsolute(pythonBin)) {
    const pythonDir = path.dirname(pythonBin);
    const currentPath = String(env.PATH || '');
    const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
    env.PATH = [pythonDir, ...pathEntries.filter((entry) => entry !== pythonDir)].join(path.delimiter);
  }

  env.PYTHON ||= pythonBin;
  env.PRICE_TRACKING_PYTHON ||= pythonBin;
  env.NEWS_INTELLIGENCE_PYTHON ||= pythonBin;
  env.QUANT_PYTHON_BIN ||= pythonBin;
  return pythonBin;
}
