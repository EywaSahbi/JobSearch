const DOMAIN_OVERRIDES: Record<string, string> = {
  anthropic: "anthropic.com",
  openai: "openai.com",
  google: "google.com",
  "google deepmind": "deepmind.google",
  deepmind: "deepmind.google",
  meta: "meta.com",
  "meta platforms": "meta.com",
  facebook: "meta.com",
  microsoft: "microsoft.com",
  apple: "apple.com",
  amazon: "amazon.com",
  aws: "aws.amazon.com",
  netflix: "netflix.com",
  nvidia: "nvidia.com",
  x: "x.com",
  twitter: "x.com",
  xai: "x.ai",
  "x.ai": "x.ai",
  stripe: "stripe.com",
  shopify: "shopify.com",
  airbnb: "airbnb.com",
  uber: "uber.com",
  lyft: "lyft.com",
  spotify: "spotify.com",
  linkedin: "linkedin.com",
  github: "github.com",
  gitlab: "gitlab.com",
  notion: "notion.so",
  figma: "figma.com",
  canva: "canva.com",
  databricks: "databricks.com",
  snowflake: "snowflake.com",
  datadog: "datadoghq.com",
  cloudflare: "cloudflare.com",
  vercel: "vercel.com",
  netlify: "netlify.com",
  hugging: "huggingface.co",
  huggingface: "huggingface.co",
  "hugging face": "huggingface.co",
  cohere: "cohere.com",
  "mistral ai": "mistral.ai",
  mistral: "mistral.ai",
  perplexity: "perplexity.ai",
  scale: "scale.com",
  "scale ai": "scale.com",
  replit: "replit.com",
  ramp: "ramp.com",
  brex: "brex.com",
  plaid: "plaid.com",
  coinbase: "coinbase.com",
  robinhood: "robinhood.com",
  doordash: "doordash.com",
  instacart: "instacart.com",
  pinterest: "pinterest.com",
  reddit: "reddit.com",
  discord: "discord.com",
  slack: "slack.com",
  atlassian: "atlassian.com",
  salesforce: "salesforce.com",
  oracle: "oracle.com",
  ibm: "ibm.com",
  intel: "intel.com",
  amd: "amd.com",
  tesla: "tesla.com",
  spacex: "spacex.com",
  palantir: "palantir.com",
  twilio: "twilio.com",
  zoom: "zoom.us",
  dropbox: "dropbox.com",
  asana: "asana.com",
  airtable: "airtable.com",
  segment: "segment.com",
  elastic: "elastic.co",
  mongodb: "mongodb.com",
  hashicorp: "hashicorp.com",
  "booking.com": "booking.com",
  booking: "booking.com",
  revolut: "revolut.com",
  wise: "wise.com",
  klarna: "klarna.com",
  adyen: "adyen.com",
  glovo: "glovoapp.com",
  cabify: "cabify.com",
  "typeform": "typeform.com",
  factorial: "factorialhr.com",
  "n26": "n26.com",
  vdab: "vdab.be",
  "red hat": "redhat.com",
  redhat: "redhat.com",
};

const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|gmbh|co|corp|corporation|sa|s\.a|ag|plc|sl|s\.l|bv|oy|ab|company|group|holdings|technologies|technology|labs|systems)\b/gi;

export function companyDomain(name: string | undefined | null): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (DOMAIN_OVERRIDES[key]) return DOMAIN_OVERRIDES[key];

  const cleaned = key
    .replace(/[®™©]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[.,&'’/()|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (DOMAIN_OVERRIDES[cleaned]) return DOMAIN_OVERRIDES[cleaned];

  const slug = cleaned.replace(/\s+/g, "");
  if (slug.length < 2) return null;
  return `${slug}.com`;
}

export function companyInitials(name: string | undefined | null): string {
  if (!name) return "?";
  const words = name
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name.trim().slice(0, 1).toUpperCase() || "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function monogramHue(name: string | undefined | null): number {
  const s = (name ?? "").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
