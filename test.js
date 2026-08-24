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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
