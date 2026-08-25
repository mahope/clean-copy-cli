/**
 * Clean Copy — shared HTML->Markdown / text-cleaning core.
 * Extracted verbatim from the extension's background.js (same code the
 * Chrome/Firefox extensions run), so web tool and extension behave identically.
 * UMD-ish: works in browser <script> and Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CleanCopyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const CLEAN_RULES = [
  { pattern: /[\u201C\u201D]/g, replacement: '"' },
  { pattern: /[\u2018\u2019]/g, replacement: "'" },
  { pattern: /\u2014/g, replacement: ' -- ' },
  { pattern: /\u2013/g, replacement: ' - ' },
  { pattern: /[\u200B\u200C\u200D\uFEFF]/g, replacement: '' },
  // U+2060 word joiner and U+2062 invisible times: Guardian articles embed
  // these mid-word; they leak into copied output as invisible garbage.
  { pattern: /[\u2060-\u2064\uFEFF]/g, replacement: '' },
  { pattern: /\u00A0/g, replacement: ' ' },
  // Collapse runs of spaces but never touch whitespace at line starts,
  // so Markdown list indentation survives.
  { pattern: /([^\n \t])[ \t]{2,}/g, replacement: '$1 ' },
  { pattern: /\n{3,}/g, replacement: '\n\n' },
];

/**
 * Strip remaining tags while tolerating ">" inside attribute values.
 * A naive /<[^>]*>/ stops at the first ">" even when it sits inside a
 * quoted attribute (Wikipedia's data-mw JSON, inline handlers), which
 * leaks raw markup/JSON into the output and eats real text after it.
 */
function stripTagsSafe(html) {
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    // Find the real end of this tag: scan forward, respecting quotes.
    let j = lt + 1, quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= n) { out += html.slice(lt); break; } // unterminated tag: keep text
    i = j + 1;
  }
  return out;
}

function cleanText(text) {
  let cleaned = text;
  for (const rule of CLEAN_RULES) {
    cleaned = cleaned.replace(rule.pattern, rule.replacement);
  }
  return cleaned.trim();
}

function htmlToMarkdown(html) {
  let md = html;

  // Strip script/style/noscript/template content BEFORE any tag rules run —
  // otherwise JS/CSS text leaks into the output as plain text.
  md = md.replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // CDATA sections: keep the raw content instead of dropping everything.
  md = md.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Strip SVG and MathML subtrees entirely — their internal markup/text
  // would otherwise leak into the output as noise. <math alt> is kept.
  md = md.replace(/<(svg|math)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (m, tag) => {
      if (tag.toLowerCase() === 'math') {
        const alt = /alt="([^"]*)"/i.exec(m);
        if (alt && alt[1]) return '\n' + alt[1].trim() + '\n';
      }
      return '';
    });

  // Form controls that render as widgets, not text: keep only meaningful
  // text, each on its own line so options don't glue together.
  md = md.replace(/<select\b[^>]*>([\s\S]*?)<\/select>/gi, (_, body) => {
    const opts = [];
    const re = /<(?:option|optgroup)\b[^>]*>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const labelM = /label="([^"]*)"/i.exec(m[0]);
      // optgroup uses its label; option uses its text content
      if (labelM) { opts.push(labelM[1].trim()); continue; }
      const rest = body.slice(re.lastIndex);
      const text = /^([^<]*)/.exec(rest)[1];
      if (text.trim()) opts.push(text.trim());
    }
    return opts.length ? '\n' + opts.join('\n') + '\n' : '';
  });
  md = md.replace(/<(input|textarea)\b[^>]*>/gi, (m, tag) => {
    if (tag.toLowerCase() === 'textarea') {
      // textarea content is its value; handled below via paired match
      return m;
    }
    const val = /value="([^"]*)"/i.exec(m);
    return val && val[1] ? '\n' + val[1] + '\n' : '';
  });

  // iframe/object fallback content is kept as a separate block — without
  // this the fallback text glues onto whatever block follows the tag.
  md = md.replace(/<(iframe|object)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, tag, body) => {
      if (tag.toLowerCase() === 'object') {
        // drop nested <param> tags, keep visible fallback text as a block
        return '\n' + body.replace(/<param\b[^>]*>/gi, '') + '\n';
      }
      return '\n' + body + '\n';
    });

  // <details>/<summary>: keep the content, summary becomes a bold line so
  // collapsible sections don't lose their heading.
  md = md.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (_, body) => {
    let out = '';
    const sum = body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    if (sum) out += '**' + htmlToMarkdown(sum[1]).trim() + '**\n\n';
    out += htmlToMarkdown(body.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, ''));
    return '\n' + out + '\n\n';
  });

  // Definition lists: <dt> becomes a bold term line, <dd> an indented line.
  md = md.replace(/<dl[^>]*>([\s\S]*?)<\/dl>/gi, (_, body) => {
    const parts = [];
    const re = /<(dt|dd)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const text = m[2].replace(/<[^>]*>/g, '').trim();
      if (!text) continue;
      parts.push(m[1].toLowerCase() === 'dt' ? '**' + text + '**' : ':   ' + text);
    }
    return parts.length ? '\n' + parts.join('\n') + '\n\n' : '';
  });

  // Figure captions: separate the caption from the image so it doesn't
  // glue onto the end of the ![](src) line.
  md = md.replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi,
    (_, cap) => '\n\n' + cap + '\n\n');

  // Blockquotes: convert innermost-first (like nested lists), prefixing every
  // line of the quoted content with "> " so Markdown quoting survives.
  let bqPrev;
  do {
    bqPrev = md;
    md = md.replace(/<blockquote[^>]*>((?:(?!<\/?blockquote)[\s\S])*)<\/blockquote>/gi,
      (_, body) => {
        const inner = htmlToMarkdown(body);
        const quoted = inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
        return '\n' + quoted + '\n';
      });
  } while (md !== bqPrev);

  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  md = md.replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, '**$1**');
  md = md.replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, '*$1*');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    // Image-card wrapper links and "View image in fullscreen" anchors add
    // noise like "[](/link)" or "[View image](#img-1)". If the link's visible
    // text is only an image (or empty), keep the content and drop the wrapper.
    // Fragment-only hrefs (#img-1) are dead in copied output — unwrap those too.
    const text = inner.replace(/<img[^>]*>/gi, '').replace(/<[^>]*>/g, '').trim();
    if (!text || /^#/.test(href)) return inner;
    return '[' + text + '](' + href + ')';
  });
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');

  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gis, (_, code) => {
    // Extract language from class on <code> or <pre>: common patterns
    // are class="language-javascript", class="lang-js", class="brush: python"
    let lang = '';
    const langMatch = /<code[^>]*class=["'][^"']*\b(?:language-|lang-|brush:\s*)([a-zA-Z0-9+#_]+)\b[^"']*["'][^>]*>/i.exec(code)
      || /<pre[^>]*class=["'][^"']*\b(?:language-|lang-)([a-zA-Z0-9+#_]+)\b[^"']*["'][^>]*>/i.exec(code);
    if (langMatch) lang = langMatch[1].toLowerCase();
    code = code.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '');
    code = code.replace(/<br\s*\/?>/gi, '\n');
    // NOTE: do NOT decode HTML entities here. Decoding &lt; to "<" before
    // stripTagsSafe() runs makes entity text look like a real unterminated
    // tag ("<b&gt;" -> strip eats everything to the next ">"), which wiped
    // out fenced-code content on real pages (MDN docs). The final decode
    // below (after stripping) handles entities correctly.
    return '```' + lang + '\n' + code.trim() + '\n```\n\n';
  });

  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Abbreviations: <abbr title="..."> becomes "Term (Title)" at the FIRST
  // occurrence in the output; later occurrences keep just the term so the
  // parenthetical isn't repeated on every use.
  const abbrSeen = new Set();
  md = md.replace(/<abbr[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/abbr>|<abbr[^>]*>([\s\S]*?)<\/abbr>/gi,
    (m, title, term1, term2) => {
      const term = (term1 || '').trim() || (term2 || '').trim();
      if (!term) return '';
      const t = (title || '').trim();
      if (t && !abbrSeen.has(term.toLowerCase() + '|' + t)) {
        abbrSeen.add(term.toLowerCase() + '|' + t);
        return term + ' (' + t + ')';
      }
      return term;
    });

  // Tables: converted innermost-FIRST (like lists/blockquotes) so tables
  // nested inside cells survive instead of being torn apart by a lazy
  // outer match that stops at the inner </table>.
  let tblPrev;
  // Column alignment: collect text-align from th/td style/align attrs per column
  // (header row wins; first non-default declaration sets it). Returns ':---',
  // '---:', ':---:' or ' --- '.
  const alignOf = (tag) => {
    const style = (tag.match(/style\s*=\s*[\x22\x27]([^\x22\x27]*)[\x22\x27]/i) || [])[1] || '';
    const attr = (tag.match(/\balign\s*=\s*[\x22\x27]([^\x22\x27]*)[\x22\x27]/i) || [])[1] || '';
    const hay = (style.replace(/;/g, ' ') + ' ' + attr).toLowerCase();
    if (/text-align\s*:\s*(center|right|left)|\b(center|right|left)\b/.test(hay)) {
      if (/\bleft\b/.test(hay)) return ':---';
      if (/\bright\b/.test(hay)) return '---:';
      if (/\bcenter\b/.test(hay)) return ':---:';
    }
    return null;
  };
  const convertTable = (_, tableHtml) => {
    const cellText = (cellHtml) => {
      let t = htmlToMarkdown(cellHtml);
      return t.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
    };
    const rows = [];
    const aligns = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trm;
    while ((trm = trRe.exec(tableHtml)) !== null) {
      const cells = [];
      const rowAligns = [];
      const cellRe = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      let cm;
      while ((cm = cellRe.exec(trm[1])) !== null) {
        cells.push(cellText(cm[3]));
        const spanMatch = /colspan\s*=\s*[\x22\x27]?(\d+)[\x22\x27]?/i.exec(cm[2]);
        const span = Math.max(1, parseInt(spanMatch ? spanMatch[1] : '1', 10) || 1);
        for (let s = 0; s < span; s++) {
          if (s === 0) rowAligns.push(alignOf(cm[2]));
          else rowAligns.push(null);
        }
      }
      rows.push(cells);
      aligns.push(rowAligns);
    }
    if (rows.length === 0) return '';
    const cols = Math.max(...rows.map(r => r.length));
    rows.forEach(r => { while (r.length < cols) r.push(''); });
    aligns.forEach(a => { while (a.length < cols) a.push(null); });
    // Header alignment wins over body rows.
    const colAlign = Array(cols).fill(null);
    for (let c = 0; c < cols; c++) {
      for (const a of aligns) { if (a[c]) { colAlign[c] = a[c]; break; } }
    }
    const sepRow = Array.from({length: cols}, (_, i) => colAlign[i] || ' --- ');
    const out = ['| ' + rows[0].join(' | ') + ' |',
                 '|' + sepRow.join('|') + '|'];
    for (let i = 1; i < rows.length; i++) {
      out.push('| ' + rows[i].join(' | ') + ' |');
    }
    return '\n' + out.join('\n') + '\n\n';
  };
  do {
    tblPrev = md;
    md = md.replace(/<table[^>]*>((?:(?!<table[\s>]|<\/table)[\s\S])*)<\/table>/gi, convertTable);
  } while (md !== tblPrev);

// Lists: convert innermost lists repeatedly until none remain,
  // so arbitrarily deep nesting produces one "- " per item.
  const convertList = (_, openTag, body) => {
    const ordered = /^<ol/i.test(openTag);
    // <ol start="3"> continues numbering from the given value.
    let idx = 0;
    const startAttr = /start\s*=\s*["']?(\d+)["']?/i.exec(openTag);
    if (ordered && startAttr) idx = Math.max(0, parseInt(startAttr[1], 10) - 1);
    const items = [];
    const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      idx += 1;
      const marker = ordered ? `${idx}. ` : '- ';
      // Re-indent sub-list lines that are already converted, then trim
      // the item's own leading/trailing whitespace. Sub-list markers get
      // two-space indentation relative to the parent item.
      const inner = m[1].replace(/^\s+/, '').replace(/\s+$/, '')
        // Sub-list lines: keep any existing indentation and add two
        // spaces per level so nesting depth survives conversion.
        .replace(/\n([ \t]*)- /g, (all, ws) => '\n  ' + ws + '- ')
        .replace(/\n([ \t]*)(\d+)\. /g, (all, ws, n) => '\n  ' + ws + n + '. ');
      items.push(marker + inner);
    }
    if (items.length === 0) {
      // Malformed markup (e.g. "<ul>" directly inside "<ul>") has no <li>
      // children. Return the body untouched so its content survives
      // instead of being silently dropped.
      return '\n' + body + '\n';
    }
    return '\n' + items.join('\n') + '\n';
  };
  let prev;
  do {
    prev = md;
    md = md.replace(/(<(?:ul|ol)[^>]*>)((?:(?!<\/?(?:ul|ol)[^>]*>)[\s\S])*)<\/(?:ul|ol)>/gi, convertList);
  } while (md !== prev);

  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '---\n\n');

  // Strip remaining tags. Tolerate ">" inside attribute values (e.g. the
  // JSON in Wikipedia's data-mw attributes): a naive <[^>]*> would stop at
  // the inner ">", leak raw markup/JSON into the output and eat real text.
  md = stripTagsSafe(md);
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7', uuml: '\u00FC', ouml: '\u00F6', auml: '\u00E4',
    aring: '\u00E5', oslash: '\u00F8', aelig: '\u00E6', ntilde: '\u00F1', iuml: 'ï', szlig: '\u00DF', euro: '\u20AC', deg: '\u00B0' };
  md = md.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (ent, body) {
    if (body[0] === '#') {
      var code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ent;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : ent;
  });
  // Last pass: don't let decoded entities re-expand (parity with the
  // extension's background.js, which has always done this).
  md = md.replace(/&amp;/g, '&');

  md = md.replace(/\n{4,}/g, '\n\n');
  // Collapse runs of spaces, but preserve indentation at line starts
  // (nested Markdown lists need it).
  md = md.replace(/([^\n \t])[ ]{2,}/g, '$1 ');

  return cleanText(md);
}

/**
 * Wikilinks mode (for Obsidian/Roam-style vaults): convert like Markdown,
 * then turn INTERNAL links into [[WikiLinks]]. External links (http/https/
 * mailto), fragment-only anchors and fenced code blocks are left untouched.
 * A link is internal when its href has no scheme ("//" counts as scheme-less
 * relative/site-rooted). Image syntax ![alt](src) is never converted.
 */
function htmlToWikilinks(html) {
  const md = htmlToMarkdown(html);
  const lines = md.split('\n');
  let inFence = false;
  const out = lines.map(function (line) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.replace(/(!?)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      function (m, bang, text, href) {
        if (bang === '!') return m;
        // external schemes stay as normal Markdown links
        if (/^(https?:|mailto:|ftp:|#)/i.test(href)) return m;
        return '[[' + text + ']]';
      });
  });
  return out.join('\n');
}

/**
 * htmlToCsv(html) — CSV table mode.
 * Converts HTML tables to comma-separated rows (RFC 4180 quoting), ready to
 * paste straight into Excel/Google Sheets or save as .csv.
 *
 * Strategy: reuse htmlToMarkdown (it already produces reliable pipe tables,
 * handles colspan padding, nested tables and inline markup), then transform
 * every pipe-table block into CSV rows. Non-table content is dropped when at
 * least one table exists (mixing prose into a spreadsheet import corrupts
 * it); with no tables at all we fall back to cleaned plain text so the user
 * always gets something useful.
 */
function htmlToCsv(html) {
  const md = htmlToMarkdown(html);
  const lines = md.split('\n');
  const isRow = function (l) { return /^\s*\|.*\|\s*$/.test(l); };
  const isSep = function (l) { return /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l); };
  const parseRow = function (l) {
    var t = l.trim();
    t = t.replace(/^\|/, '').replace(/\|$/, '');
    // split on unescaped pipes only
    return t.split(/(?<!\\)\|/).map(function (c) {
      return c.trim().replace(/\\\|/g, '|');
    });
  };
  var tables = [];
  var cur = [];
  for (var i = 0; i < lines.length; i++) {
    if (isRow(lines[i])) {
      if (!isSep(lines[i])) cur.push(parseRow(lines[i]));
    } else if (cur.length) {
      tables.push(cur); cur = [];
    }
  }
  if (cur.length) tables.push(cur);

  if (!tables.length) {
    // No tables: fall back to cleaned plain text (never an empty result).
    return cleanText(html.replace(/<[^>]*>/g, ' '));
  }

  var csvCell = function (s) {
    s = String(s == null ? '' : s);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  return tables.map(function (rows) {
    return rows.map(function (cells) {
      return cells.map(csvCell).join(',');
    }).join('\n');
  }).join('\n\n');
}


  /* ── Pro: custom cleanup rules ─────────────────────────────────────
   * A rule is { find, replace, regex?, caseSensitive? }.
   * Non-regex rules are literal string replacements (all occurrences).
   * Invalid regexes throw RuleError with a user-readable message. */
  function compileRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.map(function (r, i) {
      var flags = r.caseSensitive === false ? 'gi' : 'g';
      try {
        var re = r.regex ? new RegExp(r.find, flags)
          : new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        return { re: re, replace: String(r.replace == null ? '' : r.replace) };
      } catch (e) {
        var err = new Error('Rule ' + (i + 1) + ': invalid pattern "' + r.find + '"');
        err.name = 'RuleError';
        throw err;
      }
    });
  }

  /** Apply compiled rules to text. Throws RuleError on bad input rules. */
  function applyRules(text, compiled) {
    var out = text;
    for (var i = 0; i < compiled.length; i++) {
      out = out.replace(compiled[i].re, compiled[i].replace);
    }
    return cleanText(out);
  }

  /** Pro: convert an array of HTML/plain snippets in one pass (batch).
   * Returns array of { ok, content?, error? } — one entry per input,
   never throws: a bad snippet yields { ok:false, error } and the rest
   still convert. mode: 'markdown' | 'wikilinks' | 'csv' | 'plain'. extraRules: raw rule list. */
  function batchConvert(snippets, mode, extraRules) {
    var compiled = [];
    try {
      compiled = compileRules(extraRules || []);
    } catch (e) {
      // Bad global rules fail the whole batch with a clear message.
      return snippets.map(function () {
        return { ok: false, error: e.message };
      });
    }
    return (snippets || []).map(function (s) {
      try {
        var html = s && s.html != null ? s.html : String(s == null ? '' : s);
        var content = mode === 'markdown' ? htmlToMarkdown(html)
          : mode === 'wikilinks' ? htmlToWikilinks(html)
          : mode === 'csv' ? htmlToCsv(html)
          : cleanText(html.replace(/<[^>]*>/g, ''));
        content = applyRules(content, compiled);
        return { ok: true, content: content };
      } catch (err) {
        return { ok: false, error: err.message || 'Conversion failed' };
      }
    });
  }

  return { cleanText, htmlToMarkdown, htmlToWikilinks, htmlToCsv, compileRules, applyRules, batchConvert };
});
