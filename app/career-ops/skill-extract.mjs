#!/usr/bin/env node

export const SKILL_TOKENS = [
  'JavaScript', 'TypeScript', 'Python', 'Ruby', 'Java', 'Golang', 'Rust', 'PHP',
  'Kotlin', 'Swift', 'Scala', 'Elixir', 'C\\+\\+', 'C#', '\\.NET', 'SQL',
  'React Native', 'React', 'Angular', 'Vue\\.?js', 'Svelte', 'Next\\.?js',
  'Django', 'Flask', 'FastAPI', 'Rails', 'Laravel', 'Symfony', 'Spring',
  'Node\\.?js', 'NodeJS',
  'MongoDB', 'MySQL', 'PostgreSQL', 'Postgres', 'Redis', 'Elasticsearch',
  'Snowflake', 'BigQuery', 'Databricks', 'DynamoDB', 'Cassandra',
  'GraphQL', 'gRPC', 'Kafka', 'RabbitMQ',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'k8s', 'Terraform',
  'Ansible', 'Helm', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'CI/CD',
  'Prometheus', 'Grafana', 'Datadog', 'Supabase', 'Inngest',
  'PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy', 'Spark',
  'Airflow', 'dbt', 'MLOps', 'MLflow', 'LangChain', 'LlamaIndex',
  'Hugging Face', 'RAG', 'LLMs?', 'Prompt Engineering',
  'Computer Vision', 'NLP',
  'HuggingFace', 'sklearn',
  'Retrieval-Augmented Generation', 'Retrieval Augmented Generation',
  'Large Language Models?', 'Natural Language Processing',
  'Tableau', 'Power BI', 'Looker', 'Salesforce', 'SAP',
  'JUnit', 'TestNG', 'NUnit', 'xUnit', 'MSTest', 'Cucumber', 'Mockito',
  'Jest', 'pytest', 'Selenium', 'Playwright', 'Cypress', 'Karate', 'Postman',
  'TDD', 'BDD',
  'OpenTelemetry', 'OTel', 'ELK', 'Splunk', 'CloudWatch',
  'PMI-ACP', 'PMI ACP', 'PgMP', 'CAPM', 'PMBOK', 'PMP',
  'PRINCE2', 'PRINCE 2',
  'Certified Scrum Product Owner', 'Certified ScrumMaster', 'Certified Scrum Master', 'CSPO',
  'ITIL', 'COBIT', 'TOGAF',
  'Lean Six Sigma', 'Lean Six-Sigma', 'Six Sigma', 'Six-Sigma',
  'CISSP', 'CISM', 'CIPP',

  'Account-Based Marketing', 'Account Based Marketing', 'ABM',
  'Demand-Side Platform', 'Demand Side Platform', 'DSPs', 'DSP',
  'Programmatic Advertising', 'Programmatic Display', 'Programmatic Media',
  'Programmatic Buying',
  'Media Agency Management', 'Media Agencies', 'Media Agency',
  'Demand Generation', 'Demand Gen',
  'Marketing Automation', 'Marketing Operations',
  'Revenue Operations', 'RevOps',
  'Lifecycle Marketing', 'Growth Marketing', 'Product Marketing',
  'Partner Marketing', 'Performance Marketing', 'Field Marketing',
  'Content Marketing', 'Email Marketing',
  'Paid Media', 'Paid Social', 'Paid Search',
  'Conversion Rate Optimization',
  'Marketing Mix Modeling', 'Media Mix Modeling', 'Incrementality',
  'Lead Scoring', 'Marketing Attribution',
  'SEMrush', 'SEO', 'SEM', 'PPC',
  'HubSpot', 'Marketo', 'Pardot', 'Braze', 'Klaviyo', 'OneSignal', 'Intercom',
  'Ahrefs', 'Demandbase', '6sense', 'Google Tag Manager', 'Google Analytics',
  'Google Ads', 'GA4', 'Amplitude', 'Mixpanel', 'n8n', 'Zapier',
];

const SAFE_CERT_PATTERN = /(?<!\w)SAFe(?!\w)/;

export const SKILL_PATTERN = new RegExp(
  '(?<!\\w)(?:' + SKILL_TOKENS.join('|') + ')(?!\\w)',
  'gi'
);

const GO_SKILL_PATTERN = /(?<!\w)Go(?![\w-])/;

const FINE_TUNING_PATTERN = /(?<!\w)fine[- ]?tuning(?!\w)/i;

const MODEL_FINE_TUNING =
  /(?<!\w)models?\s+fine[- ]?tuning(?!\w)|(?<!\w)fine[- ]?tuning\s+(?:of\s+)?models?(?!\w)/i;

const LIST_ENTRY_SEPARATOR = /([,;:|/()[\]"•·])/;

const FINE_TUNING_ENTRY = /^(?:[-*+]\s+)?[*_]*fine[- ]?tuning[*_.]*$/i;

const MODEL_SKILLS = new Set([
  'PyTorch', 'TensorFlow', 'scikit-learn', 'MLOps', 'MLflow', 'LangChain',
  'LlamaIndex', 'Hugging Face', 'RAG', 'LLMs', 'Prompt Engineering',
  'Computer Vision', 'NLP',
]);

export const DISPLAY = Object.fromEntries(
  SKILL_TOKENS.map(t => {
    const display = t.replace(/\\/g, '').replace(/\?/g, '');
    return [display.toLowerCase(), display];
  })
);

export const CANONICAL = {
  'k8s': 'Kubernetes',
  'golang': 'Go',
  'postgres': 'PostgreSQL',
  'nodejs': 'Node.js', 'node.js': 'Node.js', 'nodejs.': 'Node.js',
  'vuejs': 'Vue.js', 'vue.js': 'Vue.js',
  'nextjs': 'Next.js', 'next.js': 'Next.js',
  'llm': 'LLMs', 'llms': 'LLMs',
  'finetuning': 'Fine-tuning', 'fine-tuning': 'Fine-tuning',
  'fine tuning': 'Fine-tuning',
  'power bi': 'Power BI',
  'github actions': 'GitHub Actions',
  'gitlab ci': 'GitLab CI',
  'ci/cd': 'CI/CD',
  'hugging face': 'Hugging Face',
  'react native': 'React Native',
  'prompt engineering': 'Prompt Engineering',
  'computer vision': 'Computer Vision',
  'scikit-learn': 'scikit-learn',
  'c++': 'C++', 'c#': 'C#', '.net': '.NET',
  'nlp': 'NLP', 'rag': 'RAG', 'sql': 'SQL', 'aws': 'AWS', 'gcp': 'GCP',
  'grpc': 'gRPC', 'dbt': 'dbt', 'mlops': 'MLOps', 'mlflow': 'MLflow',
  'otel': 'OpenTelemetry',
  'huggingface': 'Hugging Face',
  'sklearn': 'scikit-learn',
  'large language model': 'LLMs', 'large language models': 'LLMs',
  'retrieval-augmented generation': 'RAG', 'retrieval augmented generation': 'RAG',
  'natural language processing': 'NLP',
  'pmp': 'PMP', 'pmi-acp': 'PMI-ACP', 'pgmp': 'PgMP', 'capm': 'CAPM',
  'pmbok': 'PMBOK', 'prince2': 'PRINCE2', 'cspo': 'CSPO',
  'certified scrummaster': 'Certified ScrumMaster',
  'itil': 'ITIL', 'cobit': 'COBIT', 'togaf': 'TOGAF',
  'lean six sigma': 'Lean Six Sigma', 'six sigma': 'Six Sigma',
  'cissp': 'CISSP', 'cism': 'CISM', 'cipp': 'CIPP',
  'certified scrum master': 'Certified ScrumMaster',
  'certified scrum product owner': 'CSPO',
  'pmi acp': 'PMI-ACP',
  'prince 2': 'PRINCE2',
  'lean six-sigma': 'Lean Six Sigma',
  'six-sigma': 'Six Sigma',
  'account-based marketing': 'ABM', 'account based marketing': 'ABM',
  'demand-side platform': 'DSP', 'demand side platform': 'DSP', 'dsps': 'DSP',
  'programmatic advertising': 'Programmatic',
  'programmatic display': 'Programmatic',
  'programmatic media': 'Programmatic',
  'programmatic buying': 'Programmatic',
  'media agency management': 'Media Agency Management',
  'media agencies': 'Media Agency Management',
  'media agency': 'Media Agency Management',
  'demand gen': 'Demand Generation',
  'revenue operations': 'RevOps',
  'marketing mix modeling': 'Media Mix Modeling',
};

export function canonicalize(token) {
  const key = token.toLowerCase();
  return CANONICAL[key] || DISPLAY[key] || token;
}

function listsFineTuning(line) {
  const parts = line.split(LIST_ENTRY_SEPARATOR);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i + 1] !== ':' && FINE_TUNING_ENTRY.test(parts[i].trim())) return true;
  }
  return false;
}

function mentionsFineTuning(text) {
  for (const line of text.split('\n')) {
    if (!FINE_TUNING_PATTERN.test(line)) continue;
    if (MODEL_FINE_TUNING.test(line)) return true;
    if (listsFineTuning(line)) return true;
    for (const m of line.matchAll(SKILL_PATTERN)) {
      if (MODEL_SKILLS.has(canonicalize(m[0]))) return true;
    }
  }
  return false;
}

export function extractSkills(text) {
  if (!text) return new Set();
  const found = new Set();
  for (const m of text.matchAll(SKILL_PATTERN)) {
    found.add(canonicalize(m[0]));
  }
  if (GO_SKILL_PATTERN.test(text)) found.add('Go');
  if (SAFE_CERT_PATTERN.test(text)) found.add('SAFe');
  if (mentionsFineTuning(text)) found.add('Fine-tuning');
  return found;
}
