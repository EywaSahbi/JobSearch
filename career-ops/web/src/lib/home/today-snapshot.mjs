import { pickAwaitingDecision } from "./awaiting.mjs";

export function todaySnapshot({ applications, inbox }, scoreOf) {
  return {
    applications: pickAwaitingDecision(applications, scoreOf, Infinity),
    inbox: inbox.map(({ url, done }) => ({ url, done })),
  };
}
