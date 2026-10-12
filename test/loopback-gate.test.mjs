// Regression test for the 1.4.1 loopback rule:
//
//   the HOST MACHINE is never asked for the LAN password — whatever name or
//   address it reaches its own GUI through — while a LAN device always is.
//
// 1.4.0 decided "loopback" from the Host header (server) and from
// `location.hostname` (client). The desktop host reaches the GUI as `[::1]`
// (browsers report IPv6 literals WITH brackets), the machine name, or the
// host's own LAN address, so both halves judged it a LAN device: the server
// redirected `/` to the password landing page and the client mounted its
// full-screen gate (with the input disabled while no password exists). The
// host was locked out of its own GUI.
//
// Run: node test/loopback-gate.test.mjs   (no dependencies; ~1s)
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-lan-test-'));
process.env.DSH_HOME = HOME;
const PATCH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml');

// The firewall must never be touched for real: stub node:child_process.
const CHILD_PROCESS_STUB = `
export const spawnCalls = [];
export function execFile(cmd, args, opts, cb) {
  spawnCalls.push({ cmd, args });
  const callback = typeof opts === 'function' ? opts : cb;
  if (typeof callback === 'function') process.nextTick(() => callback(null, '', ''));
  return { on() {}, once() {}, kill() {} };
}
export function spawnSync(cmd, args) {
  spawnCalls.push({ cmd, args, sync: true });
  return { status: 0, stdout: '', stderr: '', pid: 1 };
}
export default { execFile, spawnSync };
`;

registerHooks({
  load(url, context, nextLoad) {
    if (url === 'node:child_process') {
      return { format: 'module', shortCircuit: true, source: CHILD_PROCESS_STUB };
    }
    return nextLoad(url, context);
  },
});

const plugin = await import('../lib/index.js');

// ── harness ────────────────────────────────────────────────────────────────
const fails = [];
const ok = [];
const check = (label, condition, detail = '') => {
  (condition ? ok : fails).push(label + (condition ? '' : ` — ${detail}`));
};

const OFFICIAL_REJECTION = { official: 'rejection' };
const OFFICIAL_AUTHORIZE = 'official-authorize';

function makeHarness({ bindHost = '0.0.0.0' } = {}) {
  const routes = new Map();
  const calls = { rejection: 0, authorize: 0 };
  const connection = {
    requestRejection() {
      calls.rejection += 1;
      return OFFICIAL_REJECTION;
    },
    browserAuth: {
      authorizeIndex() {
        calls.authorize += 1;
        return OFFICIAL_AUTHORIZE;
      },
    },
  };
  const webServer = {
    host: bindHost,
    port: 19387,
    config: { host: bindHost, port: 19387, compression: 'gzip', compressionLevel: 6, compressionThresholdBytes: 1024 },
    register(route) {
      routes.set(`${route.kind} ${route.path}`, route);
      return () => routes.delete(`${route.kind} ${route.path}`);
    },
  };
  const ctx = {
    webServer,
    webStartup: { port: 19387 },
    get(name) {
      if (name === 'connection') return connection;
      if (name === 'profileContext') {
        return { name: 'desktop', dir: join(HOME, 'profiles', 'desktop'), patchPath: PATCH, home: HOME };
      }
      return undefined;
    },
    on() {
      return () => {};
    },
  };
  const dispose = plugin.apply(ctx, {});
  return { ctx, connection, routes, calls, dispose };
}

function makeReq({ peer, host, method = 'GET', url = '/', headers = {}, body = null }) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: host === undefined ? { ...headers } : { host, ...headers },
    socket: { remoteAddress: peer, localAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, extra) {
      this.statusCode = code;
      Object.assign(this.headers, extra ?? {});
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload);
    },
  };
}
const json = (res) => JSON.parse(res.body);

async function setPassword(h, password) {
  const route = h.routes.get('exact /dsh-lan/configure');
  const res = makeRes();
  await route.handler(
    makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/configure', body: { password } }),
    res,
  );
  return res;
}

// ── addresses used by the matrix ───────────────────────────────────────────
const localV4 = (() => {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '10.0.0.5';
})();
const REMOTE = '203.0.113.7'; // TEST-NET-3: never a local address
const LOCAL_PEERS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', localV4];
const HOSTS = ['127.0.0.1:19387', 'localhost:19387', '[::1]:19387', 'desktop-o6uev9g:19387', `${localV4}:19387`, 'evil.example.com'];

// ── A. switch ON: the host machine is never gated ──────────────────────────
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  for (const peer of LOCAL_PEERS) {
    for (const host of HOSTS) {
      const rejection = h.connection.requestRejection(makeReq({ peer, host }));
      check(`A requestRejection open (peer=${peer} host=${host})`, rejection === undefined, `got ${JSON.stringify(rejection)}`);
      const res = makeRes();
      const allowed = h.connection.browserAuth.authorizeIndex(makeReq({ peer, host }), res);
      check(`A authorizeIndex open (peer=${peer} host=${host})`, allowed === true && res.statusCode === 0, `allowed=${allowed} status=${res.statusCode}`);
    }
    check(`A requestRejection open (peer=${peer} no host)`, h.connection.requestRejection(makeReq({ peer, host: undefined })) === undefined);
  }
}

// ── B. switch ON: a LAN device is gated, Host spoofing does not help ───────
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  for (const host of ['127.0.0.1:19387', '[::1]:19387', 'localhost:19387', `${localV4}:19387`, 'evil.example.com']) {
    check(`B rejection 403 (peer=${REMOTE} host=${host})`, h.connection.requestRejection(makeReq({ peer: REMOTE, host })) === 403);
    const res = makeRes();
    const allowed = h.connection.browserAuth.authorizeIndex(makeReq({ peer: REMOTE, host }), res);
    check(
      `B bare / → landing redirect (peer=${REMOTE} host=${host})`,
      allowed === false && res.statusCode === 302 && res.headers.location === '/dsh-lan/',
      `allowed=${allowed} status=${res.statusCode} location=${res.headers.location}`,
    );
  }
  // No password configured: the LAN is unusable, never unguarded — a made-up
  // key must not open it either.
  check('B no password → a bogus key is still refused', h.connection.requestRejection(makeReq({ peer: REMOTE, host: 'x:1', headers: { 'x-dsh-lan-key': 'k' } })) === 403);
  const res = makeRes();
  const cookieReq = makeReq({ peer: REMOTE, host: 'x:1', headers: { cookie: 'dsh-lan-key=k' } });
  const allowed = h.connection.browserAuth.authorizeIndex(cookieReq, res);
  check('B no password → a bogus cookie still gets the landing page', allowed === false && res.statusCode === 302);
}

// ── C. switch OFF: stock DSH behaviour (delegation, no gate) ───────────────
{
  const h = makeHarness({ bindHost: '127.0.0.1' });
  const rejection = h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }));
  check('C switch off → official rejection delegates', rejection === OFFICIAL_REJECTION, `got ${JSON.stringify(rejection)}`);
  const res = makeRes();
  const allowed = h.connection.browserAuth.authorizeIndex(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }), res);
  check('C switch off → official authorize delegates', allowed === OFFICIAL_AUTHORIZE && res.statusCode === 0);
}

// ── D. status payload: `local` is the authority, host detail stays host-only ─
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  const status = h.routes.get('exact /dsh-lan/status');
  const localRes = makeRes();
  await status.handler(makeReq({ peer: '127.0.0.1', host: '[::1]:19387' }), localRes);
  const localBody = json(localRes);
  check('D status local=true for host machine behind [::1]', localBody.local === true && localBody.loopback === true);
  check('D host detail present locally', typeof localBody.patchFile === 'string' && typeof localBody.profile === 'string');

  const remoteRes = makeRes();
  await status.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }), remoteRes);
  const remoteBody = json(remoteRes);
  check('D status local=false for a LAN device', remoteBody.local === false);
  check('D host detail withheld from a LAN device', remoteBody.patchFile === undefined && remoteBody.profile === undefined);
  check('D LAN device still learns passwordSet/warning', remoteBody.passwordSet === false && remoteBody.warning === 'no-password');
}

// ── E. configure: host machine only, whatever its Host header ──────────────
{
  const h = makeHarness({ bindHost: '127.0.0.1' });
  const configure = h.routes.get('exact /dsh-lan/configure');
  const remoteRes = makeRes();
  await configure.handler(makeReq({ peer: REMOTE, host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/configure', body: { enabled: true } }), remoteRes);
  check('E remote configure refused even with a loopback Host', remoteRes.statusCode === 403, `status=${remoteRes.statusCode}`);
  check('E refused configure did not write the patch', !existsSync(PATCH));

  const localRes = makeRes();
  await configure.handler(makeReq({ peer: '127.0.0.1', host: '[::1]:19387', method: 'POST', url: '/dsh-lan/configure', body: { enabled: true } }), localRes);
  check('E host configure accepted behind [::1]', localRes.statusCode === 200, `status=${localRes.statusCode} body=${localRes.body.slice(0, 120)}`);
  const written = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : '';
  check('E patch carries the managed LAN block', written.includes('dsh-lan-tool LAN block') && written.includes("host: '0.0.0.0'"));
}

// ── F. password + LAN gate end to end ──────────────────────────────────────
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  await setPassword(h, 'hunter2');
  const unlock = h.routes.get('exact /dsh-lan/unlock');
  const good = makeRes();
  await unlock.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', method: 'POST', url: '/dsh-lan/unlock', body: { password: 'hunter2' } }), good);
  check('F LAN unlock with the right password succeeds', good.statusCode === 200 && json(good).ok === true, `status=${good.statusCode}`);
  const bad = makeRes();
  await unlock.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', method: 'POST', url: '/dsh-lan/unlock', body: { password: 'nope' } }), bad);
  check('F LAN unlock with a wrong password reports ok:false', bad.statusCode === 200 && json(bad).ok === false, `status=${bad.statusCode} body=${bad.body}`);
  check('F correct key opens the fence', h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', headers: { 'x-dsh-lan-key': 'hunter2' } })) === undefined);
  check('F wrong key keeps the fence shut', h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', headers: { 'x-dsh-lan-key': 'nope' } })) === 403);
  const cookieRes = makeRes();
  const cookieAllowed = h.connection.browserAuth.authorizeIndex(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', headers: { cookie: 'dsh-lan-key=hunter2' } }), cookieRes);
  check('F correct cookie delegates to DSH', cookieAllowed === OFFICIAL_AUTHORIZE, `got ${cookieAllowed}`);
  check('F host machine ignores the password entirely', h.connection.requestRejection(makeReq({ peer: '127.0.0.1', host: 'evil.example.com' })) === undefined);
}

// ── G. landing page + /lanapi gate ─────────────────────────────────────────
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  const landing = h.routes.get('exact /dsh-lan/');
  const res = makeRes();
  await landing.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }), res);
  check('G landing page served to a LAN device', res.statusCode === 200 && res.body.includes('DSH 远程访问'));
  check('G landing page asks the server whether the visitor is the host', res.body.includes('/dsh-lan/status') && res.body.includes('passwordSet'));

  const proxy = h.routes.get('prefix /lanapi');
  const denied = makeRes();
  await proxy.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', method: 'POST', url: '/lanapi/x', body: {} }), denied);
  check('G /lanapi refuses a LAN device without a key', denied.statusCode === 403, `status=${denied.statusCode}`);
}

// ── H. client half: static shape of the gate decisions ─────────────────────
{
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('H no bare isLoopback() call site remains', !/isLoopback\(\)/.test(client));
  check('H the gate asks the server first', client.includes('if ((await detectLocalClient()) !== false) return;'));
  check('H mountGate needs an explicit remote verdict', client.includes('if (!shouldGate() || gateRoot !== null) return;'));
  check('H every 403 path uses the evidence-only helper', !client.includes('if (!clientIsLocal()) mountGate();') && (client.match(/if \(shouldGate\(\)\) mountGate\(\);/g) || []).length === 3);
  check('H a wrong gate self-heals', client.includes('if (localClient === true) removeGate();'));
  check('H card uses the server flag', client.includes('data.local === true'));
  check('H posture uses the server flag', client.includes('markNonLocalPosture(await detectLocalClient())'));
  // The two halves must agree on the version they report, or the handshake lies.
  check('H server PLUGIN_VERSION matches package.json', server.includes(`const PLUGIN_VERSION = "${pkg.version}";`));
  check('H client PLUGIN_VERSION matches package.json', client.includes(`const PLUGIN_VERSION = "${pkg.version}";`));
  check('H the client announces its version to the server', client.includes('"x-dsh-lan-client": PLUGIN_VERSION'));
  check('H the server reports a mismatch once', server.includes('WARNING: browser half is'));
}

// ── I. client half: the gate decision runs on real source ──────────────────
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const start = src.indexOf('const PLUGIN_VERSION');
  const stop = src.indexOf('function storedKey()');
  const slice = src.slice(start, stop);
  const scope = (hostname, fetchImpl) => {
    const gates = { removed: 0 };
    const api = new Function(
      'window',
      'removeGate',
      `${slice}\nreturn { isLoopbackHostname, detectLocalClient, clientIsLocal, shouldGate, versionMismatchLine, decided: () => localClient };`,
    )({ location: { hostname }, fetch: fetchImpl }, () => { gates.removed += 1; });
    return { ...api, gates };
  };
  const statusOk = (payload) => async () => ({ ok: true, json: async () => payload });
  const boom = async () => {
    throw new Error('offline');
  };

  const ipv6 = scope('[::1]', statusOk({ local: true }));
  check('I [::1] page is local without asking the server', ipv6.clientIsLocal() === true);
  check('I [::1] page never gates', (await ipv6.detectLocalClient()) === true);

  const hint = scope('[::1]', boom);
  check('I the hostname hint accepts bracketed IPv6', hint.isLoopbackHostname() === true);
  check('I v4-mapped and 0.0.0.0 count as hints', scope('::ffff:127.0.0.1', boom).isLoopbackHostname() === true && scope('0.0.0.0', boom).isLoopbackHostname() === true);
  check('I a LAN address is not a hint', scope('192.168.1.10', boom).isLoopbackHostname() === false);
  check('I a machine name is not a hint', scope('desktop-o6uev9g', boom).isLoopbackHostname() === false);

  const hostBehindName = scope('desktop-o6uev9g', statusOk({ local: true }));
  check('I unknown hostname does not gate when the server says host', hostBehindName.clientIsLocal() === false && hostBehindName.shouldGate() === false);
  check('I server verdict overrides the hostname hint', (await hostBehindName.detectLocalClient()) === true);
  check('I a wrongly decided gate is removed again', hostBehindName.gates.removed === 1);

  const lan = scope('192.168.1.50', statusOk({ local: false }));
  check('I a LAN device still gates', (await lan.detectLocalClient()) === false && lan.shouldGate() === true);
  check('I a LAN device keeps its gate', lan.gates.removed === 0);

  // The 1.4.1 regression: a node half older than 1.4.1 answers without `local`.
  // The client must NOT fall back to guessing — that covered the host's GUI.
  const staleServer = scope('desktop-o6uev9g', statusOk({ loopback: false, version: '1.4.0' }));
  check('I a stale node half never gates on the hostname hint', (await staleServer.detectLocalClient()) === null && staleServer.shouldGate() === false);
  check('I a stale node half is named in the UI', String(staleServer.versionMismatchLine()).includes('1.4.0'));
  const staleLoopbackHost = scope('desktop-o6uev9g', statusOk({ loopback: true, version: '1.4.0' }));
  check('I an old Host-based loopback answer bridges to local', (await staleLoopbackHost.detectLocalClient()) === true);
  const emptyAnswer = scope('desktop-o6uev9g', statusOk({}));
  check('I an answer without any locality field never gates', (await emptyAnswer.detectLocalClient()) === null && emptyAnswer.shouldGate() === false);

  const offline = scope('192.168.1.50', boom);
  check('I status unreachable → unknown, never a gate', (await offline.detectLocalClient()) === null && offline.shouldGate() === false);
  check('I an unreachable probe is not cached (a later call retries)', offline.decided() === null);

  const offlineLoopback = scope('127.0.0.1', boom);
  check('I status unreachable never gates a loopback page', (await offlineLoopback.detectLocalClient()) === true);
}

// ── J. node half: version + request-host diagnosis in the status payload ───
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const h = makeHarness({ bindHost: '0.0.0.0' });
  h.connection.requestRejection(makeReq({ peer: '127.0.0.1', host: '[::1]:19387' }));
  h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }));
  const status = h.routes.get('exact /dsh-lan/status');

  const localRes = makeRes();
  await status.handler(makeReq({ peer: '127.0.0.1', host: '[::1]:19387' }), localRes);
  const localBody = json(localRes);
  check('J status carries the node-half version', localBody.version === pkg.version, `got ${localBody.version}`);
  // The ledger is module-global and capped (first dozen distinct pairs), so this
  // asserts its shape — which names/peers were judged, and how — not a count.
  check('J host sees which names/peers were judged', Array.isArray(localBody.seenHosts) && localBody.seenHosts.length > 0 && localBody.seenHosts.every((e) => typeof e.request === 'string' && typeof e.local === 'boolean' && typeof e.count === 'number'), JSON.stringify(localBody.seenHosts));

  const remoteRes = makeRes();
  await status.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }), remoteRes);
  const remoteBody = json(remoteRes);
  check('J LAN device gets the version but not the host diagnosis', remoteBody.version === pkg.version && remoteBody.seenHosts === undefined);
}

console.log(`PASS ${ok.length} / ${ok.length + fails.length}`);
for (const f of fails) console.log('  FAIL: ' + f);
rmSync(HOME, { recursive: true, force: true });
process.exit(fails.length === 0 ? 0 : 1);
