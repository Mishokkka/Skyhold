export function createWriteQueue() {
  let queue = Promise.resolve();
  return function enqueueWrite(operation) {
    const run = queue.then(() => operation(), () => operation());
    // Keep later writes flowing while returning the original rejection to the caller.
    queue = run.catch(() => undefined);
    return run;
  };
}
