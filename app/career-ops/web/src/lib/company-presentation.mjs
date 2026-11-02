const DIRECT_VIA = /^(n\/?a|tbd|none|null|-|—|–)$/i;

export function companyPresentation({ company = "", via = "" } = {}) {
  const companyName = String(company).trim();
  const intermediary = String(via).trim();

  if (companyName !== "?") return { label: company, logoName: company };
  if (intermediary && !DIRECT_VIA.test(intermediary)) {
    return {
      label: `Confidential · via ${intermediary}`,
      logoName: intermediary,
    };
  }
  return { label: "Confidential employer", logoName: "Confidential employer" };
}

export function companySearchText(application) {
  const { label } = companyPresentation(application);
  return `${application?.company ?? ""} ${application?.via ?? ""} ${label} ${application?.role ?? ""}`;
}
