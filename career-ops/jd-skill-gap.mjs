#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { canonicalize, extractSkills } from './skill-extract.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizePandocLine, toPlainText } from './lib/cv-markdown.mjs';

const CV_PATH = join(getCareerOpsRoot(), 'cv.md');

const REQUIREMENT_HEADER_RE = new RegExp(
  '^#{0,6}\\s*(?:(?:' + [
    'required', 'requirements', 'qualifications', 'must[- ]have', 'preferred', 'nice[- ]to[- ]have',
    "what\\s+we(?:(?:'|’)?\\s*re|\\s+are)\\s+looking\\s+for",
    "what\\s+you(?:(?:'|’)ll|\\s+will)?\\s+bring",
    'who\\s+you\\s+are',
    'about\\s+you',
    'your\\s+(?:background|experience|profile)',
    'you\\s+(?:may|might|could)\\s+be\\s+a\\s+good\\s+fit',
    "you(?:(?:'|’)ll|\\s+will)?\\s+have",
    "it(?:'|’)?s\\s+important\\s+to\\s+us\\s+that\\s+you\\s+have",
    'it\\s+would\\s+be\\s+great\\s+if\\s+you\\s+ha(?:ve|d)',
    'ideal\\s+candidate',
    'skills\\s+(?:and|&)\\s+experience',
  ].join('|') + ')s?\\b|(?:' + [
    '\u61C9\u5FB5\u689D\u4EF6',
    '\u8CC7\u683C\u689D\u4EF6',
    '\u8077\u52D9\u9700\u6C42',
    '\u689D\u4EF6\u8981\u6C42',
    '\u4EFB\u8077\u8CC7\u683C',
    '\u5FC5\u8981\u689D\u4EF6',
    '\u57FA\u672C\u8981\u6C42',
    '\u8077\u4F4D\u8981\u6C42',
    '\u52A0\u5206\u9805\u76EE',
    '\u52A0\u5206\u689D\u4EF6',
  ].join('|') + ')).*$',
  'im'
);

const NON_REQUIREMENT_HEADER_RE = new RegExp(
  '^#{0,6}\\s*(?:(?:' + [
    'you\\s+will(?!\\s+have)',
    'benefits?', 'perks?', 'benefits\\s+and\\s+perks', 'compensation', 'salary', 'pay\\s+range',
    'what\\s+we\\s+offer', 'why\\s+(?:join|work|this\\s+role)',
    'about\\s+(?:us|the\\s+company|the\\s+team|the\\s+role)',
    'how\\s+(?:and\\s+where\\s+)?we\\s+work',
    'equal\\s+opportunity', 'eeo', 'diversity',
    'interview\\s+process', 'how\\s+to\\s+apply', 'to\\s+apply',
    'our\\s+(?:stack|process|values|mission)',
  ].join('|') + ')\\b|(?:' + [
    '\u5DE5\u4F5C\u5167\u5BB9',
    '\u5DE5\u4F5C\u8077\u8CAC',
    '\u8077\u8CAC\u7BC4\u758A',
    '\u798F\u5229',
    '\u85AA\u8CC7',
    '\u85AA\u916C',
    '\u516C\u53F8\u4ECB\u7D39',
    '\u95DC\u65BC\u6211\u5011',
    '\u61C9\u5FB5\u65B9\u5F0F',
    '\u5982\u4F55\u61C9\u5FB5',
  ].join('|') + ')).*$',
  'im'
);

const BULLET_LINE_RE = /^\s*[-*•]\s*(.+)\r?$/;

function stripBoldMarkers(line) {
  return line.replace(/\*\*|__/g, '');
}

const SKILL_TOKEN_RE = /\b([A-Z][A-Za-z0-9+.#]{0,29}[A-Za-z0-9+#](?:\.[a-z]{2,4})?)(?!\w)/g;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'this', 'that', 'these', 'those',
  'must', 'able', 'ability', 'strong', 'excellent', 'proven', 'a', 'an', 'or', 'in', 'of', 'to', 'as', 'is', 'are',
  'bachelor', 'bachelors', 'master', 'masters', 'degree', 'diploma', 'certification', 'certificate',
  'experience', 'years', 'year', 'senior', 'junior', 'entry', 'level', 'minimum', 'preferred', 'required',
  'candidates', 'candidate', 'applicants', 'applicant', 'ideal', 'successful',
  'knowledge', 'understanding', 'familiarity', 'exposure', 'background',
  'skills', 'skill', 'communication', 'team', 'teams', 'work', 'working',
  'deep', 'interest', 'genuine', 'solid', 'comfortable', 'passion', 'passionate',
  'track', 'record', 'real', 'bonus', 'plus', 'hands', 'proficiency', 'fluency',
  'expertise', 'demonstrated', 'extensive', 'practical', 'good', 'great', 'clear',
]);

function scanJd(jdText) {
  const lines = jdText.split('\n');
  const skills = new Set();
  let inRequirementsBlock = false;
  let sawRequirementSection = false;

  for (const line of lines) {
    const headerLine = stripBoldMarkers(line);
    if (NON_REQUIREMENT_HEADER_RE.test(headerLine)) {
      inRequirementsBlock = false;
      continue;
    }
    if (REQUIREMENT_HEADER_RE.test(headerLine)) {
      inRequirementsBlock = true;
      sawRequirementSection = true;
      continue;
    }
    if (inRequirementsBlock && line.trim() === '') continue;
    if (inRequirementsBlock && /^#{1,6}\s/.test(line) && !REQUIREMENT_HEADER_RE.test(headerLine)) {
      inRequirementsBlock = false;
    }

    const bulletMatch = BULLET_LINE_RE.exec(line);
    if (inRequirementsBlock && bulletMatch) {
      const bulletText = bulletMatch[1];
      let m;
      SKILL_TOKEN_RE.lastIndex = 0;
      while ((m = SKILL_TOKEN_RE.exec(bulletText)) !== null) {
        const token = m[1].trim();
        if (!STOPWORDS.has(token.toLowerCase()) && token.length > 1) {
          skills.add(token);
        }
      }
    }
  }
  return { skills: [...skills], sawRequirementSection };
}

function extractJdSkills(jdText) {
  return scanJd(jdText).skills;
}

function diagnoseExtraction(jdText, jdSkills) {
  if (jdSkills.length > 0) return null;

  if (jdText.trim() === '') {
    return {
      reason: 'empty-jd',
      message: 'The JD file is empty, so nothing was checked.',
    };
  }

  if (!scanJd(jdText).sawRequirementSection) {
    return {
      reason: 'no-requirements-section',
      message:
        'No requirements section was recognized in this JD, so no text was scanned for skills. ' +
        'This is not the same as "no gaps": the check did not run. Read the JD yourself before drafting.',
    };
  }

  return {
    reason: 'no-skill-candidates',
    message:
      'A requirements section was found and scanned, but no skill candidates were extracted from it. ' +
      'This is not the same as "no gaps": nothing was classified. Read the JD yourself before drafting.',
  };
}

function skillMentionedInText(skill, text) {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
  return re.test(text);
}

const ANY_HEADING_RE = /^#{1,6}\s/;

const SKILLS_WORD_RE = /\bskills\b/i;
const TOOLS_WORD_RE = /\b(?:tools|technologies|tech\s+stack)\b/i;

function isSkillsHeading(line) {
  const m = String(line).match(/^(#{1,6})(?!#)\s*(.+?)\s*$/);
  if (!m) return false;
  const text = toPlainText(normalizePandocLine(m[2]).replace(/\s*\{[^}]*\}\s*$/, ''));
  return SKILLS_WORD_RE.test(text) || (m[1].length <= 2 && TOOLS_WORD_RE.test(text));
}

function splitSkillsSection(cvText) {
  const named = [];
  const prose = [];
  let inSkills = false;
  for (const line of cvText.split('\n')) {
    const skillsHeading = isSkillsHeading(line);
    if (skillsHeading || ANY_HEADING_RE.test(line)) {
      inSkills = skillsHeading;
      if (!skillsHeading) prose.push(line);
      continue;
    }
    (inSkills ? named : prose).push(line);
  }
  return { namedSkillsText: named.join('\n'), proseText: prose.join('\n') };
}

function classifySkillGaps(jdSkills, cvText) {
  const { namedSkillsText, proseText } = splitSkillsSection(cvText);

  const namedCanon = extractSkills(namedSkillsText);
  const proseCanon = extractSkills(proseText);

  const existing = [];
  const supportedByResume = [];
  const gap = [];

  for (const skill of jdSkills) {
    const canon = canonicalize(skill);
    const known = extractSkills(skill).has(canon);

    if (known && namedCanon.has(canon)) {
      existing.push(skill);
    } else if (known && proseCanon.has(canon)) {
      supportedByResume.push(skill);
    } else if (!known && skillMentionedInText(skill, namedSkillsText)) {
      existing.push(skill);
    } else if (!known && skillMentionedInText(skill, proseText)) {
      supportedByResume.push(skill);
    } else {
      gap.push(skill);
    }
  }

  return { existing, supportedByResume, gap };
}

export { extractJdSkills, skillMentionedInText, classifySkillGaps, diagnoseExtraction };

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const jdPathArg = args.find(a => !a.startsWith('--'));

function runSelfTest() {
  let passed = 0, failed = 0;
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) {
      passed++;
    } else {
      failed++;
      console.log(`  FAIL: ${label}\n    expected: ${e}\n    actual:   ${a}`);
    }
  };

  const fakeJd = `
# Senior Engineer — Fabrikam Inc.

## Requirements
- Python, FastAPI, PostgreSQL
- Experience with Kubernetes
- Strong communication skills
`;
  const fakeCv = `
# Skills
Python, PostgreSQL, Docker

# Experience
Deployed services onto Kubernetes clusters and wrote FastAPI endpoints for internal tools.
`;

  const jdSkills = extractJdSkills(fakeJd);
  eq('extracts Python from requirements bullet', jdSkills.includes('Python'), true);
  eq('extracts Kubernetes from a separate bullet', jdSkills.includes('Kubernetes'), true);
  eq('does not extract stopword "Strong"', jdSkills.includes('Strong'), false);

  const result = classifySkillGaps(['Python', 'PostgreSQL', 'Kubernetes', 'FastAPI', 'Rust'], fakeCv);
  eq('Python classified as existing (named skill)', result.existing.includes('Python'), true);
  eq('Kubernetes classified as supportedByResume (prose only)', result.supportedByResume.includes('Kubernetes'), true);
  eq('FastAPI classified as supportedByResume (prose only)', result.supportedByResume.includes('FastAPI'), true);
  eq('Rust classified as a real gap', result.gap.includes('Rust'), true);

  const trailingSkillsCv = `
# Experience
Worked with Rust in a prior role.

# Skills
Python, Docker, Zookeeper
`;
  const trailingResult = classifySkillGaps(['Python', 'Zookeeper'], trailingSkillsCv);
  eq(
    'trailing Skills section (last in doc, contains a "Z" word) is still captured as named skills',
    trailingResult.existing.includes('Zookeeper'),
    true
  );

  const deepHeadingCv = [
    '# Resume', '',
    '##### Skills', 'Python, Docker, PostgreSQL', '',
    '###### Experience', 'Deployed Kubernetes clusters for internal tools.',
  ].join('\n');
  const deepCvResult = classifySkillGaps(['Python', 'Docker', 'PostgreSQL', 'Kubernetes'], deepHeadingCv);
  eq('an h5 Skills heading is recognized as the named section', deepCvResult.existing.includes('Python'), true);
  eq('the named section stops at the h6 heading (Kubernetes stays prose)', deepCvResult.existing.includes('Kubernetes'), false);
  eq('prose under the h6 still classifies as supportedByResume', deepCvResult.supportedByResume.includes('Kubernetes'), true);

  const pandocSkillsCv = [
    '# Jane Example', '',
    '## **[Technical Platforms & Tools]{.smallcaps}**', '',
    '- Cloud: AWS, Kubernetes, Terraform', '',
    '## **[Professional Experience]{.smallcaps}**', '',
    '### **Acme Technologies** --- New York, NY', '',
    'Migrated the PostgreSQL fleet.',
  ].join('\n');
  const pandocSkillsResult = classifySkillGaps(['AWS', 'Kubernetes', 'Terraform', 'PostgreSQL'], pandocSkillsCv);
  eq('a bold + span "Technical Platforms & Tools" heading is a named skills section',
    pandocSkillsResult.existing.sort(), ['AWS', 'Kubernetes', 'Terraform']);
  eq('a level-3 employer named "... Technologies" is not a skills section',
    pandocSkillsResult.supportedByResume, ['PostgreSQL']);
  for (const heading of ['## Technical Skills', '## **[Skills]{.smallcaps}**', '### Core Skills', '## Technologies', '# Tech Stack', '## Skills {#skills}']) {
    eq(`"${heading}" opens a named skills section`,
      classifySkillGaps(['Python'], `${heading}\nPython\n`).existing, ['Python']);
  }
  const twoSectionsCv = '## Skills\nPython\n\n## Experience\nUsed Docker daily.\n\n## Tools\nTerraform\n';
  const twoSectionsResult = classifySkillGaps(['Python', 'Terraform', 'Docker'], twoSectionsCv);
  eq('every skills section counts, not just the first', twoSectionsResult.existing.sort(), ['Python', 'Terraform']);
  eq('prose between two skills sections stays prose', twoSectionsResult.supportedByResume, ['Docker']);

  const headerVariants = [
    ['bare uppercase "YOU HAVE:" (Ashby default template)', 'YOU HAVE:'],
    ['"You\'ll have"', "You'll have:"],
    ['"You will have"', 'You Will Have:'],
    ['"You might be a good fit if you:"', 'You Might Be a Good Fit If You:'],
    ['"You could be a good fit if you:"', 'You Could Be a Good Fit If You:'],
    ['"It\'s Important To Us That You Have"', "## It's Important To Us That You Have"],
    ['"It Would Be Great if You Had"', '## It Would Be Great if You Had'],
  ];
  for (const [label, heading] of headerVariants) {
    const jd = `# Role\n\n${heading}\n- Hands-on experience with React, TypeScript and AWS\n`;
    const skills = extractJdSkills(jd);
    eq(`${label} opens a requirements block`, skills.includes('React'), true);
  }

  const responsibilitiesJd = `# Role\n\nYOU WILL\n- Ship Kubernetes manifests for the platform team\n`;
  eq(
    '"YOU WILL" (responsibilities) does not open a requirements block',
    extractJdSkills(responsibilitiesJd).includes('Kubernetes'),
    false
  );

  const dutiesAfterRequirementsJd = [
    '# Role', '', 'YOU HAVE:', '- Experience with Python', '',
    'YOU WILL', '- Ship Kubernetes manifests', '- Operate Terraform modules', '',
  ].join('\n');
  const dutiesSkills = extractJdSkills(dutiesAfterRequirementsJd);
  eq('requirements before a bare YOU WILL are still extracted', dutiesSkills.includes('Python'), true);
  eq('bare "YOU WILL" closes an open requirements block (Kubernetes)', dutiesSkills.includes('Kubernetes'), false);
  eq('bare "YOU WILL" closes an open requirements block (Terraform)', dutiesSkills.includes('Terraform'), false);

  eq(
    '"You will have" opens a block despite the YOU WILL exclusion',
    extractJdSkills('# Role\n\nYou Will Have:\n- Experience with Kubernetes\n').includes('Kubernetes'),
    true
  );

  const deepHeadingJd = [
    '##### Requirements', '- Experience with Python', '',
    '##### Benefits', '- Equity and a Carrot subscription', '',
    '###### About Us', '- We use Kubernetes internally for our own platform',
  ].join('\n');
  const deepSkills = extractJdSkills(deepHeadingJd);
  eq('an h5 requirements heading is recognized', deepSkills.includes('Python'), true);
  eq('an h5 heading closes the block (Equity)', deepSkills.includes('Equity'), false);
  eq('an h6 heading stays closed (Kubernetes)', deepSkills.includes('Kubernetes'), false);

  const boilerplateJd = `
# Role

## Requirements
- Bachelor's degree required
- Experience with cross-functional teams (5+ years)
- Communication skills and Ability to self-organize
`;
  const boilerplateSkills = extractJdSkills(boilerplateJd);
  eq('does not extract "Bachelor" as a skill', boilerplateSkills.includes('Bachelor'), false);
  eq('does not extract "Experience" as a skill', boilerplateSkills.includes('Experience'), false);
  eq('does not extract "Communication" as a skill', boilerplateSkills.includes('Communication'), false);
  eq('does not extract "Ability" as a skill', boilerplateSkills.includes('Ability'), false);

  const symbolEdgeJd = `
# Role

## Requirements
- C#, C++ or F# for backend services
- Familiarity with Docker.
`;
  const symbolEdgeSkills = extractJdSkills(symbolEdgeJd);
  eq('extracts C# standalone (symbol-edge boundary)', symbolEdgeSkills.includes('C#'), true);
  eq('extracts C++ standalone (symbol-edge boundary)', symbolEdgeSkills.includes('C++'), true);
  eq('extracts F# standalone (symbol-edge boundary)', symbolEdgeSkills.includes('F#'), true);
  eq('sentence-ending token stays clean ("Docker", not "Docker.")', symbolEdgeSkills.includes('Docker'), true);
  eq('trailing period is not swallowed into the token', symbolEdgeSkills.includes('Docker.'), false);

  for (const header of [
    "What we're looking for",
    'What you will bring',
    'Who you are',
    'About you',
    'You may be a good fit if',
  ]) {
    const jd = `# Role\n\n${header}\n- Experience with Kubernetes and Terraform\n`;
    const found = extractJdSkills(jd);
    eq(`header "${header}" opens a requirements block`, found.includes('Kubernetes'), true);
  }

  const perksJd = `
# Role

## Requirements
- Experience with Kubernetes

Benefits and Perks (US Only)
- Competitive Equity and Healthcare
- Carrot fertility benefits
`;
  const perksSkills = extractJdSkills(perksJd);
  eq('requirement skill still extracted before the perks block', perksSkills.includes('Kubernetes'), true);
  eq('benefit "Equity" is not reported as a skill', perksSkills.includes('Equity'), false);
  eq('benefit "Healthcare" is not reported as a skill', perksSkills.includes('Healthcare'), false);
  eq('benefit "Carrot" is not reported as a skill', perksSkills.includes('Carrot'), false);

  const dispositionJd = `
# Role

## Requirements
- Deep fluency in TypeScript
- Interest in documentation as infrastructure
`;
  const dispositionSkills = extractJdSkills(dispositionJd);
  eq('real skill still extracted alongside a disposition opener', dispositionSkills.includes('TypeScript'), true);
  eq('does not extract "Deep" as a skill', dispositionSkills.includes('Deep'), false);
  eq('does not extract "Interest" as a skill', dispositionSkills.includes('Interest'), false);

  const lineEndingJd = `
# Role

## Requirements
- Python, FastAPI, PostgreSQL
- Experience with Kubernetes
`;
  const lfSkills = extractJdSkills(lineEndingJd.replace(/\r\n/g, '\n'));
  const crlfSkills = extractJdSkills(lineEndingJd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  eq('CRLF JD extracts the same skills as the LF JD', crlfSkills, lfSkills);
  eq('CRLF JD extracts a non-zero number of skills', crlfSkills.length > 0, true);
  const lfClassification = classifySkillGaps(lfSkills, fakeCv);
  const crlfClassification = classifySkillGaps(crlfSkills, fakeCv);
  eq(
    'CRLF JD produces the same classification as the LF JD',
    JSON.stringify(crlfClassification),
    JSON.stringify(lfClassification)
  );

  const aliasCv = `
# Skills
Python, k8s, Postgres

# Experience
Built data pipelines with golang microservices.
`;
  const aliasResult = classifySkillGaps(['Kubernetes', 'PostgreSQL', 'Go', 'Rust'], aliasCv);
  eq('CV "k8s" satisfies JD "Kubernetes" (named section, not a false gap)', aliasResult.existing.includes('Kubernetes'), true);
  eq('CV "Postgres" satisfies JD "PostgreSQL" (named section)', aliasResult.existing.includes('PostgreSQL'), true);
  eq('CV prose "golang" satisfies JD "Go" (supportedByResume)', aliasResult.supportedByResume.includes('Go'), true);
  eq('genuinely-absent Rust is still a real gap', aliasResult.gap.includes('Rust'), true);

  const freeTokenCv = `
# Skills
Python, Fabrikam-SDK

# Experience
Maintained the internal Fabrikam-SDK build.
`;
  const freeResult = classifySkillGaps(['Fabrikam-SDK', 'Contoso-Cloud'], freeTokenCv);
  eq('unknown token present in CV still matches (word-boundary fallback preserved)', freeResult.existing.includes('Fabrikam-SDK'), true);
  eq('unknown token absent from CV is still a real gap', freeResult.gap.includes('Contoso-Cloud'), true);

  const everydayCv = `
# Skills
HubSpot, Google Ads

# Experience
Fine-tuning the funnel to lift ROAS. Willing to go the extra mile; a safe pair of hands.
`;
  const everydayResult = classifySkillGaps(['Fine-tuning', 'Go', 'SAFe'], everydayCv);
  eq('CV prose "Fine-tuning the funnel" leaves JD "Fine-tuning" a gap', everydayResult.gap.includes('Fine-tuning'), true);
  eq('CV prose "go the extra mile" leaves JD "Go" a gap', everydayResult.gap.includes('Go'), true);
  eq('CV prose "a safe pair of hands" leaves JD "SAFe" a gap', everydayResult.gap.includes('SAFe'), true);

  const mlCv = `
# Skills
PyTorch, Fine-tuning, RAG

# Experience
Shipped a support assistant on Llama 3.
`;
  eq('a Skills entry "Fine-tuning" still satisfies JD "Fine-tuning"', classifySkillGaps(['Fine-tuning'], mlCv).existing, ['Fine-tuning']);

  const reactJdSkills = extractJdSkills('## Requirements\n- React.js and TypeScript\n');
  eq('the JD tokenizer yields "React.js" as one token', reactJdSkills, ['React.js', 'TypeScript']);
  eq(
    'JD "React.js" is satisfied by a Skills entry "React.js"',
    classifySkillGaps(reactJdSkills, '# Skills\nReact.js, TypeScript\n').existing,
    ['React.js', 'TypeScript']
  );

  eq(
    'a JD that yields skills is diagnosed as conclusive (no warning)',
    diagnoseExtraction(fakeJd, extractJdSkills(fakeJd)),
    null
  );

  const unreadableJd = `
# Enablement Content Manager

## What you'll do
- Own the ADDIE and SAM design lifecycle for field-facing curriculum
- Build role-based learning paths, certifications and accreditation programs
- Produce e-learning modules, talk tracks, playbooks and demo flows
- Administer the LMS and design assessments and validation programs
`;
  eq('unreadable JD extracts zero skills', extractJdSkills(unreadableJd).length, 0);
  eq(
    'zero skills with no requirements section is reported as no-requirements-section',
    diagnoseExtraction(unreadableJd, extractJdSkills(unreadableJd)).reason,
    'no-requirements-section'
  );

  const parserEmptyJd = `
# Enablement Content Manager

## Requirements
- adult learning principles and instructional design
- blended and scenario-based learning
`;
  eq('parser-empty JD extracts zero skills', extractJdSkills(parserEmptyJd).length, 0);
  eq(
    'zero skills inside a scanned requirements section is reported as no-skill-candidates',
    diagnoseExtraction(parserEmptyJd, extractJdSkills(parserEmptyJd)).reason,
    'no-skill-candidates'
  );

  const lowercaseKnownJd = `
# Role

## Requirements
- python and kubernetes experience
`;
  eq(
    'a lowercase bullet of KNOWN skills still extracts zero candidates',
    extractJdSkills(lowercaseKnownJd).length,
    0
  );
  eq(
    'the vocabulary does know those names, so the empty result is not a coverage gap',
    [...extractSkills('python and kubernetes')].sort().join(','),
    'Kubernetes,Python'
  );
  eq(
    'a parser-empty result is reported as no-skill-candidates, not as a vocabulary gap',
    diagnoseExtraction(lowercaseKnownJd, extractJdSkills(lowercaseKnownJd)).reason,
    'no-skill-candidates'
  );
  eq(
    'the no-skill-candidates message does not claim the vocabulary is missing the terms',
    /vocabulary/i.test(diagnoseExtraction(lowercaseKnownJd, []).message),
    false
  );

  eq(
    'an empty JD is reported as empty-jd',
    diagnoseExtraction('   \n  \n', []).reason,
    'empty-jd'
  );

  const zhJd = `
# PHP 後端工程師

## 應徵條件
- 熟悉 PHP、MySQL、Git
- 具 Linux 基本指令能力

## 工作內容
- 開發 RESTful API
- 維護既有 專案
`;
  const zhSkills = extractJdSkills(zhJd);
  eq('Chinese requirement header (應徵條件) extracts skills', zhSkills.includes('PHP'), true);
  eq('Chinese requirement header extracts MySQL', zhSkills.includes('MySQL'), true);
  eq('Chinese requirement header extracts Git', zhSkills.includes('Git'), true);
  eq('Chinese requirement header extracts Linux', zhSkills.includes('Linux'), true);
  eq('Chinese non-requirement header (工作內容) closes requirement section', zhSkills.includes('RESTful'), false);

  eq('Chinese header diagnosis is conclusive', diagnoseExtraction(zhJd, zhSkills), null);

  console.log(`\njd-skill-gap self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
if (selfTestMode) {
  runSelfTest();
} else {
  if (!jdPathArg || !existsSync(jdPathArg)) {
    console.error('Usage: node jd-skill-gap.mjs <jd-file> [--summary]');
    console.error('       node jd-skill-gap.mjs --self-test');
    process.exit(1);
  }
  if (!existsSync(CV_PATH)) {
    console.error(`Error: cv.md not found at ${CV_PATH}`);
    console.error('Create it there, or point CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR (or a .career-ops-data marker) at the directory that already has it.');
    process.exit(1);
  }

  const jdText = readFileSync(jdPathArg, 'utf-8');
  const cvText = readFileSync(CV_PATH, 'utf-8');
  const jdSkills = extractJdSkills(jdText);
  const result = classifySkillGaps(jdSkills, cvText);
  const diagnosis = diagnoseExtraction(jdText, jdSkills);

  if (summaryMode) {
    console.log(`\nJD Skill-Gap Check`);
    console.log('─'.repeat(40));
    console.log(`JD skills found: ${jdSkills.length}`);
    console.log(`  ✅ Already in Skills section:   ${result.existing.join(', ') || '(none)'}`);
    console.log(`  📝 Mentioned in resume prose:   ${result.supportedByResume.join(', ') || '(none)'}`);
    console.log(`  ⚠️  Real gaps (not found anywhere): ${result.gap.join(', ') || '(none)'}`);
    if (!splitSkillsSection(cvText).namedSkillsText.trim()) {
      console.log('');
      console.log('  ℹ️  No skills section recognized in cv.md (a heading containing "Skills", or a top-level');
      console.log('     "Tools" / "Technologies" / "Tech Stack" heading), so nothing can be "already in Skills section".');
    }

    if (diagnosis) {
      console.log('');
      console.log('  🚨 LOW CONFIDENCE: this is not a clean result.');
      console.log(`     ${diagnosis.message}`);
      console.log(`     (reason: ${diagnosis.reason})`);
    }
  } else {
    console.log(JSON.stringify({ ...result, lowConfidence: diagnosis }, null, 2));
  }
}
}
