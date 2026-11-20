'use strict';
/**
 * gas-env.js: runs apps-script/Code.gs in Node with mocked Google services.
 *
 * Apps Script provides global services (PropertiesService, CacheService, ...).
 * Node has none of them, so this file builds small in-memory stand-ins and
 * evaluates Code.gs inside a fresh `vm` context that has them as globals.
 *
 *   const env = createGasEnv({ props: {...}, fetch: (req) => ({ code, body, headers }) });
 *   env.call('refresh');                 // calls a function defined in Code.gs
 *   env.cache.dump();                    // what the script cached
 *   env.requests;                        // every UrlFetchApp request, parsed
 *   env.logs;                            // everything console.log/error printed
 *   env.mail.sent;                       // every MailApp.sendEmail call (nothing is sent)
 *
 * The same environment drives the live check (tests/live), which passes a
 * fetch handler that really calls Monday (read-only).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE_GS = path.join(__dirname, '..', '..', 'apps-script', 'Code.gs');

/**
 * @param {Object} opts
 * @param {Object<string,string>} [opts.props] Script Properties.
 * @param {function(Object): {code:number, body:string, headers?:Object}} [opts.fetch]
 *     Handles UrlFetchApp.fetch. Receives {url, options, payload} (payload parsed).
 * @param {boolean} [opts.realSleep] Really sleep in Utilities.sleep (sandbox runs).
 */
function createGasEnv(opts) {
  const options = opts || {};
  const env = {
    props: Object.assign({}, options.props || {}),
    requests: [],
    logs: [],
    sleeps: [],
    triggers: [],
    lockAvailable: true,
    lockAcquisitions: 0,
    lockReleases: 0,
    // MailApp stand-in: records messages, never sends anything.
    mail: { sent: [], remainingQuota: 100, failNext: false }
  };

  // ---------------------------------------------------------------- PropertiesService
  const scriptProperties = {
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(env.props, key) ? String(env.props[key]) : null),
    getProperties: () => Object.assign({}, env.props),
    setProperty: (key, value) => { env.props[key] = String(value); return scriptProperties; },
    deleteProperty: (key) => { delete env.props[key]; return scriptProperties; }
  };

  // ---------------------------------------------------------------- CacheService
  const store = new Map(); // key -> {value, ttl}
  const scriptCache = {
    get: (key) => (store.has(key) ? store.get(key).value : null),
    getAll: (keys) => {
      const out = {};
      keys.forEach((key) => { if (store.has(key)) out[key] = store.get(key).value; });
      return out;
    },
    put: (key, value, ttl) => { store.set(key, { value: String(value), ttl: ttl }); },
    putAll: (values, ttl) => {
      env.putAllCalls = (env.putAllCalls || 0) + 1;
      Object.keys(values).forEach((key) => store.set(key, { value: String(values[key]), ttl: ttl }));
    },
    remove: (key) => { store.delete(key); }
  };
  env.cache = {
    keys: () => Array.from(store.keys()),
    ttlOf: (key) => (store.has(key) ? store.get(key).ttl : null),
    evict: (key) => store.delete(key),
    clear: () => store.clear(),
    /** Every cached value, parsed: key -> object. */
    dump: () => {
      const out = {};
      store.forEach((entry, key) => { out[key] = JSON.parse(entry.value); });
      return out;
    },
    raw: () => Array.from(store.values()).map((entry) => entry.value).join('\n')
  };

  // ---------------------------------------------------------------- LockService
  const scriptLock = {
    held: false,
    tryLock: () => {
      if (!env.lockAvailable) return false;
      scriptLock.held = true;
      env.lockAcquisitions++;
      return true;
    },
    releaseLock: () => { if (scriptLock.held) env.lockReleases++; scriptLock.held = false; },
    hasLock: () => scriptLock.held
  };

  // ---------------------------------------------------------------- UrlFetchApp
  const UrlFetchApp = {
    fetch: (url, fetchOptions) => {
      const payload = fetchOptions && fetchOptions.payload ? JSON.parse(fetchOptions.payload) : null;
      const request = { url: url, options: fetchOptions, payload: payload };
      env.requests.push(request);
      if (!options.fetch) throw new Error('no fetch handler');
      const res = options.fetch(request);
      return {
        getResponseCode: () => res.code,
        getContentText: () => res.body,
        getHeaders: () => res.headers || {}
      };
    }
  };

  // ---------------------------------------------------------------- MailApp
  const MailApp = {
    getRemainingDailyQuota: () => env.mail.remainingQuota,
    sendEmail: (message) => {
      if (env.mail.failNext) {
        env.mail.failNext = false;
        throw new Error('Invalid email: ' + message.to); // like Apps Script, the message quotes the address
      }
      env.mail.sent.push(message);
      env.mail.remainingQuota--;
    }
  };

  // ---------------------------------------------------------------- Utilities
  // Java returns signed bytes (-128..127); mimic that exactly.
  const signed = (buffer) => Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (algorithm, value) => signed(crypto.createHash('sha256').update(String(value), 'utf8').digest()),
    computeHmacSha256Signature: (value, key) => signed(crypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update(String(value), 'utf8').digest()),
    base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64'),
    // Apps Script's web-safe variant keeps the "=" padding.
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    sleep: (ms) => {
      env.sleeps.push(ms);
      if (options.realSleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  };

  // ---------------------------------------------------------------- ContentService
  const ContentService = {
    MimeType: { JSON: 'application/json', CSV: 'text/csv' },
    createTextOutput: (content) => {
      const output = {
        content: content,
        mimeType: null,
        fileName: null,
        setMimeType: (type) => { output.mimeType = type; return output; },
        downloadAsFile: (name) => { output.fileName = name; return output; },
        getContent: () => output.content,
        getMimeType: () => output.mimeType,
        getFileName: () => output.fileName
      };
      return output;
    }
  };

  // ---------------------------------------------------------------- ScriptApp
  const ScriptApp = {
    getProjectTriggers: () => env.triggers.map((t) => ({ getHandlerFunction: () => t.handler })),
    newTrigger: (handler) => {
      const trigger = { handler: handler, minutes: null };
      const builder = {
        timeBased: () => builder,
        everyMinutes: (n) => { trigger.minutes = n; return builder; },
        create: () => { env.triggers.push(trigger); return trigger; }
      };
      return builder;
    }
  };

  // ---------------------------------------------------------------- console
  const capture = (level) => (...args) => {
    env.logs.push({ level: level, text: args.map(String).join(' ') });
    if (options.echoLogs) process.stdout.write('[' + level + '] ' + args.map(String).join(' ') + '\n');
  };
  const consoleMock = { log: capture('log'), info: capture('log'), warn: capture('warn'), error: capture('error') };

  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => scriptProperties },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: () => scriptLock },
    UrlFetchApp: UrlFetchApp,
    MailApp: MailApp,
    Utilities: Utilities,
    ContentService: ContentService,
    ScriptApp: ScriptApp,
    console: consoleMock
  });
  vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), context, { filename: 'Code.gs' });

  /** Calls a top-level function from Code.gs. */
  env.call = (name, ...args) => {
    if (typeof context[name] !== 'function') throw new Error('Code.gs has no function ' + name);
    return context[name](...args);
  };
  /** Evaluates an expression inside the script (e.g. a const). */
  env.eval = (expr) => vm.runInContext(expr, context);
  /** Convenience: doGet for a token, parsed. */
  env.get = (token) => {
    const out = env.call('doGet', token === undefined ? undefined : { parameter: { link: token } });
    return { body: JSON.parse(out.getContent()), mimeType: out.getMimeType() };
  };
  /** Convenience: doPost with a JSON body like the page sends ({email}), parsed. */
  env.post = (body) => {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    const out = env.call('doPost', { parameter: {}, postData: { contents: contents, type: 'text/plain' } });
    return { body: JSON.parse(out.getContent()), mimeType: out.getMimeType() };
  };
  /** The token Code.gs would give an address (uses LINK_SECRET from the props). */
  env.tokenFor = (email) => env.call('tokenFor_', env.props.LINK_SECRET, String(email).trim().toLowerCase());
  env.logText = () => env.logs.map((l) => l.text).join('\n');
  return env;
}

module.exports = { createGasEnv };
