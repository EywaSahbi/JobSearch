const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();
const clean = (s) => collapse(s).slice(0, 80);

export function snapshotLabel(facts = {}) {
  return clean(labelSource(facts));
}

const labelSource = (facts) => facts.aria || facts.placeholder || facts.text || facts.value || facts.name;

const names = (facts) => {
  const seen = new Set();
  const out = [];
  for (const raw of [facts.aria, facts.placeholder, facts.text, facts.value, facts.title, facts.alt]) {
    const s = collapse(raw);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
};

const SUBMIT_TERMS = [
  "submit", "send application", "finish( application)?", "complete application", "apply (and|&) submit",
  "enviar", "finalizar",
  "absenden", "abschicken", "bewerbung senden",
  "envoyer", "soumettre",
  "invia",
  "enviar candidatura", "submeter",
  "verzend(en)?", "verstu(ur|ren)", "sollicitatie (versturen|verzenden)",
  "wyślij",
  "отправить", "откликнуться",
  "gönder", "başvur",
];

const IN_FORM_TERMS = [
  "apply( now| for this job)?",
  "postuler", "candidati", "candidatar-se", "solliciteren", "solliciteer", "aplikuj", "bewerben",
  "send",
];

const CJK_SUBMIT_TERMS = [
  "提出", "送信",
  "提交", "发送", "發送",
  "제출", "보내기",
];
const CJK_IN_FORM_TERMS = [
  "応募",
  "申请", "申請", "投递", "投遞",
  "지원",
];

const wordRx = (terms) => new RegExp(`(^|[^\\p{L}])(${terms.join("|")})($|[^\\p{L}])`, "iu");

export const SUBMIT_RX = wordRx(SUBMIT_TERMS);

export const IN_FORM_RX = wordRx(IN_FORM_TERMS);

const substringRx = (terms) => new RegExp(terms.join("|"), "u");

export const CJK_SUBMIT_RX = substringRx(CJK_SUBMIT_TERMS);

export const CJK_IN_FORM_RX = substringRx(CJK_IN_FORM_TERMS);

const namesSubmit = (s) => SUBMIT_RX.test(s) || CJK_SUBMIT_RX.test(s);
const namesInFormAction = (s) => IN_FORM_RX.test(s) || CJK_IN_FORM_RX.test(s);

const isClickable = (tag, type, role) =>
  tag === "button" || tag === "a" || role === "button" || role === "link" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type));

export function isSubmitControl(facts = {}) {
  const tag = (facts.tag || "").toLowerCase();
  const type = (facts.type || "").toLowerCase();
  const role = (facts.role || "").toLowerCase();
  if (tag === "input" && (type === "submit" || type === "image")) return true;
  const declared = ["submit", "reset", "button"].includes(type);
  if (tag === "button" && (type === "submit" || (!declared && facts.inForm))) return true;
  const named = names(facts);
  if (isClickable(tag, type, role) && named.some(namesSubmit)) return true;
  if (facts.inForm && isClickable(tag, type, role) && named.some(namesInFormAction)) return true;
  if (!named.length && facts.inForm && isClickable(tag, type, role)) return true;
  return false;
}
