import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from './auth';

const USER = 'admin';
const PASS = 's3cret!';

const basic = (u: string, p: string) =>
  `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;

describe('isAuthorized', () => {
  it('auth disabled when expected password is empty (any header passes)', () => {
    assert.equal(isAuthorized(undefined, USER, ''), true);
    assert.equal(isAuthorized('Bearer xyz', USER, ''), true);
    assert.equal(isAuthorized(basic('wrong', 'wrong'), USER, ''), true);
    assert.equal(isAuthorized('garbage', USER, ''), true);
  });

  it('accepts valid credentials', () => {
    assert.equal(isAuthorized(basic(USER, PASS), USER, PASS), true);
  });

  it('accepts scheme case-insensitively ("basic", "BASIC")', () => {
    const b64 = Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64');
    assert.equal(isAuthorized(`basic ${b64}`, USER, PASS), true);
    assert.equal(isAuthorized(`BASIC ${b64}`, USER, PASS), true);
  });

  it('rejects wrong user', () => {
    assert.equal(isAuthorized(basic('intruder', PASS), USER, PASS), false);
  });

  it('rejects wrong password', () => {
    assert.equal(isAuthorized(basic(USER, 'nope'), USER, PASS), false);
  });

  it('rejects when both user and password are wrong', () => {
    assert.equal(isAuthorized(basic('a', 'b'), USER, PASS), false);
  });

  it('rejects missing header', () => {
    assert.equal(isAuthorized(undefined, USER, PASS), false);
  });

  it('rejects empty-string header', () => {
    assert.equal(isAuthorized('', USER, PASS), false);
  });

  it('rejects wrong scheme (Bearer)', () => {
    const b64 = Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64');
    assert.equal(isAuthorized(`Bearer ${b64}`, USER, PASS), false);
  });

  it('rejects bad base64 without throwing', () => {
    assert.doesNotThrow(() => isAuthorized('Basic !!!not-base64!!!', USER, PASS));
    assert.equal(isAuthorized('Basic !!!not-base64!!!', USER, PASS), false);
    assert.equal(isAuthorized('Basic ', USER, PASS), false);
  });

  it('rejects credentials with no colon without throwing', () => {
    const noColon = `Basic ${Buffer.from('nocolonhere', 'utf8').toString('base64')}`;
    assert.doesNotThrow(() => isAuthorized(noColon, USER, PASS));
    assert.equal(isAuthorized(noColon, USER, PASS), false);
  });

  it('supports passwords containing ":" (splits on FIRST colon only)', () => {
    const colonPass = 'p:a:ss:word';
    assert.equal(isAuthorized(basic(USER, colonPass), USER, colonPass), true);
    // A password that only matches after the first colon must not pass.
    assert.equal(isAuthorized(basic(USER, 'a:ss:word'), USER, colonPass), false);
    // User part must stop at the first colon: smuggling ":suffix" into the
    // user field must not authenticate.
    const smuggled = `Basic ${Buffer.from(` Bc${USER}:${colonPass}`, 'utf8').toString('base64')}`;
    assert.equal(isAuthorized(smuggled, USER, colonPass), false);
  });

  it('rejects empty provided user against a non-empty expected user', () => {
    assert.equal(isAuthorized(basic('', PASS), USER, PASS), false);
  });

  it('rejects very long input without throwing', () => {
    const long = `Basic ${'A'.repeat(100_000)}`;
    assert.doesNotThrow(() => isAuthorized(long, USER, PASS));
    assert.equal(isAuthorized(long, USER, PASS), false);
  });

  it('supports unicode passwords', () => {
    const uniPass = 'pässwörd🔑';
    assert.equal(isAuthorized(basic(USER, uniPass), USER, uniPass), true);
    assert.equal(isAuthorized(basic(USER, 'pässwörd🔒'), USER, uniPass), false);
  });

  it('handles length mismatch without throwing (no timingSafeEqual exception)', () => {
    assert.doesNotThrow(() => isAuthorized(basic('a-very-long-username', 'x'), USER, PASS));
    assert.equal(isAuthorized(basic('a-very-long-username', 'x'), USER, PASS), false);
  });
});
