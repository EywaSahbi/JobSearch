export const SCANNER_MISSING_CODE = "SCANNER_MISSING";

export const SCANNER_MISSING_STATUS = 400;

export const SCANNER_MISSING_MESSAGE = "The discovery scanner isn't available in this checkout yet.";

export function scannerMissingBody(message = SCANNER_MISSING_MESSAGE) {
  return { code: SCANNER_MISSING_CODE, error: message };
}

export function isScannerMissing(body) {
  return (
    typeof body === "object" &&
    body !== null &&
    (body).code === SCANNER_MISSING_CODE
  );
}
