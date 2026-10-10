export const STORY_FIELDS = Object.freeze({
  source:     Object.freeze(['Source']),
  situation:  Object.freeze(['S (Situation)', 'Situation']),
  task:       Object.freeze(['T (Task)', 'Task']),
  action:     Object.freeze(['A (Action)', 'Action']),
  result:     Object.freeze(['R (Result)', 'Result']),
  reflection: Object.freeze(['Reflection']),
  tags:       Object.freeze(['Best for questions about']),
});

const HEADING_RE = /^### (.*)$/;
const BLOCK_END_RE = /^#{1,2}\s/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/;
const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function contentLines(content) {
  const noComments = String(content ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  const lines = noComments.split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      const close = lines[i].match(CLOSE_FENCE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      lines[i] = '';
      continue;
    }
    const open = lines[i].match(OPEN_FENCE_RE);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      lines[i] = '';
    }
  }
  return lines;
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function tableDataRows(run) {
  const hasHeader = run.length > 1 && TABLE_SEPARATOR_RE.test(run[1].text);
  const header = hasHeader ? tableCells(run[0].text) : null;
  const storyCol = header ? header.findIndex((c) => /story/i.test(c)) : -1;
  const rows = [];
  for (const [i, { line, text }] of run.entries()) {
    if (hasHeader && i < 2) continue;
    if (TABLE_SEPARATOR_RE.test(text)) continue;
    const cells = tableCells(text);
    const label = (storyCol >= 0 && cells[storyCol])
      || cells.find((c) => c && !/^#?\d*$/.test(c))
      || '';
    rows.push({ line, text: text.trim(), cells, label });
  }
  return rows;
}

export function splitStoryBlocks(content) {
  const lines = contentLines(content);
  const blocks = [];
  const tableRows = [];
  const trailing = [];
  let current = null;
  let run = [];
  let segment = null;
  let cutBy = null;

  const flushRun = () => {
    const story = blocks.length - 1;
    if (run.length) tableRows.push(...tableDataRows(run).map((r) => ({ ...r, story })));
    run = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const heading = text.match(HEADING_RE);

    if (TABLE_ROW_RE.test(text)) {
      current = null;
      segment = null;
      cutBy = 'table';
      run.push({ line: i + 1, text });
      continue;
    }
    flushRun();

    if (heading) {
      const header = heading[1].trim();
      const themeMatch = header.match(/^\[([^\]]+)\]\s*(.+)/);
      current = {
        header,
        theme: themeMatch ? themeMatch[1].trim() : '',
        title: themeMatch ? themeMatch[2].trim() : header,
        bodyLines: [],
        line: i + 1,
      };
      blocks.push(current);
      segment = null;
      continue;
    }

    if (BLOCK_END_RE.test(text)) {
      current = null;
      segment = null;
      cutBy = 'heading';
      continue;
    }

    if (current) {
      current.bodyLines.push(text);
    } else if (blocks.length && text.trim()) {
      if (!segment) {
        segment = { story: blocks.length - 1, line: i + 1, after: cutBy, lines: [] };
        trailing.push(segment);
      }
      segment.lines.push(text);
    }
  }
  flushRun();

  return {
    blocks: blocks.map(({ bodyLines, ...b }) => {
      const body = bodyLines.join('\n').trim();
      return { ...b, body, raw: `${b.header}\n${body}` };
    }),
    tableRows,
    trailing: trailing.map(({ lines: segLines, ...t }) => ({ ...t, text: segLines.join('\n') })),
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getField(body, labels) {
  const text = String(body ?? '');
  for (const label of labels) {
    const re = new RegExp(`^[ \\t]*(?:[-*+>][ \\t]+)?\\*\\*${escapeRegExp(label)}:\\*\\*[ \\t]*(.+)$`, 'gm');
    for (const hit of text.matchAll(re)) {
      if (hit[1].trim()) return hit[1].trim();
    }
  }
  return '';
}

export function isValidStory(block) {
  return Boolean(block && block.title && getField(block.body, STORY_FIELDS.action));
}

export function parseStories(content) {
  return splitStoryBlocks(content).blocks.filter(isValidStory).map((b) => {
    const tagsRaw = getField(b.body, STORY_FIELDS.tags);
    return {
      title:      b.title,
      theme:      b.theme,
      source:     getField(b.body, STORY_FIELDS.source),
      situation:  getField(b.body, STORY_FIELDS.situation),
      task:       getField(b.body, STORY_FIELDS.task),
      action:     getField(b.body, STORY_FIELDS.action),
      result:     getField(b.body, STORY_FIELDS.result),
      reflection: getField(b.body, STORY_FIELDS.reflection),
      tags:       tagsRaw ? tagsRaw.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
      line:       b.line,
    };
  });
}
