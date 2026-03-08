import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractReadableContent,
  parseDuckDuckGoResults,
} from '../dist/tools/web-tool.js';

test('extractReadableContent prefers article/main content and metadata', () => {
  const html = `
    <html>
      <head>
        <title>Example Title</title>
        <meta name="description" content="Short summary here." />
      </head>
      <body>
        <nav>ignore me</nav>
        <main>
          <article>
            <h1>Hello</h1>
            <p>This is the body.</p>
          </article>
        </main>
      </body>
    </html>
  `;

  const extracted = extractReadableContent(html, 'text/html; charset=utf-8');
  assert.equal(extracted.kind, 'html');
  assert.equal(extracted.title, 'Example Title');
  assert.equal(extracted.description, 'Short summary here.');
  assert.match(extracted.body, /Hello/);
  assert.match(extracted.body, /This is the body\./);
  assert.doesNotMatch(extracted.body, /ignore me/);
});

test('extractReadableContent pretty prints json', () => {
  const extracted = extractReadableContent('{"ok":true,"count":2}', 'application/json');
  assert.equal(extracted.kind, 'json');
  assert.match(extracted.body, /"ok": true/);
  assert.match(extracted.body, /"count": 2/);
});

test('parseDuckDuckGoResults extracts titles, urls, and snippets', () => {
  const html = `
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha Result</a>
      <div class="result__snippet">First snippet for alpha.</div>
    </div>
    <div class="result results_links">
      <a class="result__a" href="https://example.com/beta">Beta Result</a>
      <div class="result__snippet">Second snippet for beta.</div>
    </div>
  `;

  const results = parseDuckDuckGoResults(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Alpha Result');
  assert.equal(results[0].url, 'https://example.com/alpha');
  assert.equal(results[0].snippet, 'First snippet for alpha.');
  assert.equal(results[1].url, 'https://example.com/beta');
});
