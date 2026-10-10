export function createRunFinalizer(child, release) {
  let workerClosed = false;
  let runFinished = false;
  let released = false;

  const releaseIfFinished = () => {
    if (workerClosed && runFinished && !released) {
      released = true;
      release();
    }
  };

  child.once("close", () => {
    workerClosed = true;
    releaseIfFinished();
  });

  return () => {
    runFinished = true;
    releaseIfFinished();
  };
}
