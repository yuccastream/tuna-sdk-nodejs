# tuna-sdk-nodejs

Open [tuna.am](https://tuna.am) tunnels straight from Node.js code: expose a
local HTTP or TCP service at a public address without installing the `tuna`
CLI.

- Two ways in: `listen` hands every visitor's connection to your code as a
  stream, `forward` proxies connections to a local address.
- Survives network failures: reconnects with backoff and keeps the same
  public address.
- Small: one dependency, [`ssh2`](https://www.npmjs.com/package/ssh2).

The API is not stable yet: it may change before v1.

## Install

```shell
npm install @tuna.am/sdk
```

Requires Node.js 18 or later. TypeScript types are included. The examples
below are ES modules; `require('@tuna.am/sdk')` works too.

## Authentication

Create an API key with the `tunnels:connect` scope at
[my.tuna.am](https://my.tuna.am) and pass it in `apiKey` or the
`TUNA_API_KEY` environment variable.

## Serve HTTP without a local port

```js
import http from 'node:http';
import tuna from '@tuna.am/sdk';

const server = http.createServer((req, res) => res.end('hello\n'));
const tunnel = tuna.listen({ protocol: 'http' });
tunnel.on('connection', (stream) => server.emit('connection', stream));

console.log('public URL:', await tunnel.ready);
```

`tunnel.close()` stops accepting connections and reconnecting; connections
accepted earlier keep working, and `tunnel.done` resolves once the last of
them closes. Attach the `connection` listener right away: a connection that
arrives while nobody listens is dropped.

## Forward to a local service

```js
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

await tuna.forward({
  protocol: 'tcp',
  port: 'my-db',
  signal: controller.signal,
  onEvent: (e) => {
    if (e.type === 'connected') console.log(`forwarding ${e.url} -> 127.0.0.1:5432`);
  },
}, '127.0.0.1:5432');
```

The local address is `host:port` or `unix:///path/to.sock`. `forward`
resolves when `signal` is aborted and rejects when the tunnel ends for good.

A complete command-line example is [`examples/runner.js`](examples/runner.js):

```shell
TUNA_API_KEY=... node examples/runner.js http 3000
```

## Options

| Field | Meaning |
|---|---|
| `protocol` | `http` or `tcp`, required |
| `apiKey` | API key, defaults to `$TUNA_API_KEY` |
| `subdomain`, `domain` | reserved subdomain or custom domain for HTTP |
| `port` | reserved TCP port or its alias |
| `proxyProtocol` | PROXY protocol header version for TCP: `1` or `2` |
| `cidrAllow`, `cidrDeny` | client CIDRs filtered by the tuna.am node, TCP only |
| `location` | only for names and ports reserved in the legacy `ru` or `nl` zones; empty lets the server pick |
| `signal` | `AbortSignal`: aborting it closes the tunnel and every accepted connection |
| `onEvent` | callback for tunnel events |
| `connectTimeout` | limit in milliseconds on the wait for the first connection; zero means no limit |
| `serverURL`, `clientName` | API address and client name reported to the server |

## Events and errors

`onEvent` and the `Tunnel` emitter receive `connected`, `reconnecting`,
`reconnected`, `banner`, `session_expiring`, `terminated` and `local_error`
as objects `{ type, url, message, reason, error, retryIn, expiresIn }`;
durations are in milliseconds. `onEvent` also sees events emitted before
`listen` returns to your code.

Network failures and temporary server errors are retried: the pause grows from
1 to 15 seconds with random jitter, and `Retry-After` is respected. The tunnel
ends with an error when retrying is pointless; check it with `isPermanent`:

- `ServerError` — the API rejected the request: bad or revoked key, missing
  scope, unknown reserved name, unpaid plan. Has `status`, `code`, `text`
  and `requestId`;
- `TerminatedError` — the server closed the tunnel: it was deleted,
  suspended or hit the session time limit. Has `reason`.

A connection that stopped answering is detected within 15 seconds and
reported as `reconnecting` with a `KeepAliveTimeoutError`.

## Behaviour worth knowing

- `options.signal` bounds the whole life of the tunnel, not only the first
  connection. To give up early when the tunnel does not come up, set
  `connectTimeout`.
- A stream from `connection` counts as open until it emits `close`: read it
  to the end, as `http.Server` does, or `tunnel.done` will wait for it.
- In `forward`, when the visitor closes its side of a connection, the
  connection is closed in both directions: a response sent after that is lost.
- The `Host` header and the PROXY protocol header reach your service as sent.
- The API client is the built-in `fetch`; on Node.js 24 and later it honours
  `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`. Connections to tuna.am nodes are
  plain SSH over TCP and do not use the proxy.
- Use `NODE_EXTRA_CA_CERTS` for a private CA in front of the API.

## Contributing

This repository is a read-only mirror of the SDK directory in the tuna.am
monorepo. Issues and pull requests are welcome here: accepted changes are
applied upstream and come back with the next release.

## License

[MIT](LICENSE)
