import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOriginAllowed, parseAllowedOrigins } from './origin-guard';

describe('parseAllowedOrigins', () => {
  it('undefined / empty => []', () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(''), []);
    assert.deepEqual(parseAllowedOrigins('   '), []);
  });

  it('splits on commas, trims, drops empties', () => {
    assert.deepEqual(
      parseAllowedOrigins('http://localhost:5173, https://dash.example.com ,, '),
      ['http://localhost:5173', 'https://dash.example.com'],
    );
  });

  it('strips trailing slashes', () => {
    assert.deepEqual(parseAllowedOrigins('http://localhost:5173///'), ['http://localhost:5173']);
  });
});

describe('isOriginAllowed', () => {
  it('missing Origin => true (non-browser clients)', () => {
    assert.equal(isOriginAllowed(undefined, 'localhost:3001', []), true);
    assert.equal(isOriginAllowed('', 'localhost:3001', []), true);
  });

  it('same host+port => true', () => {
    assert.equal(isOriginAllowed('http://localhost:3001', 'localhost:3001', []), true);
    assert.equal(isOriginAllowed('http://127.0.0.1:3001', '127.0.0.1:3001', []), true);
  });

  it('same host without port => true', () => {
    assert.equal(isOriginAllowed('http://localhost', 'localhost', []), true);
  });

  it('host comparison is case-insensitive', () => {
    assert.equal(isOriginAllowed('HTTP://LOCALHOST:3001', 'localhost:3001', []), true);
    assert.equal(isOriginAllowed('http://localhost:3001', 'LOCALHOST:3001', []), true);
  });

  it('different port => false', () => {
    assert.equal(isOriginAllowed('http://localhost:5173', 'localhost:3001', []), false);
  });

  it('different host => false', () => {
    assert.equal(isOriginAllowed('http://evil.com', 'localhost:3001', []), false);
    // Suffix trickery must not match.
    assert.equal(
      isOriginAllowed('http://localhost:3001.evil.com', 'localhost:3001', []),
      false,
    );
  });

  it('explicitly allowed origin => true', () => {
    const allowed = ['http://localhost:5173'];
    assert.equal(isOriginAllowed('http://localhost:5173', 'localhost:3001', allowed), true);
  });

  it('allowed entry with trailing slash matches slash-less Origin', () => {
    const allowed = parseAllowedOrigins('http://localhost:5173/');
    assert.equal(isOriginAllowed('http://localhost:5173', 'localhost:3001', allowed), true);
  });

  it('Origin "null" => false, even if allow-listed', () => {
    assert.equal(isOriginAllowed('null', 'localhost:3001', []), false);
    assert.equal(isOriginAllowed('null', 'localhost:3001', ['null']), false);
  });

  it('malformed origin => false without throwing', () => {
    for (const bad of ['not a url', 'http://[:::', '::::', 'http://']) {
      assert.doesNotThrow(() => isOriginAllowed(bad, 'localhost:3001', []));
      assert.equal(isOriginAllowed(bad, 'localhost:3001', []), false);
    }
  });

  it('very long input => false without throwing', () => {
    const long = `http://${'a'.repeat(100_000)}.com`;
    assert.doesNotThrow(() => isOriginAllowed(long, 'localhost:3001', []));
    assert.equal(isOriginAllowed(long, 'localhost:3001', []), false);
  });

  it('host undefined: allowed-list still works, otherwise false', () => {
    assert.equal(
      isOriginAllowed('http://localhost:5173', undefined, ['http://localhost:5173']),
      true,
    );
    assert.equal(isOriginAllowed('http://localhost:5173', undefined, []), false);
  });

  it('allow-list is exact (no substring matching)', () => {
    const allowed = ['http://localhost:5173'];
    assert.equal(
      isOriginAllowed('http://localhost:5173.evil.com', 'localhost:3001', allowed),
      false,
    );
    assert.equal(isOriginAllowed('http://evil-localhost:5173', 'localhost:3001', allowed), false);
  });
});
