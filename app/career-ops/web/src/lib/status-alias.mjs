export const STATUS_ALIAS = {
  evaluada: "EVALUATED",
  condicional: "EVALUATED",
  hold: "EVALUATED",
  evaluar: "EVALUATED",
  verificar: "EVALUATED",
  "değerlendirildi": "EVALUATED",
  degerlendirildi: "EVALUATED",
  evaluado: "EVALUATED",
  aplicado: "APPLIED",
  enviada: "APPLIED",
  aplicada: "APPLIED",
  sent: "APPLIED",
  "başvuruldu": "APPLIED",
  basvuruldu: "APPLIED",
  respondido: "RESPONDED",
  "yanıt verildi": "RESPONDED",
  "yanıt_verildi": "RESPONDED",
  "yanit verildi": "RESPONDED",
  yanit_verildi: "RESPONDED",
  respondida: "RESPONDED",
  contestada: "RESPONDED",
  entrevista: "INTERVIEW",
  "mülakat": "INTERVIEW",
  mulakat: "INTERVIEW",
  oferta: "OFFER",
  teklif: "OFFER",
  rechazado: "REJECTED",
  rechazada: "REJECTED",
  reddedildi: "REJECTED",
  descartado: "DISCARDED",
  descartada: "DISCARDED",
  cerrada: "DISCARDED",
  cancelada: "DISCARDED",
  "iptal edildi": "DISCARDED",
  iptal_edildi: "DISCARDED",
  "ıptal edildi": "DISCARDED",
  "ıptal_edildi": "DISCARDED",
  duplicado: "DISCARDED",
  repost: "DISCARDED",
  no_aplicar: "SKIP",
  "no aplicar": "SKIP",
  skip: "SKIP",
  monitor: "SKIP",
  "geo blocker": "SKIP",
  geo_blocker: "SKIP",
  "uygun değil": "SKIP",
  "uygun_değil": "SKIP",
  "uygun degil": "SKIP",
  uygun_degil: "SKIP",
  contratado: "HIRED",
  contratada: "HIRED",
  hired: "HIRED",
  accepted: "HIRED",
  accept: "HIRED",
  "kabul edildi": "HIRED",
  kabul_edildi: "HIRED",
  "işe alındı": "HIRED",
  "ise alindi": "HIRED",
  "işe alindi": "HIRED",
};

function foldStatus(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "")
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u0307/gu, "");
}

export function canonStatus(s) {
  const k = foldStatus(s);
  if (k === "" || k === "—" || k === "-") return "DISCARDED";
  return STATUS_ALIAS[k] ?? k.toUpperCase();
}
