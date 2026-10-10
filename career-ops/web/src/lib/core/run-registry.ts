let seq = 0;
const writing = new Set<number>();

export function acquireTrackerWrite(): number {
  const token = ++seq;
  writing.add(token);
  return token;
}

export function releaseTrackerWrite(token: number): void {
  writing.delete(token);
}

export function isTrackerWriting(): boolean {
  return writing.size > 0;
}
