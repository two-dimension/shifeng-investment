#!/usr/bin/env node
import { migrateLegacyKlineCache, rebuildKlineManifestFromStore } from '../server/lib/quantStrategy.js';

const force = process.argv.includes('--force');
const rebuild = process.argv.includes('--rebuild');
const result = rebuild ? rebuildKlineManifestFromStore() : migrateLegacyKlineCache({ force });
console.log(JSON.stringify(result, null, 2));
