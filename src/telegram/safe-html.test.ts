import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeLink, safeText } from './safe-html';

describe('safeText', () => {
  it('escapes hostile markup', () => {
    const out = safeText('<script>alert(1)</script>');
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(!out.includes('<script>'));
  });

  it('escapes attribute-breakout payloads', () => {
    const out = safeText('"><a href=x>');
    assert.ok(!out.includes('"><a'));
    assert.ok(out.includes('&quot;&gt;&lt;a'));
  });

  it('keeps unicode and stringifies non-strings', () => {
    assert.ok(safeText('mojibake 🚀 café — тест').includes('🚀'));
    assert.equal(safeText(42), '42');
    assert.equal(safeText(true), 'true');
    assert.equal(safeText(null), '');
    assert.equal(safeText(undefined), '');
  });

  it('truncates to 200 chars after escaping', () => {
    assert.equal(safeText('a'.repeat(500)).length, 200);
    assert.equal(safeText('<'.repeat(500)).length, 200);
  });
});

describe('safeLink', () => {
  it('links the allow-listed hosts', () => {
    assert.equal(
      safeLink('https://pump.fun/coin/ABC', 'View Chart'),
      '<a href="https://pump.fun/coin/ABC">View Chart</a>',
    );
    assert.equal(
      safeLink('https://dexscreener.com/solana/XYZ', 'chart'),
      '<a href="https://dexscreener.com/solana/XYZ">chart</a>',
    );
    assert.equal(
      safeLink('https://solscan.io/token/ABC', 'scan'),
      '<a href="https://solscan.io/token/ABC">scan</a>',
    );
  });

  it('rejects userinfo, look-alikes, and non-https schemes', () => {
    assert.equal(safeLink('https://pump.fun@evil.com/x', 'c'), 'c');
    assert.equal(safeLink('https://pump.fun.evil.com/x', 'c'), 'c');
    assert.equal(safeLink('https://evilde pump.fun/x', 'c'), 'c');
    assert.equal(safeLink('javascript:alert(1)', 'c'), 'c');
    assert.equal(safeLink('data:text/html,<b>x</b>', 'c'), 'c');
    assert.equal(safeLink('http://pump.fun/coin/ABC', 'c'), 'c');
  });

  it('returns the escaped label for unparsable URLs', () => {
    assert.equal(safeLink('::::not a url::::', '<b>'), '&lt;b&gt;');
    assert.equal(safeLink('', '"><a href=x>'), '&quot;&gt;&lt;a href=x&gt;');
  });

  it('escapes both the URL and the label', () => {
    const out = safeLink('https://pump.fun/coin/<b>', '<script>"x"</script>');
    assert.ok(!out.includes('<script>'));
    assert.ok(!out.includes('<b>'));
    assert.ok(out.startsWith('<a href="https://pump.fun/coin/'));
    assert.ok(out.includes('&lt;script&gt;&quot;x&quot;&lt;/script&gt;'));
  });
});
