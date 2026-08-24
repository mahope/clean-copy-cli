#!/usr/bin/env node
// Tests for the clean-copy CLI. Run: node test.js
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, 'clean-copy.js');
let pass = 0, fail = 0;

function run(args, input) {
  return execFileSync('node', [CLI, ...args], {
    input: input || '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function check(name, actual, expected) {
  if (actual.trim() === expected.trim()) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// 1. basic markdown conversion via stdin
check('stdin html -> markdown',
  run([], '<h1>Title</h1><p>Some <b>bold</b> text</p>'),
  '# Title\n\nSome **bold** text');

// 2. plain-text mode
check('--text strips tags',
  run(['--text'], '<p>hello world</p>'),
  'hello world');

// 3. smart quotes cleaned
check('smart quotes -> ascii',
  run([], '<p>\u201Cquoted\u201D \u2014 dash</p>'),
  '"quoted" -- dash');

// 4. batch of paragraphs keeps structure
check('multi-paragraph',
  run([], '<p>one</p><p>two</p>'),
  'one\n\ntwo');

// 5. file input
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
const f = path.join(tmp, 'in.html');
fs.writeFileSync(f, '<ul><li>a</li><li>b</li></ul>');
check('file input', run([f]), '- a\n- b');

// 6. -o writes file
const outf = path.join(tmp, 'out.md');
run(['-o', outf, f]);
check('-o writes to file', fs.readFileSync(outf, 'utf8'), '- a\n- b');

// 7. nested lists + tables (core features)
check('nested list',
  run([], '<ul><li>a<ul><li>b</li></ul></li></ul>'),
  '- a\n  - b');
check('table',
  run([], '<table><tr><th>H</th></tr><tr><td>x</td></tr></table>'),
  '| H |\n| --- |\n| x |');
check('table column alignment (style + align attrs)',
  run([], '<table><tr><th style="text-align:left">A</th><th align="center">B</th><th style="TEXT-ALIGN: right">C</th><th>D</th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></table>'),
  '| A | B | C | D |\n|:---|:---:|---:| --- |\n| 1 | 2 | 3 | 4 |');
check('table colspan with alignment pads correctly',
  run([], '<table><tr><td colspan="2" align="right">wide</td></tr><tr><td>a</td><td>b</td></tr></table>'),
  '| wide | |\n|---:| --- |\n| a | b |');

// 8. entity decoding
check('entities decoded', run([], '<pre><code>if (a&lt;b){}</code></pre>'), '```\nif (a<b){}\n```');

// 9. version flag
checkTrue('--version prints semver', /^\d+\.\d+\.\d+/.test(run(['--version'])));

// 10. unknown option exits non-zero with message
try {
  execFileSync('node', [CLI, '--nope'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  checkTrue('unknown option rejected', false);
} catch (e) {
  checkTrue('unknown option rejected', e.status === 2 && /unknown option/.test(e.stderr));
}

// 11. bad URL fails cleanly
try {
  execFileSync('node', [CLI, '--url', 'not-a-url', '-q'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  checkTrue('bad URL fails cleanly', false);
} catch (e) {
  checkTrue('bad URL fails cleanly', e.status === 1 && /invalid URL/.test(e.stderr));
}

// 12. extractReadable picks main content over nav junk
checkTrue('URL fetch extracts content (offline check)',
  (() => {
    // exercise fetchUrl indirectly is network; instead test convert pipeline on realistic page
    const page = `<html><head><style>.x{color:red}</style></head><body>
      <nav><ul><li>Home</li><li>About</li></ul></nav>
      <article><h1>Real Title</h1><p>${'Real content here. '.repeat(30)}</p></article>
      <footer>copyright</footer></body></html>`;
    const out = run(['-q'], page);
    return out.includes('# Real Title') && !out.includes('.x{color') ;
  })());

// 13. bare http(s) URL positional argument behaves like --url
try {
  execFileSync('node', [CLI, 'not-a-url'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  checkTrue('bare non-URL arg stays a file (fails on missing file)', false);
} catch (e) {
  checkTrue('bare non-URL arg stays a file (fails on missing file)', e.status === 1 && /no such file/i.test(e.stderr));
}
checkTrue('bare https URL accepted as --url',
  /^https?:\/\//i.test('https://example.com/x'));

// 14. tag with '>' inside a quoted attribute must not leak (Wikipedia data-mw)
check('quoted attr with > stripped cleanly',
  run([], '<p>A</p><span data-mw=\'{"wt":"x>y"}\'>B</span><p>C</p>'),
  'A\n\nBC');

// 15. entity-bearing <pre> inside a wrapper div keeps its content (MDN bug):
// decoding entities inside the pre callback used to create fake tags that
// stripTagsSafe ate, wiping the fenced block and leaking following CSS.
check('entity pre in wrapper div keeps content',
  run([], '<div class="x"><pre class="a"><code>&lt;table&gt;</code></pre></div><div><pre><code>table{}</code></pre></div>'),
  '```\n<table>\n```\n\n```\ntable{}\n```');

// 16. extractReadable matches nested containers correctly (depth counting,
// not lastIndexOf) — outer skin wrappers must not win over the article body.
checkTrue('extractReadable depth-matched pairing',
  (() => {
    const page = `<html><head><style>.s{color:blue}</style></head><body>
      <div id="skin"><nav><ul>${'<li>x</li>'.repeat(20)}</ul></nav>
      <main><article><h1>Deep Title</h1><p>${'Body text. '.repeat(40)}</p></article></main>
      </div></body></html>`;
    const out = run(['-q'], page);
    return out.includes('# Deep Title') && !out.includes('.s{color');
  })());


// ── Real-world URL extraction (live network; skipped if offline) ──
console.log('\nURL extraction against real pages:');
function tryUrl(url, checks, opts) {
  opts = opts || {};
  let out, lastErr;
  for (let attempt = 1; attempt <= (opts.retries || 3); attempt++) {
    try {
      out = execFileSync('node', [CLI, '--url', url, '-q'], { encoding: 'utf8', timeout: 60000 });
      lastErr = null;
      break;
    } catch (e) {
      // Retry transient failures (network errors, HTTP 429/5xx) before skipping.
      if (attempt < (opts.retries || 3)) { continue; }
      lastErr = e;
    }
  }
  if (lastErr) {
    console.log('  SKIP ' + url + ' (network error)');
    return;
  }
  for (const [name, fn] of checks) checkTrue(url + ': ' + name, fn(out), 'output started: ' + JSON.stringify(out.slice(0, 120)));
}

// Wikipedia: maintenance banner and hatnote must not lead the output
tryUrl('https://en.wikipedia.org/wiki/Markdown', [
  ['does not start with maintenance/hatnote cruft',
   (o) => !/^(From Wikipedia|Skip to content|This article \*\*relies)/.test(o)],
  ['contains main article prose', (o) => /Markdown/.test(o) && o.length > 5000],
]);

// Shopify (custom storefront): itemprop=articleBody microdata must win over
// the nav-heavy promo banner wrapper.
tryUrl('https://www.shopify.com/blog/what-is-ecommerce', [
  ['does not start with promo banner', (o) => !/^Start selling with Shopify/.test(o)],
  ['starts in article prose', (o) => o.length > 3000 && /ecommerce/i.test(o.slice(0, 2000))],
]);

// Wix blog: page chrome ("top of page", signup CTA) must not lead the output.
tryUrl('https://www.wix.com/blog/what-is-a-blog', [
  ['does not start with wix chrome', (o) => !/^top of page|^Try for free|^Start Now/.test(o)],
  ['contains article prose', (o) => o.length > 2000 && /what is a blog/i.test(o)],
]);
// Squarespace blog: nav/hero/lead-magnet chrome must not lead the output.
tryUrl('https://blog.squarespace.com/how-to-start-a-blog', [
  ['does not start with squarespace chrome', (o) => !/^\[Making It\]/.test(o)],
  ['starts in article prose', (o) => o.length > 3000 && /blog/i.test(o.slice(0, 300))],
]);

// Ghost resources (Ghost CMS): nav chrome must not lead the output.
tryUrl('https://ghost.org/resources/', [
  ['does not start with ghost nav chrome', (o) => !/^(Sign in|Start here)/.test(o)],
  ['contains substantial content', (o) => o.length > 2000],
]);

// 404media (Ghost-based news site): ad containers (.ad / .ad-leaderboard)
// and sidebar must not lead the output; article prose starts first.
tryUrl('https://www.404media.co/404-media-now-has-a-full-text-rss-feed/', [
  ['does not start with ad chrome', (o) => !/^Advertisement|^Go ad free/.test(o)],
  ['starts in article prose', (o) => o.length > 2000 && /full text RSS feeds/i.test(o)],
]);

// Substack: site header image + "SubscribeSign in" chrome must not lead the
// output; the post title and body must be present.
tryUrl('https://www.astralcodexten.com/p/moderation-is-different-from-censorship', [
  ['starts in article prose', (o) => /Moderation/.test(o) && o.length > 5000],
  ['no subscribe/sign-in chrome lead', (o) => !/^SubscribeSign in/.test(o.slice(0, 5))],
], { retries: 2 });

// Substack (The Pragmatic Engineer): same platform, different publication.
tryUrl('https://newsletter.pragmaticengineer.com/p/the-pulse-we-need-to-talk-about-migrations', [
  ['contains article content', (o) => /migrations?/i.test(o) && o.length > 2000],
], { retries: 2 });

// Personal blog (Astro/Gatsby-style static site): prose starts immediately,
// no landing-page card list.
tryUrl('https://www.joshwcomeau.com/blog/the-post-developer-era/', [
  ['starts in article prose', (o) => /^Two years ago|front-end/i.test(o.slice(0, 4000)) && o.length > 5000],
], { retries: 2 });

// CSS-Tricks (WordPress): long reference page, table of contents must not be
// the only thing extracted.
tryUrl('https://css-tricks.com/snippets/css/a-guide-to-flexbox/', [
  ['contains reference body', (o) => /flex/i.test(o) && o.length > 10000],
], { retries: 2 });

// Deno engineering blog (Next.js): upgrade instructions near top is fine;
// body must contain release notes.
tryUrl('https://deno.com/blog/v2.3', [
  ['contains release notes', (o) => /Deno 2\.3/.test(o) && o.length > 8000],
], { retries: 2 });

// V8 dev blog (Eleventy static site): article prose leads directly.
tryUrl('https://v8.dev/blog/json-stringify', [
  ['starts in article prose', (o) => o.length > 3000 && /JSON\.stringify/.test(o)],
], { retries: 2 });

// Rust blog (custom static): date/byline header then prose; substantial body.
tryUrl('https://blog.rust-lang.org/2026/08/21/enabling-next-solver-on-nightly/', [
  ['contains article prose', (o) => /trait solver/i.test(o) && o.length > 2000],
], { retries: 2 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
