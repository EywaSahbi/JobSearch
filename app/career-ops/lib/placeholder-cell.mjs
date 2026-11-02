export function isPlaceholderCompany(value) {
  return !/[\p{L}\p{N}]/u.test(String(value ?? ''));
}
