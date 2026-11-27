'use strict';

const { Tunnel, listen, forward } = require('./lib/tunnel.js');
const { VERSION, DEFAULT_SERVER_URL } = require('./lib/api.js');
const { ServerError, TerminatedError, KeepAliveTimeoutError, isPermanent } = require('./lib/errors.js');

module.exports = {
  VERSION,
  DEFAULT_SERVER_URL,
  Tunnel,
  listen,
  forward,
  ServerError,
  TerminatedError,
  KeepAliveTimeoutError,
  isPermanent,
};
