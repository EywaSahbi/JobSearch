export function safeEncodeURIComponent(value) {
  const str = String(value);
  try {
    return encodeURIComponent(str);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}
