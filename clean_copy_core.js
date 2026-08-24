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
  { pattern: /\u00A0/g, replacement: ' ' },
  // Collapse runs of spaces but never touch whitespace at line starts,
  // so Markdown list indentation survives.
  { pattern: /([^\n \t])[ \t]{2,}/g, replacement: '$1 ' },
  { pattern: /\n{3,}/g, replacement: '\n\n' },
];

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

  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  md = md.replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, '**$1**');
  md = md.replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, '*$1*');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');

  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, (_, code) => {
    code = code.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '');
    code = code.replace(/<br\s*\/?>/gi, '\n');
    code = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/>/g, '>');
    return '```\n' + code.trim() + '\n```\n\n';
  });

  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Tables: convert before <p>/<br> rules mangle cell structure.
  // Handles optional caption, thead/tbody and colspan by repeating the
  // header row so every body row has the right number of pipes.
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableHtml) => {
    const cellText = (cellHtml) => {
      let t = htmlToMarkdown(cellHtml);
      return t.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
    };
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trm;
    while ((trm = trRe.exec(tableHtml)) !== null) {
      const cells = [];
      const cellRe = /<(th|td)[^>]*(?:colspan\s*=\s*[\x22\x27]?(\d+)[\x22\x27]?)?[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm;
      while ((cm = cellRe.exec(trm[1])) !== null) {
        cells.push(cellText(cm[3]));
        const span = Math.max(1, parseInt(cm[2] || '1', 10) || 1);
        for (let s = 1; s < span; s++) cells.push('');
      }
      rows.push(cells);
    }
    if (rows.length === 0) return '';
    const cols = Math.max(...rows.map(r => r.length));
    rows.forEach(r => { while (r.length < cols) r.push(''); });
    const out = ['| ' + rows[0].join(' | ') + ' |',
                 '|' + Array(cols).fill(' --- ').join('|') + '|'];
    for (let i = 1; i < rows.length; i++) {
      out.push('| ' + rows[i].join(' | ') + ' |');
    }
    return '\n' + out.join('\n') + '\n\n';
  });

// Lists: convert innermost lists repeatedly until none remain,
  // so arbitrarily deep nesting produces one "- " per item.
  const convertList = (_, openTag, body) => {
    const ordered = /^<ol/i.test(openTag);
    let idx = 0;
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

  md = md.replace(/<[^>]*>/g, '');
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
   * never throws: a bad snippet yields { ok:false, error } and the rest
   * still convert. mode: 'markdown' | 'plain'. extraRules: raw rule list. */
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
        var content = mode === 'markdown' ? htmlToMarkdown(html) : cleanText(html.replace(/<[^>]*>/g, ''));
        content = applyRules(content, compiled);
        return { ok: true, content: content };
      } catch (err) {
        return { ok: false, error: err.message || 'Conversion failed' };
      }
    });
  }

  return { cleanText, htmlToMarkdown, compileRules, applyRules, batchConvert };
});
