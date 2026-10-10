export function escapeFormulaCell(value) {
  const cell = String(value ?? '');
  return /^'*[=+\-@]/.test(cell) ? `'${cell}` : cell;
}

export function unescapeFormulaCell(value) {
  const cell = String(value ?? '');
  return cell.replace(/^'(?='*[=+\-@])/, '');
}
