'use strict';

const { ServerError } = require('./errors.js');
const { version: VERSION } = require('../package.json');

const DEFAULT_SERVER_URL = 'https://api.tuna.am';
const CLIENT_VERSION = 2;
const API_TIMEOUT = 15000;
const MAX_RETRY_AFTER = 5 * 60 * 1000;

const GOOS = { win32: 'windows', sunos: 'solaris' };
const GOARCH = { x64: 'amd64', ia32: '386' };

function checkServerURL(s) {
  let u;
  try {
    u = new URL(s);
  } catch (err) {
    throw new Error(`tuna: invalid server URL: ${err.message}`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.host) {
    throw new Error(`tuna: invalid server URL "${s}": want https://host`);
  }
}

function connectBody(o, forwardsTo, sessionId) {
  const body = {
    client_version: CLIENT_VERSION,
    client_name: o.clientName,
    sdk_version: VERSION,
    forwards_to: forwardsTo,
    protocol: o.protocol,
    location: o.location || '',
    subdomain: o.subdomain || '',
    domain: o.domain || '',
    token: o.apiKey,
    os: GOOS[process.platform] || process.platform,
    arch: GOARCH[process.arch] || process.arch,
    port_or_alias: o.port ? String(o.port) : '',
    tunnel_session_id: sessionId,
    proxy_protocol: o.proxyProtocol || 0,
  };
  if (o.cidrAllow && o.cidrAllow.length) {
    body.cidr_allow_list = o.cidrAllow;
  }
  if (o.cidrDeny && o.cidrDeny.length) {
    body.cidr_deny_list = o.cidrDeny;
  }
  return body;
}

function retryAfter(header) {
  if (!/^\d+$/.test(header || '')) {
    return 0;
  }
  return Math.min(Number(header) * 1000, MAX_RETRY_AFTER);
}

function serverError(status, headers, text) {
  const fields = { status, retryAfter: retryAfter(headers.get('retry-after')) };
  if (status >= 300 && status < 400) {
    fields.text = `server redirects to "${headers.get('location') || ''}", check the server URL`;
    return new ServerError(fields);
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (payload && typeof payload === 'object' && payload.error) {
    fields.code = payload.code || '';
    fields.text = String(payload.error);
    fields.requestId = payload.request_id || '';
  } else {
    fields.text = `server responded with status ${status}`;
  }
  return new ServerError(fields);
}

async function postConnect(o, body, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('tuna: API request timed out')), API_TIMEOUT);
  const onAbort = () => ctl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let res;
  let text;
  try {
    res = await fetch(`${o.serverURL.replace(/\/+$/, '')}/v1/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': o.clientName },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (err) {
    if (ctl.signal.aborted && ctl.signal.reason instanceof Error) {
      throw ctl.signal.reason;
    }
    throw new Error(`tuna: ${(err.cause && err.cause.message) || err.message}`, { cause: err });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  if (res.status < 200 || res.status > 299) {
    throw serverError(res.status, res.headers, text);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`tuna: invalid /v1/connect response: ${err.message}`);
  }
}

function publicURL(cr, protocol) {
  if (cr.public_url) {
    return cr.public_url;
  }
  if (protocol === 'tcp') {
    return `tcp://${cr.domain_name}:${cr.endpoint_port || 0}`;
  }
  return `https://${cr.domain_name}`;
}

module.exports = {
  VERSION,
  DEFAULT_SERVER_URL,
  checkServerURL,
  connectBody,
  postConnect,
  publicURL,
  retryAfter,
  serverError,
};
