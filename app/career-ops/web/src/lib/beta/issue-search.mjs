const searchCache = new Map();

export function _resetCache() {
  searchCache.clear();
}

export async function searchIssues(q, repo, fetchFn) {
  const cached = searchCache.get(q);
  if (cached) return cached;
  try {
    const res = await fetchFn(
      `https://api.github.com/search/issues?per_page=4&q=${encodeURIComponent(`repo:${repo} is:issue is:open ${q}`)}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const items = (d.items || []).map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
    searchCache.set(q, items);
    return items;
  } catch {
    return null;
  }
}
