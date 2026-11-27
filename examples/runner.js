#!/usr/bin/env node
'use strict';

const net = require('node:net');
const { parseArgs } = require('node:util');
const tuna = require('..');

const USAGE = `Usage:
  runner.js http|tcp <addr> [-s SUBDOMAIN] [-d DOMAIN] [-p PORT] [--proxy-protocol N]
            [--cidr-allow CIDR]... [--cidr-deny CIDR]... [--listen] [--log-format text|json]

addr: 8080, 10.0.0.1:8080, http://localhost:8080, unix:///path/to.sock
Environment: TUNA_API_KEY, TUNA_ADDR, TUNA_LOCATION
`;

function usage(message) {
  if (message) {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.stderr.write(USAGE);
  process.exit(2);
}

function localAddr(s) {
  if (s.startsWith('unix://')) {
    return s;
  }
  if (s.includes('://')) {
    const u = new URL(s);
    if (u.protocol !== 'http:') {
      throw new Error(`scheme "${u.protocol.slice(0, -1)}" is not supported`);
    }
    return `${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${u.port || 80}`;
  }
  if (!s.includes(':')) {
    if (!/^\d+$/.test(s) || Number(s) > 65535) {
      throw new Error(`address "${s}" is not a port, host:port, http:// URL or unix:// path`);
    }
    return `127.0.0.1:${s}`;
  }
  return s;
}

function printer(json, addr) {
  return (e) => {
    if (json) {
      const out = { time: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), event: e.type };
      if (e.url) out.url = e.url;
      if (e.message) out.message = e.message;
      if (e.reason) out.reason = e.reason;
      if (e.error) out.error = e.error.message;
      if (e.retryIn) out.retry_in = e.retryIn / 1000;
      if (e.expiresIn) out.expires_in = e.expiresIn / 1000;
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    switch (e.type) {
      case 'connected':
      case 'reconnected':
        process.stderr.write(`Forwarding ${e.url} -> ${addr}\n`);
        break;
      case 'reconnecting':
        process.stderr.write(`Connection error (${e.error.message}), retry in ${(e.retryIn / 1000).toFixed(1)}s\n`);
        break;
      case 'session_expiring':
        process.stderr.write(`Session expires in ${e.expiresIn / 1000}s\n`);
        break;
      case 'local_error':
        process.stderr.write(`Local service unavailable: ${e.error.message}\n`);
        break;
      case 'banner':
      case 'terminated':
        process.stderr.write(`${e.message}\n`);
        break;
      default:
        process.stderr.write(`Error: ${e.error.message}\n`);
    }
  };
}

function connectOptions(addr) {
  if (addr.startsWith('unix://')) {
    return { path: addr.slice('unix://'.length) };
  }
  const i = addr.lastIndexOf(':');
  return { host: addr.slice(0, i).replace(/^\[(.*)\]$/, '$1'), port: Number(addr.slice(i + 1)) };
}

function pipeTo(addr, stream) {
  const local = net.connect(connectOptions(addr));
  stream.pipe(local);
  local.pipe(stream);
  local.on('error', () => stream.destroy());
  local.on('close', () => stream.resume());
  stream.on('finish', () => stream.destroy());
  stream.on('error', () => local.destroy());
  stream.on('close', () => local.destroy());
}

async function main() {
  const [protocol, ...rest] = process.argv.slice(2);
  if (protocol !== 'http' && protocol !== 'tcp') {
    usage();
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        subdomain: { type: 'string', short: 's' },
        domain: { type: 'string', short: 'd' },
        port: { type: 'string', short: 'p' },
        location: { type: 'string', short: 'l' },
        'proxy-protocol': { type: 'string' },
        'cidr-allow': { type: 'string', multiple: true },
        'cidr-deny': { type: 'string', multiple: true },
        listen: { type: 'boolean' },
        'log-format': { type: 'string', default: 'text' },
      },
    });
  } catch (err) {
    usage(err.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    usage();
  }
  let addr;
  try {
    addr = localAddr(positionals[0]);
  } catch (err) {
    usage(err.message);
  }
  const format = values['log-format'];
  if (format !== 'text' && format !== 'json') {
    usage(`unknown log format "${format}", use text or json`);
  }
  if (!process.env.TUNA_API_KEY) {
    usage('API key is required: set TUNA_API_KEY');
  }

  const onEvent = printer(format === 'json', addr);
  const aborter = new AbortController();
  const options = {
    protocol,
    serverURL: process.env.TUNA_ADDR || tuna.DEFAULT_SERVER_URL,
    location: values.location || process.env.TUNA_LOCATION || '',
    subdomain: values.subdomain,
    domain: values.domain,
    port: values.port,
    proxyProtocol: Number(values['proxy-protocol'] || 0),
    cidrAllow: values['cidr-allow'],
    cidrDeny: values['cidr-deny'],
    signal: aborter.signal,
    onEvent,
  };

  let stopping = false;
  let tunnel = null;
  const stop = () => {
    if (stopping || !tunnel) {
      aborter.abort();
    }
    stopping = true;
    if (tunnel) {
      tunnel.close();
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    if (values.listen) {
      tunnel = tuna.listen(options);
      tunnel.on('connection', (stream) => pipeTo(addr, stream));
      await tunnel.done;
    } else {
      await tuna.forward(options, addr);
    }
  } catch (err) {
    if (stopping || aborter.signal.aborted) {
      return 0;
    }
    if (!(err instanceof tuna.TerminatedError)) {
      onEvent({ type: 'error', error: err });
    }
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code));
