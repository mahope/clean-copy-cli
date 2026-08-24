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
function extractReadable(html) {
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript|link|meta)\b[^>]*\/?>/gi, '');

  // Strip <head> entirely
  doc = doc.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');

  // Strip <html> and <body> wrapper tags
  doc = doc.replace(/<\/?(?:html|body)\b[^>]*>/gi, '');

  // Strip boilerplate containers
  doc = doc.replace(/<(nav|footer|header|aside|form|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Score candidate containers by text length
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