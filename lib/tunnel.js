'use strict';

const net = require('node:net');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { Client, utils } = require('ssh2');

const api = require('./api.js');
const {
  ServerError,
  TerminatedError,
  KeepAliveTimeoutError,
  isPermanent,
  terminateMessage,
  beforeFirstConnect,
} = require('./errors.js');

const SSH_USER = 'tuna';
const DIAL_TIMEOUT = 10000;
const KEEPALIVE_INTERVAL = 5000;
const KEEPALIVE_COUNT_MAX = 2;
const EVENTS_DRAIN_TIMEOUT = 1000;
const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 15000;

function normalizeOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('tuna: options object is required');
  }
  const o = { ...options };
  o.apiKey = o.apiKey || process.env.TUNA_API_KEY || '';
  if (!o.apiKey) {
    throw new Error('tuna: API key is required: set options.apiKey or TUNA_API_KEY');
  }
  if (o.protocol !== 'http' && o.protocol !== 'tcp') {
    throw new Error(`tuna: unsupported protocol "${o.protocol}"`);
  }
  o.serverURL = o.serverURL || api.DEFAULT_SERVER_URL;
  api.checkServerURL(o.serverURL);
  o.clientName = o.clientName || `tuna-sdk-node/${api.VERSION}`;
  if (/\p{Cc}/u.test(o.clientName)) {
    throw new Error('tuna: clientName must not contain control characters');
  }
  return o;
}

function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  if (i < 0) {
    return null;
  }
  const host = s.slice(0, i).replace(/^\[(.*)\]$/, '$1');
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

function parseLocalAddr(addr) {
  if (typeof addr === 'string' && addr.startsWith('unix://')) {
    return { path: addr.slice('unix://'.length) };
  }
  const hp = typeof addr === 'string' ? splitHostPort(addr) : null;
  if (!hp) {
    throw new TypeError(`tuna: local address "${addr}" is not host:port or unix:///path.sock`);
  }
  return hp;
}

function hostKeys(cr) {
  return (cr.host_keys || []).map((hk) => {
    const key = utils.parseKey(String(hk.key || ''));
    if (key instanceof Error) {
      throw new Error(`tuna: parse host key: ${key.message}`);
    }
    return key.getPublicSSH();
  });
}

function retryDelay(backoff, err) {
  const wait = Math.min(MAX_BACKOFF, MIN_BACKOFF + Math.random() * backoff);
  if (err instanceof ServerError && err.retryAfter > wait) {
    return err.retryAfter;
  }
  return wait;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function closedError() {
  return new Error('tuna: tunnel closed');
}

/**
 * A tuna.am tunnel. Emits tunnel events by their type ("connected",
 * "reconnecting", ...), "connection" with a stream.Duplex for every visitor
 * when created by listen(), and "close" with the final error, if any.
 */
class Tunnel extends EventEmitter {
  #o;
  #forwardsTo;
  #local;
  #url = '';
  #sessionId = '';
  #everUp = false;
  #bannerShown = false;
  #lastErr = null;
  #startErr = null;
  #killed = false;
  #closer = new AbortController();
  #resolveReady;
  #rejectReady;
  #resolveDone;
  #rejectDone;

  constructor(options, forwardsTo = '', local = null) {
    super();
    this.#o = normalizeOptions(options);
    this.#forwardsTo = forwardsTo;
    this.#local = local;
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.done = new Promise((resolve, reject) => {
      this.#resolveDone = resolve;
      this.#rejectDone = reject;
    });
    this.ready.catch(() => {});
    this.done.catch(() => {});

    const { signal, connectTimeout } = this.#o;
    if (signal) {
      if (signal.aborted) {
        this.#kill();
      } else {
        signal.addEventListener('abort', () => this.#kill(), { once: true });
      }
    }
    if (connectTimeout > 0) {
      const timer = setTimeout(() => {
        this.#startErr = new Error(`tuna: tunnel did not come up within ${connectTimeout} ms`);
        this.#kill();
      }, connectTimeout);
      timer.unref();
      this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    }
    process.nextTick(() => this.#run());
  }

  /** The current public address, e.g. https://name.tuna.am or tcp://ru.tuna.am:40000. */
  get url() {
    return this.#url;
  }

  /**
   * Stops accepting connections and reconnecting. Connections accepted
   * earlier keep working: the tunnel stays connected until the last of them
   * is closed. Abort options.signal to cut them off as well.
   */
  close() {
    this.#closer.abort();
  }

  #kill() {
    this.#killed = true;
    this.#closer.abort();
  }

  #emit(e) {
    if (this.#o.onEvent) {
      this.#o.onEvent(e);
    }
    this.emit(e.type, e);
  }

  #startError(err) {
    if (!this.#lastErr) {
      return err;
    }
    return new Error(`${err.message} (last attempt: ${this.#lastErr.message})`, { cause: this.#lastErr });
  }

  #finish(err) {
    if (!this.#everUp) {
      const startErr = this.#startErr || (this.#killed ? new Error('tuna: tunnel aborted') : closedError());
      this.#rejectReady(err || this.#startError(startErr));
    }
    if (err) {
      this.#rejectDone(err);
    } else {
      this.#resolveDone();
    }
    this.emit('close', err || undefined);
  }

  async #run() {
    let backoff = MIN_BACKOFF;
    for (;;) {
      let connected = false;
      let error;
      try {
        ({ connected, error } = await this.#session());
      } catch (err) {
        error = err;
      }
      if (this.#closer.signal.aborted) {
        this.#finish(null);
        return;
      }
      if (!this.#everUp && error instanceof ServerError) {
        error[beforeFirstConnect] = true;
      }
      this.#lastErr = error;
      if (isPermanent(error)) {
        if (error instanceof TerminatedError) {
          this.#emit({ type: 'terminated', reason: error.reason, message: terminateMessage(error.reason) });
        }
        this.#finish(error);
        return;
      }
      if (connected) {
        backoff = MIN_BACKOFF;
      }
      const wait = retryDelay(backoff, error);
      this.#emit({ type: 'reconnecting', error, retryIn: wait });
      if (!(await sleep(wait, this.#closer.signal))) {
        this.#finish(null);
        return;
      }
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  async #session() {
    const body = api.connectBody(this.#o, this.#forwardsTo, this.#sessionId);
    const cr = await api.postConnect(this.#o, body, this.#closer.signal);
    this.#sessionId = cr.tunnel_session_id || '';
    if (cr.banner && !this.#bannerShown) {
      this.#bannerShown = true;
      this.#emit({ type: 'banner', message: cr.banner });
    }
    const keys = hostKeys(cr);
    const addr = splitHostPort(String(cr.address || ''));
    if (!addr) {
      throw new Error(`tuna: invalid node address "${cr.address}"`);
    }
    return new Promise((resolve) => this.#ssh(cr, keys, addr, resolve));
  }

  #ssh(cr, keys, addr, resolve) {
    const client = new Client();
    const signal = this.#closer.signal;
    let ready = false;
    let connected = false;
    let closing = false;
    let active = 0;
    let failErr = null;
    let eventsDone = null;

    const fail = (err) => {
      if (!failErr) {
        failErr = err;
      }
      client.destroy();
    };
    const onClose = () => {
      if (this.#killed || !connected) {
        fail(closedError());
        return;
      }
      closing = true;
      if (active === 0) {
        fail(closedError());
      }
    };

    client.on('error', (err) => {
      if (ready && err.level === 'client-timeout') {
        fail(new KeepAliveTimeoutError());
      } else if (err.level === 'handshake' && /^Host denied/.test(err.message)) {
        fail(new Error(`tuna: host key verification failed for ${cr.address}`));
      } else {
        fail(new Error(`tuna: ${err.message}`, { cause: err }));
      }
    });
    client.on('close', async () => {
      signal.removeEventListener('abort', onClose);
      if (eventsDone) {
        let timer;
        await Promise.race([eventsDone, new Promise((r) => { timer = setTimeout(r, EVENTS_DRAIN_TIMEOUT); })]);
        clearTimeout(timer);
      }
      resolve({ connected, error: failErr || new Error('tuna: connection to node lost') });
    });
    client.on('tcp connection', (info, accept, reject) => {
      if (!connected || closing) {
        reject();
        return;
      }
      const stream = accept();
      active++;
      stream.once('close', () => {
        active--;
        if (closing && active === 0) {
          fail(closedError());
        }
      });
      if (this.#local) {
        this.#pipe(stream);
      } else if (this.listenerCount('connection') > 0) {
        this.emit('connection', stream);
      } else {
        stream.destroy();
      }
    });
    client.on('ready', () => {
      ready = true;
      client.forwardIn('127.0.0.1', 0, (err) => {
        if (failErr) {
          return;
        }
        if (err) {
          fail(new Error(`tuna: remote forward: ${err.message}`));
          return;
        }
        eventsDone = this.#events(client, fail);
        connected = true;
        this.#url = api.publicURL(cr, this.#o.protocol);
        if (this.#everUp) {
          this.#emit({ type: 'reconnected', url: this.#url });
        } else {
          this.#everUp = true;
          this.#emit({ type: 'connected', url: this.#url });
          this.#resolveReady(this.#url);
        }
      });
    });

    if (signal.aborted) {
      fail(closedError());
      resolve({ connected, error: failErr });
      return;
    }
    signal.addEventListener('abort', onClose, { once: true });
    client.connect({
      host: addr.host,
      port: addr.port,
      username: SSH_USER,
      password: cr.token,
      readyTimeout: DIAL_TIMEOUT,
      keepaliveInterval: KEEPALIVE_INTERVAL,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      hostVerifier: (key) => keys.some((k) => k.equals(key)),
    });
  }

  #events(client, fail) {
    return new Promise((resolve) => {
      client.exec('events', (err, stream) => {
        if (err) {
          resolve();
          return;
        }
        stream.on('close', resolve);
        stream.stderr.resume();
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        lines.on('line', (line) => {
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (!ev || typeof ev !== 'object') {
            return;
          }
          if (ev.type === 'terminate') {
            lines.close();
            resolve();
            fail(new TerminatedError(String(ev.reason || '')));
          } else if (ev.type === 'session_expiring') {
            this.#emit({ type: 'session_expiring', expiresIn: (Number(ev.expires_in) || 0) * 1000 });
          }
        });
      });
    });
  }

  #pipe(stream) {
    const local = net.connect(this.#local);
    let up = false;
    const timer = setTimeout(() => local.destroy(new Error(`dial ${this.#forwardsTo}: timeout`)), DIAL_TIMEOUT);
    local.once('connect', () => {
      up = true;
      clearTimeout(timer);
      stream.pipe(local);
      local.pipe(stream);
    });
    local.on('error', (err) => {
      clearTimeout(timer);
      if (!up) {
        this.#emit({ type: 'local_error', error: err });
      }
      stream.destroy();
    });
    local.on('close', () => stream.resume());
    local.on('finish', () => local.destroy());
    stream.on('end', () => stream.end());
    stream.on('finish', () => stream.destroy());
    stream.on('error', () => local.destroy());
    stream.on('close', () => local.destroy());
  }
}

/**
 * Connects a tunnel whose visitors arrive as "connection" events. Await
 * tunnel.ready for the public URL.
 */
function listen(options) {
  return new Tunnel(options);
}

/**
 * Proxies tunnel connections to addr ("host:port" or "unix:///path.sock").
 * Resolves when options.signal is aborted after the tunnel came up and
 * rejects on a permanent error or if the tunnel never came up.
 */
async function forward(options, addr) {
  const tunnel = new Tunnel(options, addr, parseLocalAddr(addr));
  await tunnel.ready;
  await tunnel.done;
}

module.exports = { Tunnel, listen, forward, parseLocalAddr, splitHostPort, retryDelay, MIN_BACKOFF, MAX_BACKOFF };
