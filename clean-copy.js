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
        opts.files.push(a);
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; clean-copy-cli)' , 'Accept': 'text/html' },
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
function extractReadable(html) {
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript|link|meta)\b[^>]*\/?>/gi, '');

  // strip obvious boilerplate containers entirely
  doc = doc.replace(/<(nav|footer|header|aside|form|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // score candidate containers by text length inside <article>, <main> or divs
  const candidates = [];
  const re = /<(article|main|div)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(doc)) !== null) candidates.push(m.index);
  let best = null, bestLen = 0;
  for (const start of candidates) {
    const openTagEnd = doc.indexOf('>', start);
    const tag = doc.slice(start + 1, openTagEnd).split(/\s/)[0];
    const closeIdx = doc.lastIndexOf(`</${tag}>`);
    if (closeIdx <= openTagEnd) continue;
    const inner = doc.slice(openTagEnd + 1, closeIdx);
    const len = inner.replace(/<[^>]*>/g, '').length;
    if (len > bestLen && len > 200) { best = inner; bestLen = len; }
  }
  if (best) doc = best;

  // relative links -> absolute against nothing sensible without base; leave as-is
  return doc;
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
  const r = core.batchConvert([String(inputHtmlOrText)], 'markdown', true)[0];
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
    input = extractReadable(await fetchUrl(opts.url));
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
