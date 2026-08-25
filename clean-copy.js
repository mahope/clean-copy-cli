#!/usr/bin/env node
/**
 * clean-copy — copy/paste text as clean Markdown or plain text.
 * Same converter core the Clean Copy browser extensions run.
 *
 * Usage:
 *   clean-copy [options] [file ...]     convert file(s), or stdin if no file
 *   clean-copy --url <url>              fetch a page and extract its main content as Markdown
 *   echo '<h1>Hi</h1>' | clean-copy
 *   pbpaste | clean-copy | pbcopy       macOS clipboard round-trip
 *
 * Options:
 *   -t, --text        output plain text instead of Markdown (strip all tags)
 *   -u, --url URL     fetch URL, extract readable content, output Markdown
 *   -o, --out FILE    write result to FILE ("-" = stdout, default)
 *   -c, --copy        also copy result to system clipboard (pbcopy/wl-copy/clip)
 *   -q, --quiet       suppress the trailing summary on stderr
 *   -V, --version     print version
 *   -h, --help        this help
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let core;
try {
  // installed via brew: core sits next to this script in libexec
  core = require(path.join(__dirname, 'clean_copy_core.js'));
} catch {
  try {
    core = require('clean-copy-core');
  } catch {
    console.error('clean-copy: cannot load converter core. Reinstall.');
    process.exit(1);
  }
}

const VERSION = require('./package.json').version;

function parseArgs(argv) {
  const opts = { mode: 'markdown', out: '-', copy: false,
                 quiet: false, url: null, files: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-t': case '--text': opts.mode = 'text'; break;
      case '-m': case '--markdown': opts.mode = 'markdown'; break;
      case '-w': case '--wikilinks': opts.mode = 'wikilinks'; break;
      case '-u': case '--url': opts.url = argv[++i]; break;
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '-c': case '--copy': opts.copy = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '-V': case '--version': console.log(VERSION); process.exit(0);
      case '-h': case '--help': opts.help = true; return opts;
      default:
        if (a.startsWith('-')) {
          console.error(`clean-copy: unknown option ${a} (try --help)`);
          process.exit(2);
        }
        // a bare http(s) URL as positional argument is accepted as --url
        if (/^https?:\/\//i.test(a)) {
          if (opts.url) {
            console.error('clean-copy: only one URL at a time');
            process.exit(2);
          }
          opts.url = a;
        } else {
          opts.files.push(a);
        }
    }
  }
  return opts;
}

function help() {
  console.log(`clean-copy ${VERSION} — copy/paste text as clean Markdown or plain text

Usage:
  clean-copy [options] [file ...]
  clean-copy --url <url>
  cat dirty.html | clean-copy > clean.md

Options:
  -t, --text       plain text output instead of Markdown
  -w, --wikilinks  Obsidian-style output: internal links become [[WikiLinks]]
  -u, --url URL    fetch a web page and extract its main content as Markdown
  -o, --out FILE   write to FILE instead of stdout
  -c, --copy       also copy the result to the system clipboard
  -q, --quiet      no summary line on stderr
  -V, --version    print version
  -h, --help       show this help`);
}

/** Fetch a URL with size + time limits, resolve with the body string. */
function fetchUrl(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`invalid URL: ${url}`)); }
    const mod = parsed.protocol === 'http:' ? http : https;
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error(`unsupported protocol: ${parsed.protocol}`));
    }
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 clean-copy-cli', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
      timeout: 15000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const loc = new URL(res.headers.location, url).href;
        return resolve(fetchUrl(loc, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) { req.destroy(); reject(new Error('page larger than 5 MB')); }
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timed out after 15s')); });
    req.on('error', reject);
  });
}

/**
 * Strip scripts/styles/nav/footer/etc., keep the biggest content block.
 * Deliberately simple and dependency-free — good enough for articles,
 * docs pages and blog posts; falls back to full-body conversion otherwise.
 */
// candidates, JSON-LD articleBody preference.
function extractReadable(html) {
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript|link|meta)\b[^>]*\/?>/gi, '');

  // Strip <head> entirely
  doc = doc.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');

  // Strip <html> and <body> wrapper tags
  doc = doc.replace(/<\/?(?:html|body)\b[^>]*>/gi, '');

  // Pair each opening tag with its MATCHING close (depth counting), not
  // lastIndexOf — lastIndexOf pairs an outer wrapper with the document's final
  // close, so wrappers always outscore the real content block.
  const matchingClose = (doc, from, tag) => {
    const token = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    token.lastIndex = from;
    let depth = 1, m;
    while ((m = token.exec(doc)) !== null) {
      if (m[1] === '/') { depth--; if (depth === 0) return m.index; }
      else if (!/\/>$/.test(m[0])) depth++;
    }
    return -1;
  };

  // Strip obvious boilerplate containers entirely
  // MediaWiki maintenance boxes and print-only cruft
  doc = doc.replace(/<table\b[^>]*\bclass=["'][^"']*(?:ambox|ombox|tmbox|cmbox|fmbox|mbox)["'][^>]*>[^<]*(?:<(?!\/\1[\s>])[^<]*)*<\/\1>/gi, '');
  // Class-based boilerplate (MediaWiki + generic sidebars). Removed via
  // depth-matched close: a tempered-dot regex cannot cross child tags of the
  // same name and would either over-eat or leave the close tag behind.
  // Token-based match: "has-sidebar" (whole article tag!) must NOT match,
  // so tokens are compared individually against an exact/pattern list.
  const BOILER_TOKEN = /^(?:noprint|noexcerpt|shortdescription|navbox|vertical-navbox|metadata|mw-editsection|mw-jump-link|sidebar)(?:[-_](?!sidebar$)[a-z0-9_-]+)?$/;
  // note: compound tokens like 'has-sidebar' do NOT match — the whole article
  // carries that class on Ghost sites and must survive.
  const UNUSED_MARKER = undefined;
  const isBoilerClass = (cls) => cls.toLowerCase().split(/[^a-z0-9_-]+/).some((t) => BOILER_TOKEN.test(t));
  const stripBoilerByClass = (d) => {
    let m;
    const re = /<(\w+)\b[^>]*\bclass=["']([^"']*)["'][^>]*>/gi;
    while ((m = re.exec(d)) !== null) {
      if (!isBoilerClass(m[2])) continue;
      const openTagEnd = d.indexOf('>', m.index);
      const closeIdx = matchingClose(d, openTagEnd + 1, m[1]);
      if (closeIdx <= openTagEnd) continue;
      return stripBoilerByClass(d.slice(0, m.index) + d.slice(closeIdx + ('</' + m[1] + '>').length));
    }
    return d;
  };
  doc = stripBoilerByClass(doc);

  // Ad containers (.ad, .ad-leaderboard, .advert — exact class tokens so
  // "admin"/"adapt" never match). Depth-matched removal like the boilerplate
  // strip above; 404media-style sites put these inside the winning container.
  const AD_TOKEN = /^(?:ad|ads|advert|adverts|advertisement|advertisements|advertorial)$/;
  const stripAdsByClass = (d) => {
    let m;
    const re = /<(div|section|aside)\b[^>]*\bclass=["']([^"']*)["'][^>]*>/gi;
    while ((m = re.exec(d)) !== null) {
      const tokens = m[2].toLowerCase().split(/[^a-z0-9_-]+/);
      if (!tokens.some((t) => AD_TOKEN.test(t))) continue;
      const openTagEnd = d.indexOf('>', m.index);
      const closeIdx = matchingClose(d, openTagEnd + 1, m[1]);
      if (closeIdx <= openTagEnd) continue;
      return stripAdsByClass(d.slice(0, m.index) + d.slice(closeIdx + ('</' + m[1] + '>').length));
    }
    return d;
  };
  doc = stripAdsByClass(doc);

  doc = doc.replace(/<(nav|footer|header|aside|form|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // ARIA/role-based boilerplate: role="navigation"|"banner"|"contentinfo"|"complementary"
  doc = doc.replace(/<(\w+)\b[^>]*\brole=["'](navigation|banner|contentinfo|complementary)["'][^>]*>[\s\S]*?<\/\1>/gi, '');

  // Microdata article body (schema.org via itemprop): Shopify storefronts and
  // many blogs mark the real prose with itemprop="articleBody" while larger
  // nav-heavy wrappers sit around it — take the marked block verbatim.
  const micro = /<(\w+)\b[^>]*\bitemprop=["']articleBody["'][^>]*>/i.exec(doc);
  if (micro) {
    const openTagEnd = doc.indexOf('>', micro.index);
    const closeIdx = matchingClose(doc, openTagEnd + 1, micro[1]);
    if (closeIdx > openTagEnd) return doc.slice(openTagEnd + 1, closeIdx);
  }

  // Prefer structured article body when present (news sites, blogs)
  const jsonld = /application\/ld\+json[\s\S]*?"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(doc);
  if (jsonld && jsonld[1].length > 200) {
    try {
      const text = JSON.parse('"' + jsonld[1] + '"');
      return '<p>' + text.replace(/\n\n+/g, '</p><p>').replace(/\n/g, ' ') + '</p>';
    } catch { /* fall through to DOM heuristic */ }
  }

  const scoreBlock = (inner, tag) => {
    const text = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    let linksLen = 0, lm;
    const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    while ((lm = linkRe.exec(inner)) !== null) {
      linksLen += lm[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length;
    }
    const density = text.length ? linksLen / text.length : 1;
    let s = text.length * (1 - density * 0.8);
    if (/^article$/i.test(tag)) s *= 1.25;
    return { score: s, textLen: text.length };
  };

  // Score every candidate container; then refine REPEATEDLY into the nested
  // best block while it keeps >=60% of its parent's score and stays
  // substantial. Big CMS wrappers (Squarespace, Wix) win on sheer size but are
  // mostly chrome around the article; each refinement step peels one layer.
  const CHROME = /(?:comment|sidebar|promo|advert|ads?[-_ ]|cookie|newsletter|signup|paywall|related|share[-_ ]?(?:bar|buttons)|social[-_ ]?(?:bar|buttons)?|footer|header[-_ ]?|hero[-_ ]?(?:image|banner)?|breadcrumb|lead[-_ ]?magnet|subscribe|byline|menu|breadcrumb)/i;

  const findBest = (html) => {
    let best = null, bestScore = 0;
    const re = /<(article|main|div|section)\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[0];
      if (/\b(hidden|display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attrs)) continue;
      if (/(class|id)=["'][^"']*["'][^>]/i.test(attrs) === false && !/^<(article|main)\b/i.test(m[0])) continue;
      if (CHROME.test((/(class|id)=["']([^"']*)["']/i.exec(attrs) || [,''])[2])) continue;
      const openTagEnd = html.indexOf('>', m.index);
      const tag = html.slice(m.index + 1, openTagEnd).split(/\s/)[0];
      if (!tag) continue;
      const closeIdx = matchingClose(html, openTagEnd + 1, tag);
      if (closeIdx <= openTagEnd) continue;
      const inner = html.slice(openTagEnd + 1, closeIdx);
      // Collapse whitespace when scoring: a skin full of tab-indented empty
      // divs must not outrank dense article text.
      const { score, textLen } = scoreBlock(inner, tag);
      if (textLen < 200) continue;
      if (score > bestScore) { best = { inner, tag, score }; bestScore = score; }
    }
    return best;
  };

  let cur = findBest(doc);
  if (!cur) return doc;
  for (let depth = 0; depth < 6; depth++) {
    const next = findBest(cur.inner);
    if (!next || next.score < cur.score * 0.6) break;
    cur = next;
  }
  return cur.inner;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function convert(inputHtmlOrText, opts) {
  if (opts.mode === 'text') {
    const stripped = String(inputHtmlOrText).replace(/<[^>]*>/g, '\n');
    return core.cleanText(stripped);
  }
  const mode = opts.mode === 'wikilinks' ? 'wikilinks' : 'markdown';
  const r = core.batchConvert([String(inputHtmlOrText)], mode, true)[0];
  if (!r.ok) throw new Error(r.error || 'conversion failed');
  return r.content.trim();
}

function clipboardCmd() {
  switch (process.platform) {
    case 'darwin': return 'pbcopy';
    case 'win32': return 'clip';
    default: return 'wl-copy'; // wayland; x11 users can pipe to xclip themselves
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }

  let input;
  if (opts.url) {
    if (!opts.quiet) console.error(`clean-copy: fetching ${opts.url}`);
    // Some platforms (e.g. Wix) intermittently serve an empty/truncated body
    // to non-browser clients. Retry before giving up — a second fetch almost
    // always returns the real page.
    let html = await fetchUrl(opts.url);
    for (let attempt = 0; attempt < 2; attempt++) {
      const extracted = extractReadable(html);
      if (extracted.trim().length > 0) break;
      if (!opts.quiet) console.error('clean-copy: empty page body, retrying…');
      html = await fetchUrl(opts.url);
    }
    input = extractReadable(html);
  } else if (opts.files.length > 0) {
    input = extractReadable(opts.files.map((f) => fs.readFileSync(f, 'utf8')).join('\n\n'));
  } else {
    input = await readStdin();
  }

  // full HTML documents get readability extraction regardless of source
  const looksLikeDoc = /<html[\s>]|<!doctype/i.test(String(input).slice(0, 512));
  if (!opts.url && opts.mode === 'markdown' && looksLikeDoc) {
    input = extractReadable(input);
  }

  const out = convert(input, opts);

  if (opts.out === '-') {
    process.stdout.write(out + '\n');
  } else {
    fs.writeFileSync(opts.out, out + '\n');
  }

  if (opts.copy) {
    const { spawnSync } = require('child_process');
    const cmd = clipboardCmd();
    const r = spawnSync(cmd, { input: out });
    if (r.error || r.status !== 0) {
      console.error(`clean-copy: could not reach clipboard (${cmd}) — output still written`);
    } else if (!opts.quiet) {
      console.error('clean-copy: copied to clipboard');
    }
  }

  if (!opts.quiet && !opts.copy) {
    const words = out.split(/\s+/).filter(Boolean).length;
    console.error(`clean-copy: ${out.length} chars, ${words} words -> ${opts.out === '-' ? 'stdout' : opts.out}`);
  }
}

main().catch((e) => {
  console.error(`clean-copy: ${e.message}`);
  process.exit(1);
});
