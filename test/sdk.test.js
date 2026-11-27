'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const tuna = require('..');
const api = require('../lib/api.js');
const { beforeFirstConnect } = require('../lib/errors.js');
const { parseLocalAddr, splitHostPort, retryDelay, MIN_BACKOFF, MAX_BACKOFF } = require('../lib/tunnel.js');

function headers(h = {}) {
  return new Headers(h);
}

test('version comes from package.json', () => {
  assert.equal(tuna.VERSION, require('../package.json').version);
});

test('local address', () => {
  assert.deepEqual(parseLocalAddr('127.0.0.1:8080'), { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(parseLocalAddr('[::1]:80'), { host: '::1', port: 80 });
  assert.deepEqual(parseLocalAddr('unix:///tmp/app.sock'), { path: '/tmp/app.sock' });
  for (const bad of ['8080', 'localhost', 'host:0', 'host:70000', 'host:x', 8080]) {
    assert.throws(() => parseLocalAddr(bad), TypeError, String(bad));
  }
  assert.equal(splitHostPort('node.tuna.am'), null);
});

test('connect body', () => {
  const o = { apiKey: 'k', protocol: 'tcp', clientName: 'c/1', port: 'db', cidrAllow: ['10.0.0.0/8'] };
  const b = api.connectBody(o, '127.0.0.1:5432', '');
  assert.equal(b.client_version, 2);
  assert.equal(b.sdk_version, tuna.VERSION);
  assert.equal(b.token, 'k');
  assert.equal(b.tunnel_session_id, '');
  assert.equal(b.port_or_alias, 'db');
  assert.deepEqual(b.cidr_allow_list, ['10.0.0.0/8']);
  assert.equal('cidr_deny_list' in b, false);
  assert.equal(JSON.parse(JSON.stringify(b)).tunnel_session_id, '');
});

test('public URL fallback', () => {
  assert.equal(api.publicURL({ public_url: 'https://x.tuna.am', domain_name: 'y' }, 'http'), 'https://x.tuna.am');
  assert.equal(api.publicURL({ domain_name: 'demo.tuna.am' }, 'http'), 'https://demo.tuna.am');
  assert.equal(api.publicURL({ domain_name: 'ru.tuna.am', endpoint_port: 40001 }, 'tcp'), 'tcp://ru.tuna.am:40001');
});

test('server errors', () => {
  const json = JSON.stringify({ code: 'Unauthorized', error: 'bad key', request_id: 'r1' });
  const unauthorized = api.serverError(401, headers(), json);
  assert.ok(unauthorized instanceof tuna.ServerError);
  assert.equal(unauthorized.message, 'tuna: bad key (request id r1)');
  assert.equal(unauthorized.text, 'bad key');
  assert.ok(tuna.isPermanent(unauthorized));

  const html = api.serverError(404, headers(), '<html>not found</html>');
  assert.equal(html.message, 'tuna: server responded with status 404');
  assert.equal(tuna.isPermanent(html), false);
  html[beforeFirstConnect] = true;
  assert.ok(tuna.isPermanent(html));

  const throttled = api.serverError(429, headers(), '');
  throttled[beforeFirstConnect] = true;
  assert.equal(tuna.isPermanent(throttled), false);

  const redirect = api.serverError(301, headers({ location: 'https://elsewhere' }), '');
  assert.match(redirect.message, /redirects to "https:\/\/elsewhere"/);
  assert.ok(tuna.isPermanent(redirect));

  const unavailable = api.serverError(503, headers({ 'retry-after': '3' }), '');
  assert.equal(unavailable.retryAfter, 3000);
  assert.equal(tuna.isPermanent(unavailable), false);
  assert.equal(api.serverError(503, headers({ 'retry-after': '3600' }), '').retryAfter, 300000);
  assert.equal(api.retryAfter('soon'), 0);
});

test('other errors', () => {
  assert.ok(tuna.isPermanent(new tuna.TerminatedError('deleted')));
  assert.equal(new tuna.TerminatedError('deleted').message, 'tuna: tunnel was deleted');
  assert.equal(new tuna.TerminatedError('x').message, 'tuna: tunnel terminated by server (x)');
  assert.match(new tuna.KeepAliveTimeoutError().message, /keepalive timeout/);
  assert.equal(tuna.isPermanent(new tuna.KeepAliveTimeoutError()), false);
  assert.equal(tuna.isPermanent(new Error('x')), false);
});

test('retry delay', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const d = retryDelay(MAX_BACKOFF, new Error('x'));
    assert.ok(d >= MIN_BACKOFF && d <= MAX_BACKOFF, String(d));
    seen.add(d);
    assert.ok(retryDelay(MIN_BACKOFF, null) < 2 * MIN_BACKOFF);
  }
  assert.ok(seen.size > 1);
  const err = api.serverError(503, headers({ 'retry-after': '60' }), '');
  assert.equal(retryDelay(MIN_BACKOFF, err), 60000);
});

test('options are validated', () => {
  const saved = process.env.TUNA_API_KEY;
  delete process.env.TUNA_API_KEY;
  try {
    assert.throws(() => tuna.listen({ protocol: 'http' }), /API key is required/);
    assert.throws(() => tuna.listen({ apiKey: 'k', protocol: 'udp' }), /unsupported protocol/);
    assert.throws(() => tuna.listen({ apiKey: 'k', protocol: 'http', serverURL: 'ftp://x' }), /invalid server URL/);
    assert.throws(() => tuna.listen({ apiKey: 'k', protocol: 'http', clientName: 'a\nb' }), /control characters/);
  } finally {
    if (saved !== undefined) {
      process.env.TUNA_API_KEY = saved;
    }
  }
});

test('forward rejects a bad local address', async () => {
  await assert.rejects(tuna.forward({ apiKey: 'k', protocol: 'http' }, 'nope'), TypeError);
});

test('close before the tunnel comes up', async () => {
  const t = tuna.listen({ apiKey: 'k', protocol: 'http', serverURL: 'http://127.0.0.1:9' });
  t.close();
  await assert.rejects(t.ready, /tunnel closed/);
  await t.done;
});

test('connect timeout', async () => {
  const events = [];
  const t = tuna.listen({
    apiKey: 'k',
    protocol: 'http',
    serverURL: 'http://127.0.0.1:9',
    connectTimeout: 300,
    onEvent: (e) => events.push(e.type),
  });
  await assert.rejects(t.ready, /did not come up within 300 ms \(last attempt: /);
  assert.deepEqual(events, ['reconnecting']);
});
