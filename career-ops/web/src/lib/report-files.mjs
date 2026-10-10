import path from "node:path";

export function isReservedReportFile(file) {
  return /^\d+-RESERVED\.md$/.test(path.basename(file));
}
