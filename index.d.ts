import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';

/** SDK version, reported to the server. */
export declare const VERSION: string;
/** The tuna.am API used when serverURL is empty. */
export declare const DEFAULT_SERVER_URL: string;

export type EventType =
  | 'connected'
  | 'reconnected'
  | 'reconnecting'
  | 'banner'
  | 'session_expiring'
  | 'terminated'
  | 'local_error';

/** A change in the tunnel state. */
export interface TunnelEvent {
  type: EventType;
  /** Public address, set for connected and reconnected. */
  url?: string;
  /** Human-readable text, set for banner and terminated. */
  message?: string;
  /** Machine-readable cause, set for terminated. */
  reason?: string;
  /** The cause, set for reconnecting and local_error. */
  error?: Error;
  /** Delay before the next attempt in milliseconds, set for reconnecting. */
  retryIn?: number;
  /** Time left in milliseconds, set for session_expiring. */
  expiresIn?: number;
}

export interface Options {
  /** "http" or "tcp". */
  protocol: 'http' | 'tcp';
  /** API key with the tunnels:connect scope. Defaults to TUNA_API_KEY. */
  apiKey?: string;
  /** Only for names and ports reserved in the legacy "ru" or "nl" zones. */
  location?: string;
  /** Reserved subdomain for HTTP tunnels. */
  subdomain?: string;
  /** Custom domain for HTTP tunnels. */
  domain?: string;
  /** Reserved TCP port or its alias. */
  port?: string | number;
  /** PROXY protocol header version for TCP tunnels: 1 or 2. */
  proxyProtocol?: number;
  /** Client CIDRs allowed to reach a TCP tunnel. */
  cidrAllow?: string[];
  /** Client CIDRs rejected by a TCP tunnel. */
  cidrDeny?: string[];
  /** tuna.am API address. Defaults to DEFAULT_SERVER_URL. */
  serverURL?: string;
  /** Client name reported to the server. Defaults to "tuna-sdk-node/<VERSION>". */
  clientName?: string;
  /** Limit in milliseconds on the wait for the first connection. Zero means no limit. */
  connectTimeout?: number;
  /** Aborting it closes the tunnel together with every accepted connection. */
  signal?: AbortSignal;
  /** Receives every tunnel event, including those emitted before listeners are attached. */
  onEvent?: (event: TunnelEvent) => void;
}

/** A tuna.am tunnel. */
export declare class Tunnel extends EventEmitter {
  /** The current public address, e.g. https://name.tuna.am. */
  readonly url: string;
  /** Resolves with the public URL once the tunnel is up; rejects if it never comes up. */
  readonly ready: Promise<string>;
  /** Resolves after close() or abort, rejects with a permanent error. */
  readonly done: Promise<void>;
  /**
   * Stops accepting connections and reconnecting. Connections accepted
   * earlier keep working until they close.
   */
  close(): void;

  on(event: 'connection', listener: (stream: Duplex) => void): this;
  on(event: EventType, listener: (event: TunnelEvent) => void): this;
  on(event: 'close', listener: (err?: Error) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: 'connection', listener: (stream: Duplex) => void): this;
  once(event: EventType, listener: (event: TunnelEvent) => void): this;
  once(event: 'close', listener: (err?: Error) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
}

/** Connects a tunnel whose visitors arrive as "connection" events. */
export declare function listen(options: Options): Tunnel;

/**
 * Proxies tunnel connections to addr ("host:port" or "unix:///path.sock").
 * Resolves when options.signal is aborted after the tunnel came up.
 */
export declare function forward(options: Options, addr: string): Promise<void>;

/** An error response from the tuna.am API. */
export declare class ServerError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code. */
  readonly code: string;
  /** Error text from the server. */
  readonly text: string;
  /** Identifies the request for tuna.am support. */
  readonly requestId: string;
  /** Delay requested by the server in milliseconds, zero if none. */
  readonly retryAfter: number;
  /** Whether retrying the request is pointless. */
  readonly permanent: boolean;
}

/** The server closed the tunnel for good. */
export declare class TerminatedError extends Error {
  /** Machine-readable cause, e.g. "deleted" or "session_limit". */
  readonly reason: string;
}

/** The node stopped answering keepalive requests. */
export declare class KeepAliveTimeoutError extends Error {}

/** Reports whether retrying after err is pointless. */
export declare function isPermanent(err: unknown): boolean;
