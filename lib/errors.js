'use strict';

const beforeFirstConnect = Symbol('beforeFirstConnect');

const PERMANENT_CODES = new Set([
  'PaymentRequired',
  'Unauthorized',
  'AuthorizationRequired',
  'Forbidden',
  'BadRequest',
  'NotFound',
  'UpgradeRequired',
]);

/** An error response from the tuna.am API. */
class ServerError extends Error {
  constructor({ status, code = '', text, requestId = '', retryAfter = 0 }) {
    super(requestId ? `tuna: ${text} (request id ${requestId})` : `tuna: ${text}`);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
    this.text = text;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this[beforeFirstConnect] = false;
  }

  /** Whether retrying the request is pointless. */
  get permanent() {
    const s = this.status;
    if (s >= 300 && s < 400) {
      return true;
    }
    if (this[beforeFirstConnect] && s >= 400 && s < 500 && s !== 408 && s !== 429) {
      return true;
    }
    return PERMANENT_CODES.has(this.code);
  }
}

const TERMINATE_MESSAGES = {
  deleted: 'tunnel was deleted',
  suspended: 'tunnel was suspended',
  session_limit: 'session time limit reached',
  session_ended: 'client session ended',
  reconnect: 'tunnel was taken over by another connection',
};

function terminateMessage(reason) {
  return TERMINATE_MESSAGES[reason] || `tunnel terminated by server (${reason})`;
}

/** The server closed the tunnel for good. */
class TerminatedError extends Error {
  constructor(reason) {
    super(`tuna: ${terminateMessage(reason)}`);
    this.name = 'TerminatedError';
    this.reason = reason;
  }
}

/** The node stopped answering keepalive requests. */
class KeepAliveTimeoutError extends Error {
  constructor() {
    super('tuna: keepalive timeout');
    this.name = 'KeepAliveTimeoutError';
  }
}

/** Reports whether retrying after err is pointless. */
function isPermanent(err) {
  return err instanceof TerminatedError || (err instanceof ServerError && err.permanent);
}

module.exports = {
  ServerError,
  TerminatedError,
  KeepAliveTimeoutError,
  isPermanent,
  terminateMessage,
  beforeFirstConnect,
};
