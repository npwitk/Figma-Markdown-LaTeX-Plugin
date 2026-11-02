// Markdown + LaTeX Formatter
// Turns Obsidian-flavoured markdown in a text layer into styled Figma text,
// using style "slots" (H1, Bold, Code, ...) that you can capture from your own layers.

// ============================================================================
// Types
// ============================================================================

type SlotKey =
  | "title" | "h1" | "h2" | "h3" | "h4" | "body"
  | "bold" | "italic" | "boldItalic" | "code" | "highlight"
  | "tableHeader" | "tableCell";

const BLOCK_SLOTS: SlotKey[] = ["title", "h1", "h2", "h3", "h4", "body", "tableHeader", "tableCell"];
const MODIFIER_SLOTS: SlotKey[] = ["bold", "italic", "boldItalic", "code", "highlight"];
const ALL_SLOTS: SlotKey[] = [...BLOCK_SLOTS, ...MODIFIER_SLOTS];

interface StyleSpec {
  /** Full font. Wins over `fontStyle`. */
  fontName?: FontName;
  /** Style only (e.g. "Semibold"), applied to the surrounding text's family. */
  fontStyle?: string;
  fontSize?: number;
  fills?: Paint[];
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  textDecoration?: TextDecoration;
  textCase?: TextCase;
  /** Figma text style captured from a layer (used if it exists in the current file). */
  textStyleId?: string;
  textStyleName?: string;
}

interface TableOptions {
  cellPaddingX: number;
  cellPaddingY: number;
  dividerColor: string; // hex
}

interface Settings {
  version: 1;
  slots: Partial<Record<SlotKey, StyleSpec>>;
  table: TableOptions;
}

const hex = (h: string): RGB => {
  const s = h.replace("#", "");
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
};
const solid = (h: string): Paint[] => [{ type: "SOLID", color: hex(h) }];

// Defaults roughly follow the user's sheet; everything is overridable / capturable.
const DEFAULT_SLOTS: Partial<Record<SlotKey, StyleSpec>> = {
  title: { fontStyle: "Bold", fontSize: 33, fills: solid("D0342C"), textDecoration: "UNDERLINE" },
  h1: { fontStyle: "Bold", fontSize: 28, fills: solid("5731E3") },
  h2: { fontStyle: "Semibold", fontSize: 24, fills: solid("000000") },
  h3: { fontStyle: "Regular", fontSize: 22, fills: solid("000000") },
  h4: { fontStyle: "Regular", fontSize: 20, fills: solid("000000") },
  bold: { fontStyle: "Bold" },
  italic: { fontStyle: "Italic" },
  boldItalic: { fontStyle: "Bold Italic" },
  code: { fills: solid("D0342C"), letterSpacing: { value: 5, unit: "PERCENT" } },
  highlight: { textDecoration: "UNDERLINE" },
  tableHeader: { fontStyle: "Semibold" },
};

const DEFAULT_TABLE: TableOptions = { cellPaddingX: 28, cellPaddingY: 8, dividerColor: "C4C4C4" };

const STORAGE_KEY = "styles.v1";

// ============================================================================
// Storage (per Figma file)
// ============================================================================

function loadSaved(): Settings {
  try {
    const raw = figma.root.getPluginData(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        slots: parsed.slots || {},
        table: Object.assign({}, DEFAULT_TABLE, parsed.table || {}),
      };
    }
  } catch (e) {
    console.error("Could not read saved styles", e);
  }
  return { version: 1, slots: {}, table: Object.assign({}, DEFAULT_TABLE) };
}

function save(settings: Settings) {
  figma.root.setPluginData(STORAGE_KEY, JSON.stringify(settings));
}

/** Saved slots merged over defaults. */
function effectiveSlots(settings: Settings): Partial<Record<SlotKey, StyleSpec>> {
  return Object.assign({}, DEFAULT_SLOTS, settings.slots);
}

function sanitizeImported(data: unknown): Settings {
  if (!data || typeof data !== "object") throw new Error("Not a JSON object");
  const d = data as { slots?: Record<string, StyleSpec>; table?: Partial<TableOptions> };
  const slots: Partial<Record<SlotKey, StyleSpec>> = {};
  for (const key of ALL_SLOTS) {
    if (d.slots && d.slots[key]) slots[key] = d.slots[key];
  }
  return { version: 1, slots, table: Object.assign({}, DEFAULT_TABLE, d.table || {}) };
}

// ============================================================================
// Font resolution (so "Bold" never silently becomes Inter)
// ============================================================================

let fontIndexPromise: Promise<Map<string, string[]>> | null = null;

function fontIndex(): Promise<Map<string, string[]>> {
  if (!fontIndexPromise) {
    fontIndexPromise = figma.listAvailableFontsAsync().then((fonts) => {
      const map = new Map<string, string[]>();
      for (const f of fonts) {
        const list = map.get(f.fontName.family) || [];
        list.push(f.fontName.style);
        map.set(f.fontName.family, list);
      }
      return map;
    });
  }
  return fontIndexPromise;
}

const WEIGHTS: [RegExp, number][] = [
  [/(extra|ultra)black/, 950],
  [/black|heavy/, 900],
  [/(extra|ultra)bold/, 800],
  [/(semi|demi)bold|demi/, 600],
  [/bold/, 700],
  [/medium/, 500],
  [/(extra|ultra)light/, 200],
  [/light/, 300],
  [/thin|hairline/, 100],
  [/regular|normal|book|roman/, 400],
];

interface ParsedStyle { weight?: number; italic: boolean; extra: string }

function parseStyle(style: string): ParsedStyle {
  let s = style.toLowerCase().replace(/[\s_-]/g, "");
  let weight: number | undefined;
  for (const [re, w] of WEIGHTS) {
    if (re.test(s)) {
      weight = w;
      s = s.replace(re, "");
      break;
    }
  }
  const italic = /italic|oblique/.test(s);
  s = s.replace(/italic|oblique/, "");
  return { weight, italic, extra: s };
}

/**
 * Pick the closest available style of `family` for `wanted`, inheriting whatever
 * `wanted` doesn't say from `context` (e.g. "Bold" inside italic text stays italic).
 */
async function resolveFont(family: string, wanted: string, context?: string): Promise<{ font: FontName; exact: boolean }> {
  const index = await fontIndex();
  const styles = index.get(family);
  if (!styles || styles.length === 0) return { font: { family, style: wanted }, exact: false };
  const exactName = styles.find((s) => s.toLowerCase() === wanted.toLowerCase());

  const w = parseStyle(wanted);
  const c = context ? parseStyle(context) : { weight: 400, italic: false, extra: "" };
  const mentionsItalic = /italic|oblique/i.test(wanted);
  const mentionsWeight = w.weight !== undefined;
  const target = {
    weight: w.weight !== undefined ? w.weight : (c.weight !== undefined ? c.weight : 400),
    italic: mentionsItalic ? true : (mentionsWeight && !c.italic ? false : c.italic || w.italic),
    extra: w.extra || c.extra,
  };

  if (exactName && (!context || (mentionsWeight && (mentionsItalic || !c.italic)))) {
    return { font: { family, style: exactName }, exact: true };
  }

  let best = styles[0];
  let bestScore = Infinity;
  for (const s of styles) {
    const p = parseStyle(s);
    const pw = p.weight !== undefined ? p.weight : 400;
    let score = Math.abs(pw - target.weight);
    if (p.italic !== target.italic) score += 1000;
    if (p.extra !== target.extra) score += 50;
    if (s === exactName) score -= 1;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const p = parseStyle(best);
  const exact = (p.weight !== undefined ? p.weight : 400) === target.weight && p.italic === target.italic;
  return { font: { family, style: best }, exact };
}

const loadedFonts = new Map<string, Promise<boolean>>();
function loadFont(font: FontName): Promise<boolean> {
  const key = font.family + "::" + font.style;
  let p = loadedFonts.get(key);
  if (!p) {
    p = figma.loadFontAsync(font).then(() => true, () => false);
    loadedFonts.set(key, p);
  }
  return p;
}

// ============================================================================
// Markdown parser
// ============================================================================

interface Range { start: number; end: number; slot: SlotKey }
interface Link { start: number; end: number; url: string }
interface Para { start: number; end: number; list: "ORDERED" | "UNORDERED" | "NONE"; indent: number }
interface LatexBlock { latex: string; display: boolean }

/** A run of styled text that ends up in one Figma text node. */
interface TextChunk {
  text: string;
  blocks: Range[];   // one per line (heading / body / table cell ...)
  mods: Range[];     // bold, italic, code, highlight (may overlap)
  links: Link[];
  paras: Para[];
}

interface TableBlock {
  align: ("MIN" | "CENTER" | "MAX")[];
  rows: TextChunk[][]; // rows[0] is the header
}

type OutputBlock = { kind: "text"; chunk: TextChunk } | { kind: "table"; table: TableBlock };

interface ParseResult {
  blocks: OutputBlock[];
  latex: LatexBlock[];
}

interface Inline { text: string; mods: Range[]; links: Link[] }

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Find the closing delimiter, skipping escapes and code spans. */
function findClosing(src: string, from: number, delim: string): number {
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "`" && delim !== "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1) { i = close; continue; }
    }
    if (src.startsWith(delim, i)) {
      if (delim === "*" || delim === "_") {
        // A single * must not be part of ** / ***
        let run = 0;
        while (src[i + run] === delim) run++;
        if (run !== 1) {
          if (run === 2 || run === 3) {
            // skip a nested ** ... ** pair entirely
            const inner = findClosing(src, i + run, delim.repeat(run));
            if (inner !== -1) { i = inner + run - 1; continue; }
          }
          i += run - 1;
          continue;
        }
      }
      if (isSpace(src[i - 1])) continue; // closing delimiter can't follow whitespace
      if (delim === "_" && isWordChar(src[i + delim.length])) continue;
      return i;
    }
  }
  return -1;
}

function parseInline(src: string, latexOut: LatexBlock[]): Inline {
  let text = "";
  const mods: Range[] = [];
  const links: Link[] = [];

  const appendNested = (inner: string, slots: SlotKey[]) => {
    const sub = parseInline(inner, latexOut);
    const offset = text.length;
    text += sub.text;
    for (const m of sub.mods) mods.push({ start: m.start + offset, end: m.end + offset, slot: m.slot });
    for (const l of sub.links) links.push({ start: l.start + offset, end: l.end + offset, url: l.url });
    for (const slot of slots) mods.push({ start: offset, end: offset + sub.text.length, slot });
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Escapes: \* \$ \_ ...
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|$=~]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    // `inline code`
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1) {
        const start = text.length;
        text += src.slice(i + 1, close);
        mods.push({ start, end: text.length, slot: "code" });
        i = close + 1;
        continue;
      }
    }

    // $inline math$ (pandoc rules so "$10 and $20" stays text)
    if (ch === "$" && src[i + 1] !== "$" && !isSpace(src[i + 1])) {
      let close = -1;
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "$") {
          if (!isSpace(src[j - 1]) && !/[0-9]/.test(src[j + 1] || "")) close = j;
          break;
        }
      }
      if (close !== -1) {
        latexOut.push({ latex: src.slice(i + 1, close).trim(), display: false });
        i = close + 1;
        continue;
      }
    }

    // ![[embed]] -> removed
    if (src.startsWith("![[", i)) {
      const close = src.indexOf("]]", i + 3);
      if (close !== -1) { i = close + 2; continue; }
    }

    // [[wikilink|alias]] -> alias
    if (src.startsWith("[[", i)) {
      const close = src.indexOf("]]", i + 2);
      if (close !== -1) {
        const inner = src.slice(i + 2, close);
        const bar = inner.indexOf("|");
        let label = bar !== -1 ? inner.slice(bar + 1) : inner;
        if (bar === -1) label = label.replace(/#\^?/g, " > ").replace(/^ > /, "");
        text += label;
        i = close + 2;
        continue;
      }
    }

    // [label](url)
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        const start = text.length;
        appendNested(m[1], []);
        links.push({ start, end: text.length, url: m[2] });
        i += m[0].length;
        continue;
      }
    }

    // ==highlight==
    if (src.startsWith("==", i) && !isSpace(src[i + 2])) {
      const close = findClosing(src, i + 2, "==");
      if (close !== -1) {
        appendNested(src.slice(i + 2, close), ["highlight"]);
        i = close + 2;
        continue;
      }
    }

    // ~~strike~~ -> keep text (no slot), just drop markers
    if (src.startsWith("~~", i) && !isSpace(src[i + 2])) {
      const close = findClosing(src, i + 2, "~~");
      if (close !== -1) {
        appendNested(src.slice(i + 2, close), []);
        i = close + 2;
        continue;
      }
    }

    // *, **, *** and _, __, ___
    if (ch === "*" || ch === "_") {
      let run = 0;
      while (src[i + run] === ch && run < 3) run++;
      const canOpen = !isSpace(src[i + run]) && !(ch === "_" && isWordChar(src[i - 1]));
      let matched = false;
      if (canOpen) {
        for (let n = run; n >= 1 && !matched; n--) {
          const close = findClosing(src, i + n, ch.repeat(n));
          if (close > i + n) {
            const slots: SlotKey[] = n === 3 ? ["bold", "italic"] : n === 2 ? ["bold"] : ["italic"];
            appendNested(src.slice(i + n, close), slots);
            i = close + n;
            matched = true;
          }
        }
      }
      if (!matched) {
        text += ch.repeat(run);
        i += run;
      }
      continue;
    }

    text += ch;
    i++;
  }
  return { text, mods, links };
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function newChunk(): TextChunk {
  return { text: "", blocks: [], mods: [], links: [], paras: [] };
}

/** Append one line to a chunk with a block slot and optional list info. */
function pushLine(chunk: TextChunk, inline: Inline, slot: SlotKey, list: Para["list"], indent: number) {
  if (chunk.text.length > 0) chunk.text += "\n";
  const start = chunk.text.length;
  chunk.text += inline.text;
  const end = chunk.text.length;
  chunk.blocks.push({ start, end, slot });
  for (const m of inline.mods) chunk.mods.push({ start: m.start + start, end: m.end + start, slot: m.slot });
  for (const l of inline.links) chunk.links.push({ start: l.start + start, end: l.end + start, url: l.url });
  chunk.paras.push({ start, end, list, indent });
}

function cellChunk(src: string, slot: SlotKey, latex: LatexBlock[]): TextChunk {
  const c = newChunk();
  pushLine(c, parseInline(src, latex), slot, "NONE", 0);
  return c;
}

function parseMarkdown(input: string): ParseResult {
  const latex: LatexBlock[] = [];
  let src = input.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");

  // YAML frontmatter -> title
  let title: string | null = null;
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(src);
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm[1]);
    if (t) title = t[1].trim().replace(/^["']|["']$/g, "");
    src = src.slice(fm[0].length);
  }

  // %%obsidian comments%%
  src = src.replace(/%%[\s\S]*?%%/g, "");

  // $$display math$$ (may span lines) — rendered as SVG below the text, like before
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => {
    latex.push({ latex: body.trim(), display: true });
    return "";
  });

  const lines = src.split("\n");

  // Indent unit for nested lists: tabs = 1 level; spaces = smallest indent used
  let spaceUnit = 0;
  for (const l of lines) {
    const m = /^( +)([-*+]|\d+[.)])\s/.exec(l);
    if (m && (spaceUnit === 0 || m[1].length < spaceUnit)) spaceUnit = m[1].length;
  }
  if (spaceUnit === 0) spaceUnit = 4;

  const blocks: OutputBlock[] = [];
  let chunk = newChunk();
  let lastBlank = true;

  const flush = () => {
    // drop trailing empty lines
    while (chunk.paras.length && chunk.paras[chunk.paras.length - 1].start === chunk.paras[chunk.paras.length - 1].end) {
      const p = chunk.paras.pop() as Para;
      chunk.blocks.pop();
      chunk.text = chunk.text.slice(0, Math.max(0, p.start - 1));
    }
    if (chunk.text.length > 0) blocks.push({ kind: "text", chunk });
    chunk = newChunk();
    lastBlank = true;
  };

  if (title) {
    pushLine(chunk, parseInline(title, latex), "title", "NONE", 0);
    lastBlank = false;
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Tables
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map((c): "MIN" | "CENTER" | "MAX" => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "CENTER" : r ? "MAX" : "MIN";
      });
      const rows: TextChunk[][] = [header.map((c) => cellChunk(c, "tableHeader", latex))];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]).map((c) => cellChunk(c, "tableCell", latex)));
        i++;
      }
      i--;
      const cols = header.length;
      for (const row of rows) {
        while (row.length < cols) row.push(cellChunk("", "tableCell", latex));
        row.length = cols;
      }
      while (align.length < cols) align.push("MIN");
      flush();
      blocks.push({ kind: "table", table: { align, rows } });
      continue;
    }

    // Blockquotes / callouts: "> [!note] Title" -> bold title, "> text" -> text
    let quoteSlot: SlotKey | null = null;
    if (/^\s*>/.test(line)) {
      line = line.replace(/^\s*(>\s?)+/, "");
      const callout = /^\[!([^\]]+)\][+-]?\s*(.*)$/.exec(line);
      if (callout) {
        line = callout[2] || callout[1].charAt(0).toUpperCase() + callout[1].slice(1);
        quoteSlot = "bold";
      }
    }

    // Horizontal rule / blank
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || line.trim() === "") {
      if (!lastBlank) {
        pushLine(chunk, { text: "", mods: [], links: [] }, "body", "NONE", 0);
        lastBlank = true;
      }
      continue;
    }
    lastBlank = false;

    // Headings
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      pushLine(chunk, parseInline(h[2], latex), ("h" + level) as SlotKey, "NONE", 0);
      continue;
    }

    // Lists (incl. tasks)
    const li = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ws = li[1];
      const tabs = (ws.match(/\t/g) || []).length;
      const spaces = ws.replace(/\t/g, "").length;
      const level = tabs + Math.floor(spaces / spaceUnit);
      let content = li[3];
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(content);
      if (task) content = (task[1] === " " ? "☐ " : "☑ ") + task[2];
      const ordered = /\d/.test(li[2]);
      pushLine(chunk, parseInline(content, latex), "body", ordered ? "ORDERED" : "UNORDERED", level);
      continue;
    }

    const inline = parseInline(line.trim(), latex);
    if (quoteSlot) inline.mods.push({ start: 0, end: inline.text.length, slot: quoteSlot });
    pushLine(chunk, inline, "body", "NONE", 0);
  }
  flush();
  return { blocks, latex };
}

// ============================================================================
// Applying styles
// ============================================================================

interface Ctx {
  slots: Partial<Record<SlotKey, StyleSpec>>;
  table: TableOptions;
  baseFont: FontName;              // font of the original layer (used when Body isn't set)
  textStyles: Map<string, TextStyle | null>;
  warnings: Set<string>;
}

interface Effective {
  textStyleId?: string;
  fontName?: FontName;
  fontSize?: number;
  fills?: Paint[];
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  textDecoration?: TextDecoration;
  textCase?: TextCase;
}

async function getTextStyle(ctx: Ctx, id: string | undefined): Promise<TextStyle | null> {
  if (!id) return null;
  if (!ctx.textStyles.has(id)) {
    let style: TextStyle | null = null;
    try {
      const s = await figma.getStyleByIdAsync(id);
      style = s && s.type === "TEXT" ? (s as TextStyle) : null;
    } catch (_e) {
      style = null;
    }
    ctx.textStyles.set(id, style);
  }
  return ctx.textStyles.get(id) || null;
}

/** Resolve the font a spec asks for, relative to the current font. */
async function specFont(spec: StyleSpec, current: FontName, ctx: Ctx, label: string): Promise<FontName> {
  let font: FontName = current;
  let exact = true;
  if (spec.fontName) {
    const r = await resolveFont(spec.fontName.family, spec.fontName.style);
    font = r.font;
    exact = r.exact;
  } else if (spec.fontStyle) {
    const r = await resolveFont(current.family, spec.fontStyle, current.style);
    font = r.font;
    exact = r.exact;
  }
  if (!exact) ctx.warnings.add(`${label}: used "${font.family} ${font.style}"`);
  return font;
}

function copyProps(target: Effective, spec: StyleSpec) {
  if (spec.fontSize !== undefined) target.fontSize = spec.fontSize;
  if (spec.fills !== undefined) target.fills = spec.fills;
  if (spec.lineHeight !== undefined) target.lineHeight = spec.lineHeight;
  if (spec.letterSpacing !== undefined) target.letterSpacing = spec.letterSpacing;
  if (spec.textDecoration !== undefined) target.textDecoration = spec.textDecoration;
  if (spec.textCase !== undefined) target.textCase = spec.textCase;
}

const SLOT_LABEL: Record<SlotKey, string> = {
  title: "Title", h1: "H1", h2: "H2", h3: "H3", h4: "H4", body: "Body",
  bold: "Bold", italic: "Italic", boldItalic: "Bold italic", code: "Code",
  highlight: "Highlight", tableHeader: "Table header", tableCell: "Table cell",
};

/**
 * Compute what one run of text should look like.
 * Order: body -> block slot -> code -> highlight -> bold/italic.
 * If the block (or body) uses a Figma text style, only things that differ
 * from it are set afterwards, so the layer stays linked to the style.
 */
async function computeEffective(block: SlotKey, mods: Set<SlotKey>, ctx: Ctx): Promise<Effective> {
  const body = ctx.slots.body || {};
  const blockSpec = block === "body" ? {} : ctx.slots[block] || {};
  const eff: Effective = {};

  // Base layer: block's text style, else body's text style, else explicit props.
  const styleSource = blockSpec.textStyleId ? blockSpec : (!hasAnyFontProp(blockSpec) && body.textStyleId ? body : null);
  const linkedStyle = styleSource ? await getTextStyle(ctx, styleSource.textStyleId) : null;

  let font: FontName;
  if (linkedStyle) {
    eff.textStyleId = linkedStyle.id;
    font = linkedStyle.fontName;
    if (styleSource && styleSource.fills) eff.fills = styleSource.fills;
    if (styleSource !== body && body.fills && !blockSpec.fills) eff.fills = body.fills;
  } else {
    font = await specFont(body, ctx.baseFont, ctx, "Body");
    if (body.fontName || body.fontStyle) eff.fontName = font;
    copyProps(eff, body);
    if (block !== "body") {
      const f = await specFont(blockSpec, font, ctx, SLOT_LABEL[block]);
      if (blockSpec.fontName || blockSpec.fontStyle) { font = f; eff.fontName = f; }
      copyProps(eff, blockSpec);
    }
  }

  const order: SlotKey[] = ["code", "highlight"];
  if (mods.has("bold") && mods.has("italic")) order.push("boldItalic");
  else if (mods.has("bold")) order.push("bold");
  else if (mods.has("italic")) order.push("italic");
  const active = (s: SlotKey) => s === "boldItalic" ? true : mods.has(s);

  for (const slot of order) {
    if (!active(slot)) continue;
    const spec = ctx.slots[slot];
    if (!spec) continue;
    if (spec.fontName || spec.fontStyle) {
      font = await specFont(spec, font, ctx, SLOT_LABEL[slot]);
      eff.fontName = font;
    }
    copyProps(eff, spec);
  }
  return eff;
}

function hasAnyFontProp(s: StyleSpec): boolean {
  return !!(s.fontName || s.fontStyle || s.fontSize || s.textStyleId);
}

/** Split [0, len) into runs where block + modifiers are constant. */
function runs(chunk: TextChunk): { start: number; end: number; block: SlotKey; mods: Set<SlotKey>; url?: string }[] {
  const len = chunk.text.length;
  const cuts = new Set<number>([0, len]);
  for (const r of chunk.blocks) { cuts.add(r.start); cuts.add(r.end); }
  for (const r of chunk.mods) { cuts.add(r.start); cuts.add(r.end); }
  for (const l of chunk.links) { cuts.add(l.start); cuts.add(l.end); }
  const points = [...cuts].filter((p) => p >= 0 && p <= len).sort((a, b) => a - b);
  const out: { start: number; end: number; block: SlotKey; mods: Set<SlotKey>; url?: string }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    if (end <= start) continue;
    const b = chunk.blocks.find((r) => r.start <= start && end <= r.end);
    const mods = new Set<SlotKey>();
    for (const m of chunk.mods) if (m.start <= start && end <= m.end) mods.add(m.slot);
    const link = chunk.links.find((l) => l.start <= start && end <= l.end);
    out.push({ start, end, block: b ? b.slot : "body", mods, url: link ? link.url : undefined });
  }
  return out;
}

async function applyEffective(node: TextNode, start: number, end: number, eff: Effective, ctx: Ctx) {
  if (eff.textStyleId) {
    const style = ctx.textStyles.get(eff.textStyleId);
    if (style && (await loadFont(style.fontName))) {
      try {
        await node.setRangeTextStyleIdAsync(start, end, eff.textStyleId);
      } catch (e) {
        console.warn("Could not apply text style", e);
      }
    }
  }
  if (eff.fontName) {
    if (await loadFont(eff.fontName)) {
      node.setRangeFontName(start, end, eff.fontName);
    } else {
      ctx.warnings.add(`Font not available: ${eff.fontName.family} ${eff.fontName.style}`);
    }
  }
  try {
    if (eff.fontSize !== undefined) node.setRangeFontSize(start, end, eff.fontSize);
    if (eff.fills !== undefined) node.setRangeFills(start, end, eff.fills);
    if (eff.lineHeight !== undefined) node.setRangeLineHeight(start, end, eff.lineHeight);
    if (eff.letterSpacing !== undefined) node.setRangeLetterSpacing(start, end, eff.letterSpacing);
    if (eff.textDecoration !== undefined) node.setRangeTextDecoration(start, end, eff.textDecoration);
    if (eff.textCase !== undefined) node.setRangeTextCase(start, end, eff.textCase);
  } catch (e) {
    console.warn("Could not apply some text properties", e);
  }
}

async function loadAllFontsOf(node: TextNode) {
  const len = node.characters.length;
  const fonts = len > 0 ? node.getRangeAllFontNames(0, len) : (node.fontName !== figma.mixed ? [node.fontName as FontName] : []);
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

/** Put a chunk's text into `node` and style it. */
async function writeChunk(node: TextNode, chunk: TextChunk, ctx: Ctx) {
  await loadAllFontsOf(node);
  node.characters = chunk.text;
  const len = chunk.text.length;
  if (len === 0) return;

  // Pre-fetch any linked text styles
  for (const key of ALL_SLOTS) {
    const s = ctx.slots[key];
    if (s && s.textStyleId) await getTextStyle(ctx, s.textStyleId);
  }

  // Reset decoration/lists so re-running on formatted text behaves
  try {
    node.setRangeTextDecoration(0, len, "NONE");
    node.setRangeHyperlink(0, len, null);
  } catch (_e) { /* ignore */ }

  const cache = new Map<string, Effective>();
  for (const r of runs(chunk)) {
    const key = r.block + "|" + [...r.mods].sort().join(",");
    let eff = cache.get(key);
    if (!eff) {
      eff = await computeEffective(r.block, r.mods, ctx);
      cache.set(key, eff);
    }
    await applyEffective(node, r.start, r.end, eff, ctx);
    if (r.url) {
      try { node.setRangeHyperlink(r.start, r.end, { type: "URL", value: r.url }); } catch (_e) { /* ignore */ }
    }
  }

  // Lists (Figma: indentation 1 = first list level)
  try {
    node.setRangeListOptions(0, len, { type: "NONE" });
    node.setRangeIndentation(0, len, 0);
  } catch (_e) { /* ignore */ }
  for (const p of chunk.paras) {
    if (p.list === "NONE" || p.end <= p.start) continue;
    try {
      node.setRangeListOptions(p.start, p.end, { type: p.list });
      node.setRangeIndentation(p.start, p.end, p.indent + 1);
    } catch (e) {
      console.warn("Could not apply list formatting", e);
    }
  }
}

// ============================================================================
// Tables
// ============================================================================

async function buildTable(table: TableBlock, template: TextNode, ctx: Ctx): Promise<FrameNode> {
  const divider: SolidPaint = { type: "SOLID", color: hex(ctx.table.dividerColor || DEFAULT_TABLE.dividerColor) };
  const padX = ctx.table.cellPaddingX, padY = ctx.table.cellPaddingY;
  const cols = table.align.length;

  // 1. Create all text nodes and measure column widths
  const texts: TextNode[][] = [];
  const widths: number[] = new Array(cols).fill(0);
  for (const row of table.rows) {
    const rowTexts: TextNode[] = [];
    for (let c = 0; c < cols; c++) {
      const t = template.clone();
      t.textAutoResize = "WIDTH_AND_HEIGHT";
      await writeChunk(t, row[c], ctx);
      t.textAlignHorizontal = table.align[c] === "MIN" ? "LEFT" : table.align[c] === "MAX" ? "RIGHT" : "CENTER";
      widths[c] = Math.max(widths[c], t.width);
      rowTexts.push(t);
    }
    texts.push(rowTexts);
  }

  // 2. Lay out: table (vertical) > rows (horizontal) > cells (fixed width)
  const frame = figma.createFrame();
  frame.name = "Table";
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  frame.itemSpacing = 0;
  frame.fills = [];
  frame.clipsContent = false;

  texts.forEach((rowTexts, r) => {
    const row = figma.createFrame();
    row.name = r === 0 ? "Header" : "Row " + r;
    row.layoutMode = "HORIZONTAL";
    row.primaryAxisSizingMode = "AUTO";
    row.counterAxisSizingMode = "AUTO";
    row.itemSpacing = 0;
    row.fills = [];
    row.clipsContent = false;
    if (r === 0) {
      row.strokes = [divider];
      row.strokeAlign = "INSIDE";
      row.strokeTopWeight = 0;
      row.strokeLeftWeight = 0;
      row.strokeRightWeight = 0;
      row.strokeBottomWeight = 1;
    }
    frame.appendChild(row);

    // Header gets extra breathing room; body rows get extra space at the top/bottom of the table
    const padTop = r === 0 ? padY * 2 : r === 1 ? padY * 2 : padY;
    const padBottom = r === 0 ? padY * 2 : r === texts.length - 1 ? padY * 2 : padY;
    const rowHeight = Math.max(...rowTexts.map((t) => t.height)) + padTop + padBottom;

    rowTexts.forEach((t, c) => {
      const cell = figma.createFrame();
      cell.name = "Cell";
      cell.layoutMode = "VERTICAL";
      cell.fills = [];
      cell.clipsContent = false;
      cell.paddingLeft = padX;
      cell.paddingRight = padX;
      cell.paddingTop = padTop;
      cell.paddingBottom = padBottom;
      cell.counterAxisAlignItems = table.align[c];
      cell.primaryAxisAlignItems = "CENTER";
      if (c > 0) {
        cell.strokes = [divider];
        cell.strokeAlign = "INSIDE";
        cell.strokeTopWeight = 0;
        cell.strokeRightWeight = 0;
        cell.strokeBottomWeight = 0;
        cell.strokeLeftWeight = 1;
      }
      row.appendChild(cell);
      cell.appendChild(t);
      cell.primaryAxisSizingMode = "FIXED";
      cell.counterAxisSizingMode = "FIXED";
      cell.resize(widths[c] + padX * 2, rowHeight);
    });
  });
  return frame;
}

// ============================================================================
// Formatting a selection
// ============================================================================

let pendingLatex = 0;
let closeWhenDone = false;

function maybeClose() {
  if (closeWhenDone && pendingLatex <= 0) figma.closePlugin();
}

function firstSegmentFont(node: TextNode): FontName {
  if (node.fontName !== figma.mixed) return node.fontName as FontName;
  const segs = node.getStyledTextSegments(["fontName"]);
  return segs.length ? segs[0].fontName : { family: "Inter", style: "Regular" };
}

async function formatNode(node: TextNode, settings: Settings): Promise<{ latex: number; warnings: Set<string> }> {
  const parsed = parseMarkdown(node.characters);
  const ctx: Ctx = {
    slots: effectiveSlots(settings),
    table: settings.table,
    baseFont: firstSegmentFont(node),
    textStyles: new Map(),
    warnings: new Set(),
  };

  // Load the current fonts and collapse the node to its first-character style,
  // so it can be used as the template for chunks/cells.
  await loadAllFontsOf(node);

  const hasTable = parsed.blocks.some((b) => b.kind === "table");
  let result: SceneNode = node;

  if (!hasTable) {
    const first = parsed.blocks[0];
    await writeChunk(node, first && first.kind === "text" ? first.chunk : newChunk(), ctx);
  } else {
    const parent: BaseNode & ChildrenMixin = node.parent || figma.currentPage;
    const index = parent.children.indexOf(node);
    const wrapper = figma.createFrame();
    wrapper.name = "Markdown";
    wrapper.layoutMode = "VERTICAL";
    wrapper.primaryAxisSizingMode = "AUTO";
    wrapper.counterAxisSizingMode = "AUTO";
    wrapper.itemSpacing = 20;
    wrapper.fills = [];
    wrapper.clipsContent = false;
    if (index >= 0) parent.insertChild(index, wrapper);
    else parent.appendChild(wrapper);
    wrapper.x = node.x;
    wrapper.y = node.y;

    // A tiny copy of the layer (first character's style) to clone text nodes from
    const template = node.clone();
    template.characters = node.characters.slice(0, 1) || " ";

    const fixedWidth = node.textAutoResize !== "WIDTH_AND_HEIGHT";
    for (const block of parsed.blocks) {
      if (block.kind === "text") {
        const t = template.clone();
        wrapper.appendChild(t);
        if (fixedWidth) {
          t.resize(node.width, t.height);
          t.textAutoResize = "HEIGHT";
        }
        await writeChunk(t, block.chunk, ctx);
      } else {
        wrapper.appendChild(await buildTable(block.table, template, ctx));
      }
    }
    template.remove();
    node.remove();
    result = wrapper;
  }

  // LaTeX: render via the UI (MathJax), placed below the result
  let offsetY = result.y + result.height + 16;
  const parentId = result.parent ? result.parent.id : null;
  for (const block of parsed.latex) {
    if (!block.latex) continue;
    pendingLatex++;
    figma.ui.postMessage({
      type: "render-latex",
      latex: block.latex,
      x: result.x,
      y: offsetY,
      display: block.display,
      parentId,
    });
    offsetY += block.display ? 80 : 40;
  }
  return { latex: parsed.latex.length, warnings: ctx.warnings };
}

async function formatSelection() {
  const textNodes = figma.currentPage.selection.filter((n): n is TextNode => n.type === "TEXT");
  if (textNodes.length === 0) {
    figma.notify("⚠️ Select at least one text layer");
    maybeClose();
    return;
  }
  const settings = loadSaved();
  const warnings = new Set<string>();
  let latex = 0;
  for (const node of textNodes) {
    try {
      const r = await formatNode(node, settings);
      latex += r.latex;
      r.warnings.forEach((w) => warnings.add(w));
    } catch (e) {
      console.error(e);
      figma.notify("❌ Error formatting: " + (e instanceof Error ? e.message : String(e)), { error: true });
    }
  }
  if (warnings.size) figma.notify("⚠️ " + [...warnings].slice(0, 3).join(" · "), { timeout: 6000 });
  if (latex === 0) figma.notify("✅ Markdown formatting applied");
  else figma.notify(`⏳ Rendering ${latex} LaTeX block${latex > 1 ? "s" : ""}…`);
  maybeClose();
}

// ============================================================================
// Capturing and applying styles from the canvas
// ============================================================================

interface Target { node: TextNode; start: number; end: number }

function selectionTarget(): Target | null {
  const range = figma.currentPage.selectedTextRange;
  if (range && range.node.characters.length > 0) {
    // Highlighted text -> that range; just a cursor -> the whole layer
    if (range.end > range.start) return { node: range.node, start: range.start, end: range.end };
    return { node: range.node, start: 0, end: range.node.characters.length };
  }
  for (const n of figma.currentPage.selection) {
    const t = n.type === "TEXT" ? n : ("findOne" in n ? (n as ChildrenMixin).findOne((c) => c.type === "TEXT") as TextNode | null : null);
    if (t && t.characters.length > 0) return { node: t, start: 0, end: t.characters.length };
  }
  return null;
}

function stripPaints(paints: readonly Paint[]): Paint[] {
  return paints.map((p) => {
    const copy = JSON.parse(JSON.stringify(p));
    delete copy.boundVariables;
    return copy as Paint;
  });
}

async function captureSpec(): Promise<StyleSpec | null> {
  const target = selectionTarget();
  if (!target) return null;
  const segs = target.node.getStyledTextSegments(
    ["fontName", "fontSize", "fills", "lineHeight", "letterSpacing", "textDecoration", "textCase", "textStyleId"],
    target.start,
    target.end,
  );
  const s = segs[0];
  if (!s) return null;
  const spec: StyleSpec = {
    fontName: { family: s.fontName.family, style: s.fontName.style },
    fontSize: s.fontSize,
    fills: stripPaints(s.fills),
    lineHeight: JSON.parse(JSON.stringify(s.lineHeight)),
    letterSpacing: JSON.parse(JSON.stringify(s.letterSpacing)),
    textDecoration: s.textDecoration,
    textCase: s.textCase,
  };
  if (s.textStyleId) {
    const style = await figma.getStyleByIdAsync(s.textStyleId);
    if (style) {
      spec.textStyleId = style.id;
      spec.textStyleName = style.name;
    }
  }
  return spec;
}

async function applySlotToSelection(slot: SlotKey) {
  const target = selectionTarget();
  if (!target) {
    figma.notify("⚠️ Select a text layer (or some text inside one)");
    return;
  }
  const settings = loadSaved();
  const ctx: Ctx = {
    slots: effectiveSlots(settings),
    table: settings.table,
    baseFont: firstSegmentFont(target.node),
    textStyles: new Map(),
    warnings: new Set(),
  };
  await loadAllFontsOf(target.node);
  const isModifier = MODIFIER_SLOTS.includes(slot);
  const block: SlotKey = isModifier ? "body" : slot;
  const mods = new Set<SlotKey>(isModifier ? (slot === "boldItalic" ? ["bold", "italic"] as SlotKey[] : [slot]) : []);
  if (isModifier) {
    // Modifiers apply relative to the existing text, so start from the text's own font
    ctx.slots = Object.assign({}, ctx.slots, { body: { fontName: firstSegmentFontAt(target) } });
  }
  const s = ctx.slots[block];
  if (s && s.textStyleId) await getTextStyle(ctx, s.textStyleId);
  const eff = await computeEffective(block, mods, ctx);
  await applyEffective(target.node, target.start, target.end, eff, ctx);
  if (ctx.warnings.size) figma.notify("⚠️ " + [...ctx.warnings].join(" · "));
  else figma.notify(`✅ Applied ${SLOT_LABEL[slot]}`);
}

function firstSegmentFontAt(t: Target): FontName {
  const segs = t.node.getStyledTextSegments(["fontName"], t.start, t.end);
  return segs.length ? segs[0].fontName : firstSegmentFont(t.node);
}

async function sendSelection() {
  const target = selectionTarget();
  if (!target) {
    figma.ui.postMessage({ type: "selection", spec: null });
    return;
  }
  const spec = await captureSpec();
  figma.ui.postMessage({
    type: "selection",
    spec,
    partial: target.start > 0 || target.end < target.node.characters.length,
    sample: target.node.characters.slice(target.start, Math.min(target.end, target.start + 30)),
  });
}

function sendState() {
  const settings = loadSaved();
  figma.ui.postMessage({
    type: "state",
    saved: settings.slots,
    defaults: DEFAULT_SLOTS,
    table: settings.table,
  });
}

// ============================================================================
// Messages from the UI
// ============================================================================

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "latex-svg": {
      try {
        const node = figma.createNodeFromSvg(msg.svg);
        let svgNode: SceneNode = node;
        if (node.type === "FRAME" && node.children.length === 1) {
          svgNode = node.children[0];
        }
        const parentNode = msg.parentId ? await figma.getNodeByIdAsync(msg.parentId) : null;
        const parent = parentNode && "appendChild" in parentNode ? (parentNode as BaseNode & ChildrenMixin) : figma.currentPage;
        parent.appendChild(svgNode);
        svgNode.x = msg.x;
        svgNode.y = msg.y;
        if (svgNode !== node) node.remove();
        svgNode.name = "LaTeX: " + String(msg.latex).substring(0, 40);
      } catch (error) {
        console.error("Error creating SVG node:", error);
        figma.notify("❌ Error creating SVG for: " + String(msg.latex).substring(0, 20));
      }
      pendingLatex--;
      if (pendingLatex <= 0) figma.notify("✅ Markdown + LaTeX formatting complete!");
      maybeClose();
      break;
    }
    case "error": {
      console.error("LaTeX rendering error:", msg.error, msg.latex);
      figma.notify("❌ LaTeX error: " + String(msg.latex).substring(0, 20));
      pendingLatex--;
      maybeClose();
      break;
    }
    case "format":
      await formatSelection();
      break;
    case "capture": {
      const spec = await captureSpec();
      if (!spec) {
        figma.notify("⚠️ Select a text layer to capture its style");
        return;
      }
      const slot = msg.slot as SlotKey;
      const settings = loadSaved();
      if (MODIFIER_SLOTS.includes(slot) && msg.weightOnly) {
        // e.g. Bold: keep the surrounding family, just take the weight
        settings.slots[slot] = { fontStyle: spec.fontName ? spec.fontName.style : undefined };
      } else {
        settings.slots[slot] = spec;
      }
      save(settings);
      sendState();
      figma.notify(`✅ Captured ${SLOT_LABEL[slot]}`);
      break;
    }
    case "set-slot": {
      const settings = loadSaved();
      const slot = msg.slot as SlotKey;
      if (msg.spec) settings.slots[slot] = msg.spec;
      else delete settings.slots[slot];
      save(settings);
      sendState();
      break;
    }
    case "set-table": {
      const settings = loadSaved();
      settings.table = Object.assign({}, DEFAULT_TABLE, msg.table);
      save(settings);
      sendState();
      break;
    }
    case "apply-slot":
      await applySlotToSelection(msg.slot as SlotKey);
      break;
    case "import": {
      try {
        const settings = sanitizeImported(JSON.parse(msg.json));
        save(settings);
        sendState();
        figma.notify("✅ Styles imported");
      } catch (e) {
        figma.notify("❌ Invalid JSON: " + (e instanceof Error ? e.message : String(e)), { error: true });
      }
      break;
    }
    case "reset-all":
      save({ version: 1, slots: {}, table: Object.assign({}, DEFAULT_TABLE) });
      sendState();
      break;
    case "get-font-styles": {
      const index = await fontIndex();
      figma.ui.postMessage({ type: "font-styles", family: msg.family, styles: index.get(msg.family) || [] });
      break;
    }
    case "get-families": {
      const index = await fontIndex();
      figma.ui.postMessage({ type: "families", families: [...index.keys()].sort() });
      break;
    }
  }
};

// ============================================================================
// Entry point
// ============================================================================

if (figma.command === "format") {
  // Fast path: format with saved styles; UI stays hidden (only needed for MathJax)
  figma.showUI(__html__, { visible: false });
  closeWhenDone = true;
  formatSelection();
} else {
  figma.showUI(__html__, { width: 360, height: 640, themeColors: true, title: "Markdown + LaTeX — Styles" });
  figma.ui.postMessage({ type: "init", mode: "settings" });
  sendState();
  sendSelection();
  figma.on("selectionchange", () => { sendSelection(); });
}
