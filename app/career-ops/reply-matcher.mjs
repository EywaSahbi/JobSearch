import { isPlaceholderCompany } from './lib/placeholder-cell.mjs';

export function extractDomain(emailStr) {
  if (!emailStr) return null;
  const match = emailStr.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeStr(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

export function normalizeChinese(s) {
  return (s || '')
    .replace(/有限公司/g, '')
    .replace(/公司/g, '')
    .replace(/股份/g, '')
    .replace(/集团/g, '')
    .trim();
}

const SHORT_NAME_MAX = 3;

const NO_WORD_SEPARATOR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function matchesOnWordBoundary(text, company) {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(text);
}

export function checkCompanyMatch(text, company) {
  if (!company || !text) return false;
  if (isPlaceholderCompany(company)) return false;

  const wordMaterial = company.replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  const isShortName = Array.from(wordMaterial).length <= SHORT_NAME_MAX;
  if (isShortName && !NO_WORD_SEPARATOR_RE.test(company)) {
    return matchesOnWordBoundary(text, company);
  }

  if (text.includes(company)) return true;
  
  const textLower = text.toLowerCase();
  const compLower = company.toLowerCase();
  
  if (textLower.includes(compLower)) return true;

  const tNorm = normalizeStr(text);
  const cNorm = normalizeStr(company);
  if (cNorm.length > 2 && tNorm.includes(cNorm)) return true;

  const cChi = normalizeChinese(company);
  if (cChi && cChi.length >= 2 && text.includes(cChi)) return true;

  return false;
}

const GENERIC_ROLE_WORDS = new Set([
  'talent', 'acquisition', 'specialist', 'coordinator', 'operations',
  'recruiter', 'recruiting', 'human', 'resources', 'people'
]);

const CJK_RE = /[一-鿿㐀-䶿]/;

const LATIN_WORD_RE = /^[\p{Script=Latin}\p{M}\p{N}]+$/u;

const MAX_BOUNDARY_NEEDLE = 128;

function isSingleWordRole(role) {
  const parts = role.split(/[\s_\\/()-]+/).filter(Boolean);
  return parts.length === 1 && !CJK_RE.test(parts[0]);
}

export function checkRoleMatchExact(text, role) {
  if (!role || !text) return false;
  if (isSingleWordRole(role)) return false;

  const tNorm = normalizeStr(text);
  const rNorm = normalizeStr(role);
  if (!rNorm) return false;
  if (tNorm.includes(rNorm)) return true;

  const cleanRole = role.replace(/[\s_\\/()-]+/g, '');
  if (cleanRole.length > 2 && tNorm.includes(cleanRole.toLowerCase())) return true;

  return false;
}

export function checkRoleMatch(text, role) {
  if (!role || !text) return false;

  if (checkRoleMatchExact(text, role)) return true;

  const tNorm = normalizeStr(text);

  const roleParts = role.split(/[\s_\\/()-]+/);
  for (const part of roleParts) {
    if (part.length <= 3) continue;

    const stripped = part.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
    const bare = stripped.toLowerCase();

    if (!LATIN_WORD_RE.test(bare) || stripped.length > MAX_BOUNDARY_NEEDLE) {
      if (!GENERIC_ROLE_WORDS.has(part.toLowerCase()) && tNorm.includes(normalizeStr(part))) return true;
      continue;
    }

    if (bare.length <= 3 || GENERIC_ROLE_WORDS.has(bare)) continue;

    if (matchesOnWordBoundary(text, stripped)) {
      return true;
    }
  }

  return false;
}

const SHARED_DOMAINS = [
  'linkedin.com',
  'applytojob.com',
  'greenhouse.io',
  'lever.co',
  'icims.com',
  'myworkday.com',
  'ashbyhq.com',
  'smartrecruiters.com',
  'taleo.net',
  'successfactors.com',
  'gmail.com',
  'outlook.com',
  'yahoo.com',
  'hotmail.com'
];

const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

const FILE_EXTENSIONS = [
  'pdf', 'md', 'doc', 'docx', 'txt', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'csv', 'tsv', 'json', 'yaml', 'yml', 'mjs'
];

function isUsableDomain(domain) {
  if (!DOMAIN_SHAPE.test(domain)) return false;
  if (FILE_EXTENSIONS.includes(domain.slice(domain.lastIndexOf('.') + 1))) return false;
  return !SHARED_DOMAINS.some(shared => domain === shared || domain.endsWith(`.${shared}`));
}

function addDomain(domains, value) {
  const domain = (value || '').toLowerCase();
  if (isUsableDomain(domain)) domains.add(domain);
}

export function getAppDomains(app, followups) {
  const domains = new Set();
  
  if (app.notes) {
    const emails = app.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
    for (const email of emails) {
      addDomain(domains, extractDomain(email));
    }
    const words = app.notes.split(/\s+/);
    for (const w of words) {
      if (w.includes('.') && !w.includes('@')) {
        addDomain(domains, w.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, ''));
      }
    }
  }

  const appFollowups = followups.filter(f => f.appNum === app.num);
  for (const fu of appFollowups) {
    if (fu.contact) {
      addDomain(domains, extractDomain(fu.contact));
    }
    if (fu.notes) {
       const emails = fu.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
       for (const email of emails) {
         addDomain(domains, extractDomain(email));
       }
    }
  }

  const cNorm = normalizeStr(app.company);
  if (cNorm && cNorm !== '?') {
    addDomain(domains, `${cNorm}.com`);
    addDomain(domains, `${cNorm}.co`);
    addDomain(domains, `${cNorm}.io`);
  }

  return Array.from(domains);
}

function comparableDateRange(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const approximate = value.match(/^~(\d{4})-(\d{2})$/);
  if (approximate) {
    const year = Number(approximate[1]);
    const month = Number(approximate[2]);
    if (month < 1 || month > 12) return null;
    return {
      earliest: Date.UTC(year, month - 1, 1),
      latest: Date.UTC(year, month, 1) - 1,
    };
  }
  const calendarDate = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/i);
  let calendarInstant = null;
  if (calendarDate) {
    const year = Number(calendarDate[1]);
    const month = Number(calendarDate[2]);
    const day = Number(calendarDate[3]);
    calendarInstant = Date.UTC(year, month - 1, day);
    const date = new Date(calendarInstant);
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { earliest: calendarInstant, latest: calendarInstant };
  }
  if (
    /^\d{4}-\d{2}-\d{2}T/i.test(value)
    && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  ) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return { earliest: parsed, latest: parsed };
}

function candidateReceivedAt(cand) {
  return comparableDateRange(
    cand?.received_at ?? cand?.receivedAt ?? cand?.email_date ?? cand?.date,
  );
}

function canonicalStatus(raw) {
  return String(raw ?? '').replace(/\*\*/g, '').trim().toLowerCase();
}

function companyKey(raw) {
  return normalizeStr(normalizeChinese(String(raw ?? ''))).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function companyWideEligible(app, emailRange) {
  if (!emailRange || !['applied', 'evaluated'].includes(canonicalStatus(app?.status))) return false;
  const appliedRange = comparableDateRange(app?.date);
  if (!appliedRange) return false;
  return appliedRange.latest <= emailRange.earliest;
}

export function matchCandidates(candidates, apps, followups = []) {
  const results = [];
  
  for (const cand of candidates) {
    const textContext = `${cand.from || ''} ${cand.subject || ''} ${cand.body_snippet || ''}`;
    const fromDomain = extractDomain(cand.from);
    
    let bestMatches = [];
    let highestScore = -1;
    let anyRoleMatch = false;
    
    for (const app of apps) {
      let score = 0;
      let signals = [];
      let companyHint = '';
      let roleHint = '';
      
      const isCompanyMatch = checkCompanyMatch(textContext, app.company);
      if (isCompanyMatch) {
        score += 2;
        signals.push('company-name');
        companyHint = app.company;
      }

      let hasDomainMatch = false;
      if (fromDomain) {
        const appDomains = getAppDomains(app, followups);
        if (appDomains.some(d => fromDomain === d || fromDomain.endsWith(`.${d}`))) {
          hasDomainMatch = true;
          score += 2;
          signals.push('sender-domain');
          companyHint = companyHint || app.company;
        }
      }

      const isRoleExactMatch = checkRoleMatchExact(textContext, app.role);
      const isRolePartialMatch = !isRoleExactMatch && checkRoleMatch(textContext, app.role);
      if (isRoleExactMatch || isRolePartialMatch) anyRoleMatch = true;
      const isRoleMatch = isRoleExactMatch || (isRolePartialMatch && (isCompanyMatch || hasDomainMatch));
      if (isRoleMatch) {
        score += 1.5;
        signals.push('role-title');
        roleHint = app.role;
      }

      const postAppKeywords = ['interview', 'offer', 'rejection', '邀您面试', '简历通过', 'next steps', 'update on your application'];
      const strongSignals = ['interview_invite', 'offer', 'rejection'];
      const hasPostAppKeyword = (cand.signal && strongSignals.includes(cand.signal)) 
        || postAppKeywords.some(k => textContext.toLowerCase().includes(k.toLowerCase()));
      
      if (hasPostAppKeyword && (isCompanyMatch || hasDomainMatch)) {
         signals.push('post-application-keyword');
      }

      if (score > 0) {
        let confidence = 'low';
        if ((isCompanyMatch || hasDomainMatch) && isRoleMatch) {
          confidence = 'high';
        } else if ((isCompanyMatch || hasDomainMatch) && hasPostAppKeyword) {
          confidence = 'high';
        } else if (isCompanyMatch || hasDomainMatch) {
          confidence = 'medium';
        } else if (isRoleMatch) {
          confidence = 'low';
        }
        
        const matchInfo = {
          message_id: cand.message_id,
          company_hint: companyHint || app.company,
          role_hint: roleHint || app.role,
          application_num: app.num,
          confidence,
          signals: Array.from(new Set(signals)),
          score
        };
        
        if (score > highestScore) {
          highestScore = score;
          bestMatches = [matchInfo];
        } else if (score === highestScore) {
          bestMatches.push(matchInfo);
        }
      }
    }
    
    if (bestMatches.length === 1) {
      const match = bestMatches[0];
      delete match.score;
      results.push(match);
    } else if (bestMatches.length > 1) {
      const tiedApps = bestMatches
        .map(match => apps.find(app => app.num === match.application_num))
        .filter(Boolean);
      const tiedCompanies = new Set(tiedApps.map(app => companyKey(app.company)).filter(Boolean));
      const emailRange = candidateReceivedAt(cand);
      const isRejection = classifyReply(cand).type === 'Rejected';
      const eligible = tiedApps.filter(app => companyWideEligible(app, emailRange));

      if (isRejection && !anyRoleMatch && tiedCompanies.size === 1 && eligible.length > 0) {
        results.push({
          message_id: cand.message_id,
          company_hint: eligible[0].company,
          role_hint: '',
          application_num: null,
          application_nums: eligible.map(app => app.num),
          confidence: 'medium',
          signals: ['company-wide-rejection'],
        });
      } else {
        results.push({
          message_id: cand.message_id,
          company_hint: cand.from,
          role_hint: '',
          application_num: null,
          confidence: 'low',
          signals: ['ambiguous-match'],
        });
      }
    } else {
      results.push({
        message_id: cand.message_id,
        company_hint: fromDomain || cand.from,
        role_hint: '',
        application_num: null,
        confidence: 'low',
        signals: ['no-match']
      });
    }
  }
  
  return results;
}

export function classifyReply(cand) {
  const subject = cand.subject || '';
  const body = cand.body_snippet || '';
  const text = `${cand.from || ''} ${subject} ${body}`;
  const textLower = text.toLowerCase();
  const signal = cand.signal || '';

  const evidence = [];

  const check = (keywords) => {
    let found = false;
    for (const kw of keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        evidence.push(kw);
        found = true;
      }
    }
    return found;
  };

  const noiseKeywords = [
    '邀请投递', '抢面试先机', '近期热招', '立即投递', '热招职位', '订阅职位', '职位推荐', '推荐职位',
    'job alert', 'invitation to apply', 'recommended jobs', 'newsletter', 'marketing digest', 'job recommendation', 'suggested jobs'
  ];

  const offerKeywords = [
    '录取通知书', '录用信', '录用通知', '录用', '薪资确认', '入职协议', '意向书',
    'offer letter', 'employment agreement', 'job offer', 'congratulations on the offer', 'compensation details', 'pleased to offer'
  ];

  const rejectionKeywords = [
    '很遗憾', '暂不匹配', '不合适', '未能进入下一轮', '感谢您的时间', '未通过', '不再考虑', '决定不推进',
    'unfortunately', 'not a match', 'not matching', 'decided not to proceed', 'will not be moving forward', 'position has been filled', 'role has been closed', 'unable to offer'
  ];

  const autoKeywords = [
    '自动回复', '收到您的申请', '申请已收到', '投递成功', '确认收到',
    'thank you for applying', 'application received', 'received your application', 'auto-confirmation', 'confirmation of application', 'automatic reply'
  ];

  const actionKeywords = [
    '补充信息', '提供信息', '完成测评', '在线测评', '笔试题', '做个测试', '截止日期前', '截止时间',
    'complete a form', 'provide information', 'finish an assessment', 'coding challenge', 'online test', 'respond by a deadline', 'pick a time', 'schedule a time', 'book a time',
    'complete assessment', 'take a test', 'assessment', 'coding test', 'deadline', 'fill out', 'complete the form', 'provide details', 'submit info'
  ];

  const interviewKeywords = [
    '邀您面试', '邀约面试', '微信小程序面试', 'AI微信小程序', '面试形式', '面试时间', '面试时长', '安排面试', '预约面试', '首轮面试', '视频面试', '电话面试', '现场面试', '面试邀请', '面试流程', '简历通过',
    'interview invitation', 'schedule an interview', 'scheduling link', 'ai interview', 'video interview', 'phone screen', 'onsite interview', 'final round', 'invite you to interview', 'interview request', 'interview schedule'
  ];

  const respondedKeywords = [
    '联系您', '回复您', '想沟通', '想聊聊', '进一步沟通',
    'would like to chat', 'reach out', 'connect with you', 'hiring manager responded'
  ];

  const isNoise = check(noiseKeywords);
  if (isNoise) {
    return {
      type: 'Noise',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  const hasRejectionKeywords = check(rejectionKeywords);
  const isRejected = signal === 'rejection' || hasRejectionKeywords;
  if (isRejected) {
    if (signal === 'rejection' && !evidence.includes('rejection')) evidence.push('rejection');
    return {
      type: 'Rejected',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Rejected'
    };
  }

  const hasOfferKeywords = check(offerKeywords);
  const isOffer = signal === 'offer' || hasOfferKeywords;
  if (isOffer) {
    if (signal === 'offer' && !evidence.includes('offer')) evidence.push('offer');
    return {
      type: 'Offer',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Offer'
    };
  }

  const isAuto = check(autoKeywords);
  if (isAuto) {
    return {
      type: 'Auto-confirmation',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  const isAction = check(actionKeywords);
  if (isAction) {
    const hasSchedulingWording = textLower.includes('schedule') || textLower.includes('pick a time') || textLower.includes('book a time') || textLower.includes('book a slot') ||
                                 textLower.includes('choose a time') || textLower.includes('select a time') || textLower.includes('appointment') ||
                                 text.includes('预约') || text.includes('选择时间') || text.includes('选择面试') || text.includes('安排时间');
    return {
      type: 'Need Action',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: hasSchedulingWording ? 'Interview' : 'Responded'
    };
  }

  const hasInterviewKeywords = check(interviewKeywords);
  const isInterview = signal === 'interview_invite' || hasInterviewKeywords;
  if (isInterview) {
    if (signal === 'interview_invite' && !evidence.includes('interview_invite')) evidence.push('interview_invite');
    return {
      type: 'Interview',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Interview'
    };
  }

  const hasRespondedKeywords = check(respondedKeywords);
  const isResponded = signal === 'update' || hasRespondedKeywords;
  if (isResponded) {
    if (signal === 'update' && !evidence.includes('update')) evidence.push('update');
    return {
      type: 'Responded',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Responded'
    };
  }

  const recruitingTerms = [
    'application', 'career', 'job', 'recruiter', 'hiring', 'interview', 'resume',
    '简历', '职位', '招聘', '应聘'
  ];
  const isRecruiting = recruitingTerms.some(term => textLower.includes(term.toLowerCase()));
  if (isRecruiting) {
    return {
      type: 'Unknown',
      evidence: [],
      suggestedTrackerUpdate: 'Needs Review'
    };
  }

  return {
    type: 'Unknown',
    evidence: [],
    suggestedTrackerUpdate: 'Needs Review'
  };
}

