export function companySlug(company) {
  const c = (company ?? "").trim();
  if (!c) return null;
  const slug = (c.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return null;
  return { slug, first: slug.split("-")[0] };
}
