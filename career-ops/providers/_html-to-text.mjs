import { decodeEntities } from './_html-entities.mjs';

export const DESCRIPTION_CAP = 4000;

const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;
const HTML_MEDIA_RE = /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;

function stripMarkup(content) {
  return content.replace(HTML_MEDIA_RE, ' ').replace(HTML_TAG_RE, ' ');
}

export function htmlToText(content) {
  if (typeof content !== 'string' || !content) return '';
  const decoded = decodeEntities(stripMarkup(content));
  const decodedTwice = decodeEntities(stripMarkup(decoded));
  return stripMarkup(decodedTwice)
    .replace(/<(?=\/?[a-z!?])/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_CAP);
}
