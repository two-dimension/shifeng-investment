let writeTail = Promise.resolve();

/** Serializes every process-local read/modify/write of the shared dashboard snapshot. */
export function enqueueIceCdsSnapshotWrite(operation) {
  if (typeof operation !== 'function') throw new TypeError('snapshot write operation must be a function');
  const queued = writeTail.then(operation);
  writeTail = queued.catch(() => undefined);
  return queued;
}
