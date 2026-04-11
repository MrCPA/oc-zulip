import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCurrentMessageText, renderHistoryContext } from '../dist/src/history.js';

function msg(id, sender, content, timestamp = 1_700_000_000 + id) {
  return {
    id,
    type: 'direct',
    sender_email: sender,
    sender_full_name: sender === 'bot@example.com' ? 'Zulip Bot' : 'User',
    content,
    timestamp,
  };
}

const baseConfig = {
  botEmail: 'bot@example.com',
  botName: 'Zulip Bot',
  mode: 'dm',
  includeTimestamps: false,
  maxMessageChars: 80,
  maxTotalChars: 1500,
  recentExactCount: 3,
  recentExactMaxChars: 400,
};

test('keeps recent DM turns exact enough for literal repeat tasks while compacting older history', () => {
  const messages = [
    msg(1, 'user@example.com', '<p>Older context one.</p>'),
    msg(2, 'bot@example.com', '<p>Older context two.</p>'),
    msg(3, 'user@example.com', '<p>The original issue was: <strong>billing export drops lines after row 512</strong>.</p>'),
    msg(4, 'bot@example.com', '<p>I am checking that exact wording.</p>'),
    msg(5, 'user@example.com', '<p>Can you literally repeat the original issue?</p>'),
  ];

  const rendered = renderHistoryContext(messages, baseConfig);
  assert.match(rendered.recentExactBlock, /billing export drops lines after row 512/);
  assert.match(rendered.recentExactBlock, /Can you literally repeat the original issue\?/);
  assert.match(rendered.olderSummaryBlock, /Older context one\./);
});

test('preserves multiline, list, quote, and code structure in recent exact context and current message', () => {
  const structuredHtml = `
    <p>Need this preserved:</p>
    <blockquote>quoted line</blockquote>
    <ul><li>first item</li><li>second item</li></ul>
    <pre><code>const x = 1;\nconsole.log(x);</code></pre>
  `;

  const rendered = renderHistoryContext([msg(1, 'user@example.com', structuredHtml)], {
    ...baseConfig,
    recentExactCount: 1,
  });
  assert.match(rendered.recentExactBlock, /Need this preserved:/);
  assert.match(rendered.recentExactBlock, /quoted line/);
  assert.match(rendered.recentExactBlock, /- first item/);
  assert.match(rendered.recentExactBlock, /```[\s\S]*const x = 1;/);

  const current = renderCurrentMessageText(structuredHtml);
  assert.match(current, /- second item/);
  assert.match(current, /console\.log\(x\);/);
});

test('trims exact block to hard total budget when needed', () => {
  const longBody = '<p>' + 'A'.repeat(500) + '</p>';
  const rendered = renderHistoryContext([msg(1, 'user@example.com', longBody)], {
    ...baseConfig,
    maxTotalChars: 120,
    recentExactCount: 1,
    recentExactMaxChars: 500,
  });

  assert.equal(rendered.olderSummaryBlock, '');
  assert.ok(rendered.recentExactBlock.length <= 120);
  assert.match(rendered.recentExactBlock, /…$/);
});
