// A small markdown reader for text the pond wrote, which becomes React elements and never HTML.
// The app has no markdown package, so this takes the parts a result uses and leaves the rest as text.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "ul"; items: Block[][] }
  | { t: "ol"; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" };

/** Only links that leave the app for a web page or a mail client; anything else is shown as its text. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const ESCAPABLE = "\\`*_{}[]()#+-.!|<>~";
const LINK = /^\[((?:[^[\]\\]|\\.)*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/;
const MAX_DEPTH = 8;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/** The next single `ch` that can close an emphasis, skipping doubled ones and ones that follow a space. */
function closeOf(s: string, from: number, ch: string): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== ch) continue;
    if (s[j + 1] === ch) {
      j++;
      continue;
    }
    if (s[j - 1] !== " ") return j;
  }
  return -1;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") {
      out.push({ t: "text", v: text });
      text = "";
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const close = s.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (c === "!" && s[i + 1] === "[") {
      const image = LINK.exec(s.slice(i + 1));
      if (image) {
        text += image[1];
        i += 1 + image[0].length;
        continue;
      }
    }
    if (c === "[") {
      const link = LINK.exec(s.slice(i));
      if (link) {
        flush();
        const inner = parseInline(link[1]);
        if (SAFE_LINK.test(link[2])) out.push({ t: "link", href: link[2], c: inner });
        else out.push(...inner);
        i += link[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c && (c === "*" || !isAlnum(s[i - 1]))) {
      const close = s.indexOf(c + c, i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] !== c && s[i + 1] !== " " && s[i + 1] !== undefined && (c === "*" || !isAlnum(s[i - 1]))) {
      const close = closeOf(s, i + 1, c);
      if (close > i + 1 && (c === "*" || !isAlnum(s[close + 1]))) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function closesFence(line: string, marker: string, length: number): boolean {
  const t = line.trim();
  return t.length >= length && [...t].every((ch) => ch === marker);
}

/** Whether `line` opens something other than a paragraph; a paragraph is only cut by a list that starts at 1 or is a bullet. */
function startsBlock(line: string, insideParagraph: boolean): boolean {
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const list = LIST.exec(line);
  if (!list) return false;
  return !insideParagraph || !/\d/.test(list[2]) || parseInt(list[2], 10) === 1;
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = LIST.exec(lines[start]) as RegExpExecArray;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const items: Block[][] = [];
  const sibling = (line: string | undefined): boolean => {
    const m = line === undefined ? null : LIST.exec(line);
    return m !== null && m[1].length === baseIndent && /\d/.test(m[2]) === ordered;
  };
  let i = start;
  while (i < lines.length && sibling(lines[i])) {
    const m = LIST.exec(lines[i]) as RegExpExecArray;
    const markerWidth = m[1].length + m[2].length + 1;
    const itemLines = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && indentOf(lines[j]) > baseIndent) {
          itemLines.push("");
          i++;
          continue;
        }
        break;
      }
      const indent = indentOf(l);
      if (indent > baseIndent) {
        itemLines.push(l.slice(Math.min(indent, markerWidth)));
        i++;
        continue;
      }
      if (LIST.test(l) || startsBlock(l, true) || itemLines[itemLines.length - 1] === "") break;
      itemLines.push(l.trim());
      i++;
    }
    items.push(parseBlocks(itemLines, depth + 1));
    let j = i;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (sibling(lines[j])) i = j;
    else break;
  }
  return { block: ordered ? { t: "ol", start: startNumber, items } : { t: "ul", items }, next: i };
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence[1][0], fence[1].length)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push({ t: "code", lang: fence[2], v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      out.push({ t: "quote", c: parseBlocks(inner, depth + 1) });
      continue;
    }
    if (depth < MAX_DEPTH && LIST.test(line)) {
      const list = parseList(lines, i, depth);
      out.push(list.block);
      i = list.next;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (paragraph.length === 0 || !startsBlock(lines[i], true))) {
      paragraph.push(lines[i].trim());
      i++;
    }
    out.push({ t: "p", c: parseInline(paragraph.join(" ")) });
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}
