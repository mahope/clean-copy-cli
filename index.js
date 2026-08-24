#!/usr/bin/env node
/**
 * Clean Copy — GitHub Action v1.3.0
 *
 * Converts HTML to clean Markdown or plain text. Accepts input from a URL,
 * a local file path, or a raw HTML string.
 *
 * Inputs:
 *   url          — URL to fetch and convert (optional, one of url/file/html required)
 *   file         — local file path to read and convert (optional)
 *   html         — raw HTML string to convert (optional)
 *   mode         — "markdown" (default) or "plain"
 *   output_file  — write result to this file path (optional)
 *
 * Outputs:
 *   markdown     — the converted content
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load the shared converter core (same engine as the extension and CLI)
const core = require(path.join(__dirname, 'clean_copy_core.js'));

// ── helpers ────────────────────────────────────────────────────────

function getInput(name) {
  const env = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const val = process.env[env] || '';
  return val.trim();
}

function setOutput(name, value) {
  const delim = `ghadelimiter_${Date.now()}`;
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

function setFailed(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** Fetch a URL with size (5 MB) and time (30 s) limits. */
function fetchUrl(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error(`Invalid URL: ${url}`)); }
    const mod = parsed.protocol === 'http:' ? http : https;
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
    }
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'clean-copy-github-action/1.0 (GitHub Actions)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
      timeout: 30000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
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
        if (size > 5 * 1024 * 1024) {
          req.destroy(new Error('Page larger than 5 MB'));
        } else {
          chunks.push(c);
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out after 30 s'));
    });
    req.on('error', reject);
  });
}

/**
 * Extract readable content from a full HTML page.
 * Strips scripts, styles, nav, footer, etc. and keeps the biggest
 * content block. Falls back to full-body conversion if nothing
 * substantial is found.
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

  // Strip obvious boilerplate containers entirely
  // MediaWiki maintenance boxes and print-only cruft
  doc = doc.replace(/<table\b[^>]*\bclass=["'][^"']*(?:ambox|ombox|tmbox|cmbox|fmbox|mbox)[^"']*["'][^>]*>[\s\S]*?<\/table>/gi, '');
  doc = doc.replace(/<(\w+)\b[^>]*\bclass=["'][^"']*(?:noprint|noexcerpt|shortdescription|navbox|vertical-navbox|metadata|mw-editsection|mw-jump-link|sidebar)[^"']*["'][^>]*>(?:(?!<\/\1[\s>])[\s\S])*?<\/\1>/gi, '');

  doc = doc.replace(/<(nav|footer|header|aside|form|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // ARIA/role-based boilerplate: role="navigation"|"banner"|"contentinfo"|"complementary"
  doc = doc.replace(/<(\w+)\b[^>]*\brole=["'](navigation|banner|contentinfo|complementary)["'][^>]*>[\s\S]*?<\/\1>/gi, '');

  // Prefer structured article body when present (news sites, blogs)
  const jsonld = /application\/ld\+json[\s\S]*?"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(doc);
  if (jsonld && jsonld[1].length > 200) {
    try {
      const text = JSON.parse('"' + jsonld[1] + '"');
      return '<p>' + text.replace(/\n\n+/g, '</p><p>').replace(/\n/g, ' ') + '</p>';
    } catch { /* fall through to DOM heuristic */ }
  }

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
  const candidates = [];
  const re = /<(article|main|div|section)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(doc)) !== null) {
    const attrs = m[0];
    if (/\b(hidden|display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attrs)) continue;
    if (/(class|id)=["'][^"']*(?:comment|sidebar|promo|advert|ads?[-_ ]|cookie|newsletter|signup|paywall|related|share[-_ ]?(?:bar|buttons)|social[-_ ]?(?:bar|buttons)?|footer|header[-_ ]?)\b[^"']*["']/i.test(attrs)) continue;
    candidates.push(m.index);
  }
  let best = null, bestScore = 0;
  for (const start of candidates) {
    const openTagEnd = doc.indexOf('>', start);
    const tag = doc.slice(start + 1, openTagEnd).split(/\s/)[0];
    if (!tag) continue;
    const closeIdx = matchingClose(doc, openTagEnd + 1, tag);
    if (closeIdx <= openTagEnd) continue;
    const inner = doc.slice(openTagEnd + 1, closeIdx);
    // Collapse whitespace when scoring: a skin full of tab-indented empty divs
    // must not outrank dense article text.
    const text = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < 200) continue;
    // Link density: navigation blocks are mostly links. Penalise them so a
    // menu-heavy wrapper loses to a prose-heavy block of similar size.
    let linksLen = 0, lm;
    const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    while ((lm = linkRe.exec(inner)) !== null) {
      linksLen += lm[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length;
    }
    const density = text.length ? linksLen / text.length : 1;
    const score = text.length * (1 - density * 0.8);
    if (score > bestScore) { best = inner; bestScore = score; }
  }
  if (best) doc = best;

  return doc;
}

/** Check if a string looks like a full HTML document. */
function looksLikeHtmlDoc(input) {
  return /<html[\s>]|<!doctype/i.test(String(input).slice(0, 512));
}

function convert(html, mode) {
  if (mode === 'plain') {
    const stripped = String(html).replace(/<[^>]*>/g, '\n');
    return core.cleanText(stripped);
  }
  const r = core.batchConvert([String(html)], 'markdown', true)[0];
  if (!r.ok) throw new Error(r.error || 'Conversion failed');
  return r.content.trim();
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  const url = getInput('url');
  const filePath = getInput('file');
  const rawHtml = getInput('html');
  const mode = getInput('mode') || 'markdown';
  const outputFile = getInput('output_file');

  if (!['markdown', 'plain'].includes(mode)) {
    setFailed(`Invalid mode: "${mode}". Must be "markdown" or "plain".`);
    return;
  }

  // Determine input source (priority: url > file > html)
  let input;
  let sourceLabel;

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      setFailed(`Invalid URL: "${url}". Must start with http:// or https://`);
      return;
    }
    sourceLabel = url;
    const html = await fetchUrl(url);
    input = extractReadable(html);
  } else if (filePath) {
    sourceLabel = filePath;
    try {
      input = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      setFailed(`Cannot read file "${filePath}": ${err.message}`);
      return;
    }
    // For full HTML documents, extract readable content
    if (looksLikeHtmlDoc(input) && mode === 'markdown') {
      input = extractReadable(input);
    }
  } else if (rawHtml) {
    sourceLabel = 'raw HTML input';
    input = rawHtml;
    // For full HTML documents, extract readable content
    if (looksLikeHtmlDoc(input) && mode === 'markdown') {
      input = extractReadable(input);
    }
  } else {
    setFailed('One of "url", "file", or "html" input is required.');
    return;
  }

  try {
    const result = convert(input, mode);

    // Set the output
    setOutput('markdown', result);

    // Write to file if requested
    if (outputFile) {
      fs.writeFileSync(outputFile, result + '\n');
    }

    const words = result.split(/\s+/).filter(Boolean).length;
    console.log(`Clean Copy: converted ${sourceLabel} (${result.length} chars, ${words} words)${outputFile ? ` -> ${outputFile}` : ''}`);
  } catch (err) {
    setFailed(err.message);
  }
}

main().catch((err) => setFailed(err.message));