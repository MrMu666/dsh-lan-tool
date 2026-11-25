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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stampProxyHeaders } from '../lib/lan-proxy.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-lan-test-'));
process.env.DSH_HOME = HOME;
const PATCH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml');
/** The one DSH release this plugin version pins; bump together with package.json. */
const SUPPORTED_DSH = '0.2.3-alpha.2';

// The firewall must never be touched for real: stub node:child_process. The
// stub is scriptable, so the firewall verdicts below can be driven through the
// real /dsh-lan/status route (netsh "rule exists" + a PowerShell rule dump).
const CHILD_PROCESS_STUB = `
export const spawnCalls = [];
export const stubState = { netshRuleExists: true, powershellJson: '' };
export function execFile(cmd, args, opts, cb) {
  spawnCalls.push({ cmd, args });
  const callback = typeof opts === 'function' ? opts : cb;
  const out = cmd === 'powershell.exe' ? stubState.powershellJson : '';
  if (typeof callback === 'function') process.nextTick(() => callback(null, out, ''));
  return { on() {}, once() {}, kill() {} };
}
export function spawnSync(cmd, args) {
  spawnCalls.push({ cmd, args, sync: true });
  const text = (args || []).join(' ');
  const showRule = cmd === 'netsh' && text.includes('show') && text.includes('rule');
  const status = showRule && !stubState.netshRuleExists ? 1 : 0;
  return { status, stdout: '', stderr: '', pid: 1 };
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

const childProcessStub = await import('node:child_process');
const plugin = await import('../lib/index.js');

// ── harness ────────────────────────────────────────────────────────────────
const fails = [];
const ok = [];
const check = (label, condition, detail = '') => {
  (condition ? ok : fails).push(label + (condition ? '' : ` — ${detail}`));
};

const OFFICIAL_REJECTION = { official: 'rejection' };
const OFFICIAL_AUTHORIZE = 'official-authorize';
const OFFICIAL_TRUSTED = 'official-trusted';
const OFFICIAL_ADMIT = { official: 'admit' };

function makeHarness({ bindHost = '0.0.0.0', port = 19387, trustedAnswer = OFFICIAL_TRUSTED } = {}) {
  const routes = new Map();
  const calls = { trusted: 0, authenticate: 0, fetchPeers: [] };
  const browserPeer = { id: 'browser-peer', principal: { kind: 'owner' } };
  // 0.2.3-alpha.1: one admission path —
  //   route auth → webserver/authorize → connection.isTrustedRequest (fence)
  //     → connection.authentication.authenticate (credentials → Peer)
  // The fence patches exactly those two public instance methods.
  const authentication = {
    authenticate() {
      calls.authenticate += 1;
      return OFFICIAL_ADMIT;
    },
  };
  const connection = {
    browserPeer,
    authentication,
    isTrustedRequest(request) {
      calls.trusted += 1;
      return typeof trustedAnswer === 'function' ? trustedAnswer(request) : trustedAnswer;
    },
    admit() {
      return OFFICIAL_ADMIT;
    },
    // The /lanapi re-entry dispatches through the shared `/api` channel, whose
    // `fetch(request, peer)` reads `peer.signal` / `peer.principal`. Omitting the
    // peer made every privileged call routed there fail (v1.5.7).
    createSharedFetchHandler(channel) {
      return {
        async fetch(request, peer) {
          calls.fetchPeers.push({ channel, peer, url: request.url });
          return new Response(JSON.stringify({ ok: true, via: 'shared-fetch' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      };
    },
  };
  const webServer = {
    host: bindHost,
    port,
    config: { host: bindHost, port, compression: 'gzip', compressionLevel: 6, compressionThresholdBytes: 1024 },
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
  return { ctx, connection, browserPeer, routes, calls, dispose };
}

function makeReq({ peer, host, method = 'GET', url = '/', headers = {}, body = null, proxied = false }) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  const all = host === undefined ? { ...headers } : { host, ...headers };
  // A request this plugin's own proxy forwarded carries the per-process stamp;
  // the fence trusts exactly that (a LAN browser can never set it).
  if (proxied) stampProxyHeaders(all);
  return {
    method,
    url,
    headers: all,
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

// ── A0. firewall verdicts: never claim "blocked" when the OS admits the port ─
// Runs BEFORE any remote request, so the "a LAN device got through" evidence
// (section K) cannot mask these paths.
{
  const statusFor = async (port) => {
    const h = makeHarness({ bindHost: '0.0.0.0', port });
    const res = makeRes();
    await h.routes.get('exact /dsh-lan/status').handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:1' }), res);
    return json(res);
  };
  const stub = childProcessStub.stubState;

  stub.netshRuleExists = true;
  stub.powershellJson = '';
  let body = await statusFor(19401);
  check('A0 our own rule → open (plugin)', body.firewallOk === true && body.firewallSource === 'plugin' && body.firewallManaged === true, `${body.firewallOk}/${body.firewallSource}`);

  // The Windows "allow this app" dialog creates a PROGRAM-scoped rule with
  // LocalPort=Any — invisible to the named-rule check, which is the whole bug.
  stub.netshRuleExists = false;
  stub.powershellJson = JSON.stringify({ name: 'DeepSeek Harness', port: 'Any', protocol: 'Any', program: process.execPath });
  body = await statusFor(19402);
  check('A0 OS rule for THIS program → open (system)', body.firewallOk === true && body.firewallSource === 'system' && body.firewallManaged === false, `${body.firewallOk}/${body.firewallSource}/${body.firewallNote}`);

  // …but an Any-port rule belonging to some other program proves nothing.
  stub.powershellJson = JSON.stringify({ name: 'Wi-Fi Direct', port: 'Any', protocol: 'Any', program: 'C:\\Windows\\System32\\svchost.exe' });
  body = await statusFor(19403);
  check('A0 another program\'s Any-port rule → still blocked', body.firewallOk === false && body.firewallSource === 'plugin', `${body.firewallOk}/${body.firewallSource}`);

  stub.powershellJson = '';
  body = await statusFor(19404);
  check('A0 nothing found → blocked (needs admin)', body.firewallOk === false && body.firewallManaged === true, `${body.firewallOk}/${body.firewallManaged}`);

  stub.powershellJson = JSON.stringify([{ name: 'port rule', port: '19405, 443', protocol: 'TCP', program: 'Any' }]);
  body = await statusFor(19405);
  check('A0 port list that covers the port → open (system)', body.firewallOk === true && body.firewallSource === 'system', `${body.firewallOk}/${body.firewallSource}`);

  stub.powershellJson = JSON.stringify([{ name: 'port rule', port: '19406, 443', protocol: 'TCP', program: 'Any' }]);
  body = await statusFor(19407);
  check('A0 port list that does not cover the port → blocked', body.firewallOk === false, `${body.firewallOk}`);

  stub.powershellJson = JSON.stringify([{ name: 'udp rule', port: '19408', protocol: 'UDP', program: 'Any' }]);
  body = await statusFor(19408);
  check('A0 UDP-only rule does not open a TCP port', body.firewallOk === false, `${body.firewallOk}`);

  stub.powershellJson = JSON.stringify([{ name: 'range rule', port: '19400-19500', protocol: 'TCP', program: 'Any' }]);
  body = await statusFor(19409);
  check('A0 port range covering the port → open (system)', body.firewallOk === true && body.firewallSource === 'system', `${body.firewallOk}/${body.firewallSource}`);

  // The rule name is shown verbatim in the card. When PowerShell's stdout was
  // decoded with the wrong codepage the name arrives full of U+FFFD (reported as
  // "防火墙已放行（系统规则） (������ѧУ�˻�)"): fall back to a neutral label.
  stub.powershellJson = JSON.stringify({ name: '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD', port: 'Any', protocol: 'TCP', program: process.execPath });
  body = await statusFor(19410);
  check('A0 undecodable rule name falls back to a neutral label', body.firewallOk === true && body.firewallNote === 'Windows rule', `${body.firewallOk}/${JSON.stringify(body.firewallNote)}`);

  stub.powershellJson = JSON.stringify({ name: '远程协助（入站）', port: 'Any', protocol: 'TCP', program: process.execPath });
  body = await statusFor(19411);
  check('A0 a legible rule name is kept as-is', body.firewallNote === '远程协助（入站）', JSON.stringify(body.firewallNote));

  stub.powershellJson = JSON.stringify({ name: 'x'.repeat(120), port: 'Any', protocol: 'TCP', program: process.execPath });
  body = await statusFor(19412);
  check('A0 a very long rule name is truncated', body.firewallNote.length <= 60 && body.firewallNote.endsWith('…'), `${body.firewallNote.length}`);

  stub.netshRuleExists = true;
  stub.powershellJson = '';
}

// ── A. switch ON: the host machine is never gated ──────────────────────────
// The fence only ever ADDS trust for a request this plugin's proxy stamped. Every
// other request keeps DSH's own answer verbatim, so the host's browser (and any
// real DSH session) is decided exactly as stock DSH decides it — no password,
// no hostname allow-list.
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  for (const peer of LOCAL_PEERS) {
    for (const host of HOSTS) {
      const trusted = h.connection.isTrustedRequest(makeReq({ peer, host }));
      check(`A the fence delegates for the host machine (peer=${peer} host=${host})`, trusted === OFFICIAL_TRUSTED, `got ${JSON.stringify(trusted)}`);
      const admission = h.connection.authentication.authenticate(makeReq({ peer, host }));
      check(`A credentials stay DSH's decision for the host (peer=${peer} host=${host})`, admission === OFFICIAL_ADMIT, `got ${JSON.stringify(admission)}`);
    }
  }
}

// ── B. switch ON: only the proxy's own requests are trusted ────────────────
// The stamp is random per process and stripped from client-supplied copies, so a
// LAN browser can neither produce it nor fake the peer address. A wire request
// that merely claims `Host: 127.0.0.1` is still decided by DSH.
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  for (const host of ['127.0.0.1:19387', '[::1]:19387', 'localhost:19387', `${localV4}:19387`, 'evil.example.com']) {
    const trusted = h.connection.isTrustedRequest(makeReq({ peer: REMOTE, host, proxied: true }));
    check(`B a forwarded request passes the fence (host=${host})`, trusted === true, `got ${JSON.stringify(trusted)}`);
    const admission = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host, proxied: true }));
    check(`B without a password DSH still decides (host=${host})`, admission === OFFICIAL_ADMIT, `got ${JSON.stringify(admission)}`);
  }
  for (const peer of [REMOTE, ...LOCAL_PEERS]) {
    const trusted = h.connection.isTrustedRequest(makeReq({ peer, host: '192.168.0.9:19387' }));
    check(`B an unstamped request keeps DSH's fence (peer=${peer})`, trusted === OFFICIAL_TRUSTED, `got ${JSON.stringify(trusted)}`);
  }
  // No password configured: the LAN is unusable, never unguarded.
  const bogus = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { 'x-dsh-lan-key': 'k' } }));
  check('B no password → a bogus key authenticates nobody', bogus === OFFICIAL_ADMIT, JSON.stringify(bogus));
  const bogusCookie = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { cookie: 'dsh-lan-key=k' } }));
  check('B no password → a bogus cookie authenticates nobody', bogusCookie === OFFICIAL_ADMIT, JSON.stringify(bogusCookie));
}

// ── C. switch OFF: stock DSH behaviour (nothing patched at all) ────────────
{
  const h = makeHarness({ bindHost: '127.0.0.1' });
  check(
    'C switch off → neither method is patched',
    h.connection.isTrustedRequest.__dshLanPatched !== true && h.connection.authentication.authenticate.__dshLanPatched !== true,
  );
  const stamped = makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { 'x-dsh-lan-key': 'whatever' } });
  check('C switch off → the official fence answers', h.connection.isTrustedRequest(stamped) === OFFICIAL_TRUSTED);
  check('C switch off → the official credentials answer', h.connection.authentication.authenticate(stamped) === OFFICIAL_ADMIT);
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

  // v1.5.0 — the toggle MUST NOT write a `webserver` override any more. On DSH
  // 0.2.1-rc.2 the schema rejects wildcard bind addresses and `webserver` is a
  // required row, so a leftover `host: '0.0.0.0'` block does not merely expose
  // the port: the app refuses to start (measured 2026-10-17). The desire lives
  // in the state file; the LAN door is the plugin's own proxy.
  const written = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : '';
  check('E toggle writes no webserver override at all', !written.includes('id: webserver') && !written.includes('0.0.0.0') && !written.includes('LAN block'), JSON.stringify(written).slice(0, 140));
  const stateFile = join(HOME, 'dsh-lan.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('E toggle records the desire in the state file', state.lanEnabled === true, JSON.stringify(state).slice(0, 120));
  check('E status reports the desired state', JSON.parse(localRes.body).desiredEnabled === true, localRes.body.slice(0, 120));

  // A block an older version left behind is stripped on activation: this plugin
  // cannot run at all while the webserver row is failing, so a bricked profile
  // needs exactly this (plus the README's manual step for the already-bricked
  // case, where no plugin code can run).
  writeFileSync(stateFile, JSON.stringify({ ...state, lanEnabled: false }));
  mkdirSync(dirname(PATCH), { recursive: true });
  writeFileSync(PATCH, "# keep me\n- id: ui-chat\n  config: {}\n\n# --- dsh-lan-tool LAN block (managed - do not edit) ---\n- id: webserver\n  config:\n    host: '0.0.0.0'\n    port: 1\n# --- end dsh-lan-tool LAN block ---\n");
  makeHarness({ bindHost: '127.0.0.1' });
  const after = readFileSync(PATCH, 'utf8');
  check('E a leftover wildcard block is stripped on activation', !after.includes('LAN block') && !after.includes('0.0.0.0') && after.includes('ui-chat'), JSON.stringify(after).slice(0, 160));
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
  const byHeader = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { 'x-dsh-lan-key': 'hunter2' } }));
  check('F the password header authenticates the LAN client', byHeader !== OFFICIAL_ADMIT && byHeader.peer === h.browserPeer, JSON.stringify(byHeader));
  const wrongKey = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { 'x-dsh-lan-key': 'nope' } }));
  check('F a wrong password authenticates nobody', wrongKey === OFFICIAL_ADMIT, JSON.stringify(wrongKey));
  const byCookie = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { cookie: 'dsh-lan-key=hunter2' } }));
  check('F the password cookie authenticates the LAN client', byCookie !== OFFICIAL_ADMIT && byCookie.peer === h.browserPeer, JSON.stringify(byCookie));
  // A password that never traversed the proxy buys nothing: the door trusts its
  // own per-process stamp, not a header any browser could set.
  const direct = h.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', headers: { 'x-dsh-lan-key': 'hunter2' } }));
  check('F an unstamped request cannot use the password', direct === OFFICIAL_ADMIT, JSON.stringify(direct));
  check('F the host machine needs no password at all', h.connection.isTrustedRequest(makeReq({ peer: '127.0.0.1', host: 'evil.example.com' })) === OFFICIAL_TRUSTED);

  // A deliberate direct bind (`dsh web --host <lan-ip>`, no proxy): DSH's own
  // fence accepts the listener's own authority, and the password replaces the
  // token there too — but only for the authority DSH itself trusted.
  const bound = makeHarness({
    bindHost: '192.168.0.9',
    trustedAnswer: (req) => String(req.headers.host ?? '').startsWith('192.168.0.9:'),
  });
  await setPassword(bound, 'hunter2');
  const hostBound = bound.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', headers: { 'x-dsh-lan-key': 'hunter2' } }));
  check('F a direct-bind deployment can use the password too', hostBound !== OFFICIAL_ADMIT && hostBound.peer === bound.browserPeer, JSON.stringify(hostBound));
  const forgedHost = bound.connection.authentication.authenticate(makeReq({ peer: REMOTE, host: 'evil.example.com', headers: { 'x-dsh-lan-key': 'hunter2' } }));
  check('F a forged Host cannot use the password even on a direct bind', forgedHost === OFFICIAL_ADMIT, JSON.stringify(forgedHost));
  bound.dispose();
}

// ── G. landing page + /lanapi gate ─────────────────────────────────────────
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  const landing = h.routes.get('exact /dsh-lan/');
  const res = makeRes();
  await landing.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }), res);
  check('G landing page served to a LAN device', res.statusCode === 200 && res.body.includes('DSH 远程访问'));
  check('G landing page asks the server whether the visitor is the host', res.body.includes('/dsh-lan/status') && res.body.includes('passwordSet'));
  check('G landing page never calls a mint endpoint', !res.body.includes('/dsh-lan/mint'));
  check('G the host shortcut keys on hostOnly, not on the peer-based local', res.body.includes('data.hostOnly === true'));

  const proxy = h.routes.get('prefix /lanapi');
  const denied = makeRes();
  await proxy.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', method: 'POST', url: '/lanapi/x', body: {} }), denied);
  check('G /lanapi refuses a LAN device without a key', denied.statusCode === 403, `status=${denied.statusCode}`);

  // v1.5.7 — the re-entry must hand the shared `/api` channel a real PEER. Its
  // dispatch reads `peer.signal`, so `fetch(request)` alone failed every
  // privileged call with `gateway/internal: Cannot read properties of undefined
  // (reading 'signal')` — a settings page that rendered as an error, which is
  // what a platform without host-only surfaces showed first.
  const reentry = makeRes();
  await proxy.handler(
    makeReq({
      peer: '127.0.0.1',
      host: '127.0.0.1:19387',
      method: 'POST',
      url: '/lanapi/pluginInventory/list',
      headers: { 'content-type': 'application/json' },
      body: { type: 'client-request', rpcId: 'r1', method: 'pluginInventory/list', payload: { args: {} } },
    }),
    reentry,
  );
  // The prefix route deliberately does not await the re-entry; wait for it.
  for (let i = 0; i < 200 && reentry.statusCode === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  check('G /lanapi re-enters the shared /api channel', reentry.statusCode === 200 && reentry.body.includes('shared-fetch'), `status=${reentry.statusCode} body=${reentry.body.slice(0, 80)}`);
  check(
    'G /lanapi passes the browser peer (without it every privileged call fails)',
    h.calls.fetchPeers.length === 1 && h.calls.fetchPeers[0].peer === h.browserPeer && h.calls.fetchPeers[0].channel === '/api',
    JSON.stringify(h.calls.fetchPeers.map((entry) => ({ channel: entry.channel, peer: entry.peer?.id }))),
  );
  check('G /lanapi rewrites the prefix back to /api', String(h.calls.fetchPeers[0]?.url ?? '').endsWith('/api/pluginInventory/list'), String(h.calls.fetchPeers[0]?.url));
}

// ── H. client half: static shape of the gate decisions ─────────────────────
{
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const proxySource = readFileSync(new URL('../lib/lan-proxy.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('H no bare isLoopback() call site remains', !/isLoopback\(\)/.test(client));
  check('H the gate asks the server first', client.includes('if ((await detectLocalClient()) !== false) return;'));
  check('H mountGate needs an explicit remote verdict', client.includes('if (!shouldGate() || gateRoot !== null) return;'));
  check('H every 403 path uses the evidence-only helper', !client.includes('if (!clientIsLocal()) mountGate();') && (client.match(/if \(shouldGate\(\)\) mountGate\(\);/g) || []).length === 2);
  check('H a wrong gate self-heals', client.includes('if (localClient === true) removeGate();'));
  check('H card uses the server flag', client.includes('data.local === true'));
  check('H posture uses the server flag', client.includes('markNonLocalPosture(await detectLocalClient())'));
  // The two halves must agree on the version they report, or the handshake lies.
  check('H server PLUGIN_VERSION matches package.json', server.includes(`const PLUGIN_VERSION = "${pkg.version}";`));
  check('H client PLUGIN_VERSION matches package.json', client.includes(`const PLUGIN_VERSION = "${pkg.version}";`));
  check('H the client announces its version to the server', client.includes('"x-dsh-lan-client": PLUGIN_VERSION'));
  check('H the server reports a mismatch once', server.includes('WARNING: browser half is'));
  // 1.4.4 — mojibake, spurious keyboards, and the red "Failed to fetch" flash.
  check('H the firewall query forces UTF-8 output', server.includes('[Console]::OutputEncoding=[Text.Encoding]::UTF8'));
  check('H firewall rule names are sanitized before they reach the card', server.includes('sanitizeFirewallNote(system.name'));
  check('H the card treats a rebind refusal as expected, not as an error', client.includes('isTransientFetchError(message) && (inRebindWindow() || previous?.applying === true)'));
  check('H a toggle marks the rebind window and keeps polling', client.includes('if (typeof body?.enabled === "boolean") markRebindWindow();'));
  check('H the gate only auto-focuses away from touch devices', client.includes('const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;') && client.includes('if (!coarsePointer) input.focus();'));
  // 1.7.0 — the old portrait-phone adaptation (touch CSS, whale button, swipe /
  // long-press navigation, Enter-to-newline rewrite, focus guard) is gone: DSH
  // 0.2.2 ships its own narrow layout, so the plugin no longer patches it.
  check('H no mobile layout adaptation is injected', !client.includes('mobileAdapt') && !client.includes('dsh-lan-portrait') && !client.includes('dshLanWhale') && !client.includes('__dshLanAdapt'));
  check('H no touch-only keyboard/sidebar handlers remain', !client.includes('onKeydownCapture') && !client.includes('isComposerField') && !client.includes('swipeTouch') && !client.includes('longPress'));
  check('H the layout service left the inject lists', !client.includes('"layout"') && !(pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-layout'));
  // 1.4.6 — the "applying…" line must read as progress (green), not as the
  // muted status grey or the red error tone.
  check('H the applying line is rendered with the progress class', client.includes('className: c.pending, children: t("status.applying")'));
  check('H the progress class uses the official success token', /\.dshLan_pending\{color:var\(--dsw-alias-state-success-primary/.test(client));
  check('H the progress class is not the error class', !/\.dshLan_pending\{[^}]*state-error/.test(client));
  // 1.5.0 — the LAN door is the plugin's own proxy, gated by makeLanAdmit().
  // Locked here because the opt-in test/lan-proxy-e2e.mjs is what FOUND the
  // missing token carve-out (its last hop was refused on the LAN), and `npm
  // test` must catch that regression too.
  check('H the proxy is the only LAN door and takes the injected gate', server.includes('createLanProxy({') && server.includes('admit: makeLanAdmit(ctx)'));
  // 1.8.0 — the LAN door no longer forwards a launch token: DSH 0.2.3 intercepts
  // `GET /?token=` before routing, and this plugin's password is the credential.
  check(
    'H the LAN door strips a stale token instead of forwarding it',
    server.includes('function stripTokenFromRequest(req)') && server.includes('rewrite: stripTokenFromRequest'),
    'the rewrite hook is what keeps a stale bookmark from dead-ending on DSH 401 text'
  );
  check('H the LAN gate keeps the landing flow reachable', server.includes('if (url.pathname.startsWith("/dsh-lan/")) return true;'));
  // The proxy stamp is the one signal that survives both header shapes, which is
  // what makes it usable from `webserver/authorize` (a WHATWG headers object).
  check(
    'H the proxy stamp survives both header shapes',
    proxySource.includes('typeof headers.get === "function"') && server.includes('viaProxy(request)'),
    'WHATWG Headers handling missing'
  );
  check('H nothing writes a webserver override any more', !server.includes('`    host: ') && !server.includes('"- id: webserver"') && !server.includes('host: \'${ALL_INTERFACES}\''));
  // 0.2.3-alpha.1 — the whole admission path collapsed onto two public methods:
  // `isTrustedRequest` (Host/Origin fence) and `authentication.authenticate`
  // (credentials → Peer). `requestRejection` / `browserAuth` / `authorizeIndex`
  // no longer exist, and the fence must not try to call them.
  check('H the fence patches the trust funnel', server.includes('connection.isTrustedRequest = patchedIsTrusted') && server.includes('const patchedIsTrusted'));
  check('H the trust allowance needs a proxied request and an open door', server.includes('if (lanDoorOpen(ctx) && viaProxy(request)) return true;'));
  check('H the credential step hands over DSH\'s own browser Peer', server.includes('authentication.authenticate = patchedAuthenticate') && server.includes('return { peer: connection.browserPeer };'));
  check(
    'H the credential step needs the door and the password, then a trusted transport',
    server.includes('if (lanDoorOpen(ctx) && hasLanCredential(request)) {') && server.includes('let admitted = viaProxy(request);'),
  );
  check('H the credential override is installed and removed with the rest', server.includes('const origAuthenticate') && server.includes('wrap.authentication.authenticate = wrap.origAuthenticate'));
  check(
    'H the removed 0.2.2 connection API is not called any more',
    !server.includes('connection.requestRejection') && !server.includes('connection.browserAuth') && !server.includes('connection.authenticatedUrl'),
    'a leftover call site would throw inside DSH\'s request path'
  );
  // 1.5.6 — the card must open with a ONE-LINE RED safety notice (a user requirement,
  // so it gets asserted rather than left to chance): red via the official error token,
  // `nowrap` so it stays a single line, and rendered before the title row.
  check('H the safety notice is a single-line red rule', client.includes('.dshLan_warn{color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px;line-height:18px;white-space:nowrap}'));
  check('H the notice is the card\'s first line', /className: c\.row, children: \[[\s\S]{0,600}?className: c\.warn,[\s\S]{0,400}?className: c\.head/.test(client));
  check('H both locales carry the exact notice text', client.includes('"notice.trusted": "仅适用于在安全可信局域网中使用，请勿在其他网络环境开启"') && (client.match(/"notice\.trusted":/g) ?? []).length === 2);
  // 1.5.5 — through the proxy every LAN client has a loopback peer, so a peer-only
  // test let it change the password / flip the switch / read diagnostics. The proxy
  // stamps what it forwards, and host-only endpoints refuse a stamped request.
  check('H the proxy stamps forwarded requests', proxySource.includes('export const PROXY_HEADER') && proxySource.includes('headers[PROXY_HEADER] = PROXY_TOKEN') && proxySource.includes('if (lower === PROXY_HEADER) continue;'));
  check('H host-only means local AND unstamped', server.includes('function isHostOnlyRequest(req)') && server.includes('return isLocalRequest(req) && !viaProxy(req);'));
  check('H configure and diag use the host-only test', (server.match(/if \(!isHostOnlyRequest\(req\)\)/g) ?? []).length === 2);
  check('H the status payload reports hostOnly', server.includes('hostOnly,') && client.includes('const canConfigure = local && data?.hostOnly !== false;'));
  check('H the card gates its controls on canConfigure', (client.match(/canConfigure \?/g) ?? []).length >= 3);
  check('H the fence is installed for proxied traffic as well', server.includes('function lanDoorOpen(ctx)') && server.includes('return lanProxy !== null && lanProxy.listening();'));
  // 1.5.2 — the LAN port can be pinned, and the card has to offer it.
  check('H the proxy listens on a pinnable port', server.includes('listenPort: lanPortSetting') && server.includes('function lanPortSetting()'));
  check('H the firewall admits the port LAN devices use', server.includes('const port = lanListenPort(ctx);'));
  check('H configure accepts a pinned port', server.includes('Object.prototype.hasOwnProperty.call(body, "lanPort")'));
  check('H the card offers the port box', client.includes('configure({ lanPort: value })') && (client.match(/"port\.label":/g) ?? []).length === 2);
  // 1.5.2 — the "applying" line has to be reachable again: the toggle replies
  // BEFORE it awaits the bind (1.5.0/1.5.1 awaited it, so `applying` was already
  // false in the response and the green line 1.4.6 added never appeared), and the
  // card holds it for a moment so a millisecond-fast settle is still visible.
  check('H the toggle replies before the bind settles', server.includes('void lanProxy.refresh()') && !server.includes('const bound = await lanProxy.refresh();'));
  check('H the pending line has a minimum visible life', client.includes('pendingUntil.current = Date.now() + 1600') && client.includes('Date.now() < pendingUntil.current'));
  // v1.5.0 — the card must not call a loopback bind "the LAN bind" now that the
  // door is the proxy, and the "applying" line must not claim a socket rebind.
  check('H the card labels the loopback listener when proxied', client.includes('data.proxied === true ? t("status.bindLocal") : t("status.bind")'));
  check('H the proxy explanation is localized', (client.match(/"status\.proxy":/g) ?? []).length === 2);
  check('H the applying line no longer claims a socket rebind', !client.includes('正在重新绑定监听') && !client.includes('re-binding the listening socket'));
  // 1.5.7 — a fresh toggle must never read as "blocked": the rule is created
  // BEFORE the response describes it, an unproven verdict is re-checked within
  // seconds, and the card paints "checking" in the progress colour.
  check(
    'H the toggle creates the firewall rule before answering',
    server.indexOf('ensureFirewallRule(firewallPort)') !== -1
      && server.indexOf('ensureFirewallRule(firewallPort)') < server.lastIndexOf('sendJson(res, 200, await buildStatus(ctx, config, req))'),
    `rule@${server.indexOf('ensureFirewallRule(firewallPort)')} reply@${server.lastIndexOf('sendJson(res, 200, await buildStatus(ctx, config, req))')}`,
  );
  check('H an unproven firewall verdict is reported as checking', server.includes('const firewallChecking = enabled && firewall.ok !== true') && server.includes('firewallChecking,'));
  check('H a refusal is re-checked within seconds, not ten of them', server.includes('const FIREWALL_RECHECK_MIN_MS = 2 * 1000;'));
  check('H the settle window exists for the first seconds of a toggle', server.includes('const FIREWALL_SETTLE_MS = 15 * 1000;'));
  check('H a cold status query never waits long for the OS', server.includes('const FIREWALL_STATUS_WAIT_MS = 1200;') && server.includes('Promise.race(['));
  check('H the card renders "checking" with the progress class', client.includes('data.firewallChecking === true') && client.includes('className: c.pending, children: t("firewall.checking")'));
  check('H the checking line is not rendered as a failure', !/firewallChecking[\s\S]{0,400}className: c\.err/.test(client));
  check('H both locales carry the checking line', (client.match(/"firewall\.checking":/g) ?? []).length === 2);
  // 1.5.7 — the desktop shell is not an HTTP origin (`dsh-app://app/`): its
  // `__DSH_TRANSPORT__.ownsHost` is the shell's own statement that this page IS
  // the Host, so the host-only surfaces must never wait for a round trip.
  check('H the client recognises the shell-owned Host', client.includes('globalThis.__DSH_TRANSPORT__?.ownsHost === true') && client.includes('function shellOwnsHost()'));
  check('H the shell-owned page is local immediately', client.includes('let localClient = isLoopbackHostname() || shellOwnsHost() ? true : null;'));
  check('H local-ness always honours the shell-owned Host', client.includes('return localClient === true || shellOwnsHost() || (localClient === null && isLoopbackHostname());'));
  // 1.5.7 — the /lanapi re-entry must pass the peer the shared channel needs.
  check('H the /lanapi re-entry passes a peer', server.includes('const peer = connection.browserPeer;') && server.includes('.fetch(request, peer)'));
  // 1.5.8 — the shadow folder dialog lists through this plugin's own routes:
  // with the loopback bind DSH requires, the composed picker is NATIVE and
  // `directoryPicker/list` does not exist at all.
  check('H the dialog has its own listing routes', server.includes('path: "/dsh-lan/fs/list"') && server.includes('path: "/dsh-lan/fs/mkdir"'));
  check('H the filesystem routes sit behind the LAN door', (server.match(/if \(!lanFileAccess\(ctx, req, peer\)\)/g) ?? []).length === 2);
  check('H the door accepts host / password / DSH-accepted Peer', server.includes('function lanFileAccess(ctx, req, peer)') && server.includes('if (isHostOnlyRequest(req)) return true;') && server.includes('return peer !== undefined;'));
  // Every password surface must be reachable WITHOUT a DSH session (0.2.3 requires
  // a live Peer on every `required` route), and `/lanapi` must stay required.
  check('H the password surfaces are anonymous routes', (server.match(/auth: "anonymous"/g) ?? []).length === 8, String((server.match(/auth: "anonymous"/g) ?? []).length));
  // A browser fetches `<link rel="manifest">` and its home-screen icons with
  // credentials OMITTED, so the door must treat them as public (DSH does).
  check(
    'H the credential-less web-app assets are public at the door',
    server.includes('PUBLIC_WEB_ASSET') && server.includes('manifest\\.webmanifest') && server.includes('PUBLIC_WEB_ASSET.test(url.pathname)'),
  );
  check('H listing keeps the official listing shape', server.includes('ancestryCrumbs(target)') && server.includes('hidden: dirent.name.startsWith(".")'));
  check('H the client calls the plugin routes first', client.includes('lanFsCall("/dsh-lan/fs/list" + query') && client.includes('lanFsCall("/dsh-lan/fs/mkdir"'));
  check('H an older node half still works through the official service', client.includes('!contentType.includes("application/json")') && client.includes('return browse.listDirectory(path, signal);'));
  // 1.5.9 — the composition watchdog records the exact moment this plugin loses the
  // webserver service, so a recurrence is diagnosable instead of guessed from 400s.
  check('H the composition watchdog exists', server.includes('const watchdog = setInterval') && server.includes('the webServer service disappeared'));
  check('H diag reports the composition state', server.includes('composition: webServerPort(ctx) > 0 ? "ok" : "dead"'));
  check('H the watchdog is cleared on dispose', server.includes('clearInterval(watchdog)'));
  // 1.7.2 — the plugin targets exactly one DSH release (0.2.2-rc.3). The
  // manifest gate is `engines.dsh` (dsh-app-boot checks engines.dsh and, when
  // present, ignores peers entirely), so the pin has to live there.
  check('H the manifest pins exactly the supported DSH release', pkg.engines?.dsh === SUPPORTED_DSH, JSON.stringify(pkg.engines));
  check('H the compatibility metadata names only that release', pkg.dsh?.compatibility?.dsh === SUPPORTED_DSH && Object.keys(pkg.dsh.compatibility.dshReleases ?? {}).join(',') === SUPPORTED_DSH, JSON.stringify(pkg.dsh?.compatibility));
  // 1.6.0 — rc.3 removed `connection.api`/`postJson`, so the per-service wrapper
  // is dead code; every remote call goes through window.fetch (the fetch reroute).
  check('H the dead connection.api wrapper is gone', !client.includes('function wrapApi') && !client.includes('api.postJson') && !client.includes('__dshLanWrapped'));
  check('H the fetch reroute is the only transport hook', client.includes('function installLanFetchReroute') && client.includes('window.fetch = function (input, init)'));
  // 1.6.0 — unknown `/dsh-lan/fs/*` paths answer JSON 404 instead of DSH's SPA
  // fallback (frontend-static claims the fallback seat since 0.2.1-rc.3).
  check('H the fs namespace has its own JSON 404', server.includes('path: "/dsh-lan/fs"') && server.includes('unknown dsh-lan fs endpoint'));
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

  // v1.5.7 — the desktop shell loads `dsh-app://app/` (hostname "app") and forwards
  // every call to the Host it owns. `ownsHost` is that ownership statement: the page
  // is the host machine, so it must be local from the first millisecond — no probe,
  // no gate, no remote posture, no privileged-call reroute.
  let shellScope;
  try {
    globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
    shellScope = scope('app', boom);
    check('I a shell-owned Host page is local without asking the server', shellScope.clientIsLocal() === true);
    check('I a shell-owned Host page never gates', shellScope.shouldGate() === false);
    check('I a shell-owned Host page resolves local even with the probe offline', (await shellScope.detectLocalClient()) === true);
    check('I the shell hint is not a hostname guess', shellScope.isLoopbackHostname() === false && shellScope.clientIsLocal() === true);
  } finally {
    delete globalThis.__DSH_TRANSPORT__;
  }
  // …and it is not a blanket "everything is local": a page the shell does NOT own
  // (a plain browser at a LAN address) keeps the old, evidence-based decision.
  const lanAfterShell = scope('192.168.1.50', statusOk({ local: false }));
  check('I a non-shell LAN page still gates', (await lanAfterShell.detectLocalClient()) === false && lanAfterShell.shouldGate() === true);
  const appWithoutShell = scope('app', statusOk({ local: false }));
  check('I an app-origin page without ownsHost is decided by the server', (await appWithoutShell.detectLocalClient()) === false);
}

// ── J. node half: version + request-host diagnosis in the status payload ───
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const h = makeHarness({ bindHost: '0.0.0.0' });
  h.connection.isTrustedRequest(makeReq({ peer: '127.0.0.1', host: '[::1]:19387' }));
  h.connection.isTrustedRequest(makeReq({ peer: REMOTE, host: '192.168.0.9:19387' }));
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

// ── K. firewall: a LAN device that got through proves the port is open ─────
{
  const stub = childProcessStub.stubState;
  stub.netshRuleExists = false;
  stub.powershellJson = '';
  const h = makeHarness({ bindHost: '0.0.0.0', port: 19420 });
  // A LAN peer reaches the server while LAN access is on …
  h.connection.isTrustedRequest(makeReq({ peer: REMOTE, host: '192.168.0.9:19420', headers: { 'x-dsh-lan-key': 'whatever' } }));
  const res = makeRes();
  await h.routes.get('exact /dsh-lan/status').handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:1' }), res);
  const body = json(res);
  check('K admitted LAN traffic → open (observed)', body.firewallOk === true && body.firewallSource === 'observed', `${body.firewallOk}/${body.firewallSource}`);
  stub.netshRuleExists = true;
}

// ── K2. toggling ON: "not verified yet" is not "blocked" ───────────────────
// Reported: "切换开关后，防火墙状态要过几秒才刷新，刚切换完显示的是未放行". The
// verdict was cached as a refusal and re-checked 10s later; the card painted a
// failure in a window where the truth was simply unknown.
{
  const stub = childProcessStub.stubState;
  stub.netshRuleExists = false;
  stub.powershellJson = '';
  const stateFile = join(HOME, 'dsh-lan.json');
  writeFileSync(stateFile, JSON.stringify({ lanEnabled: false }));
  const h = makeHarness({ bindHost: '0.0.0.0' });
  const res = makeRes();
  await h.routes.get('exact /dsh-lan/configure').handler(
    makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/configure', body: { enabled: true } }),
    res,
  );
  const body = json(res);
  check('K2 a fresh toggle reports the firewall verdict as still checking', body.firewallChecking === true, JSON.stringify({ ok: body.firewallOk, checking: body.firewallChecking, source: body.firewallSource }));
  check('K2 …while firewallOk stays truthful (not claimed open)', body.firewallOk === false, String(body.firewallOk));
  check('K2 …and the toggle itself is reported as desired', body.desiredEnabled === true, String(body.desiredEnabled));

  // Our own rule existing is the fast path: the response is a real verdict at
  // once, never a "checking" placeholder.
  stub.netshRuleExists = true;
  const h2 = makeHarness({ bindHost: '0.0.0.0' });
  const res2 = makeRes();
  await h2.routes.get('exact /dsh-lan/configure').handler(
    makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/configure', body: { enabled: true } }),
    res2,
  );
  const body2 = json(res2);
  check('K2 an existing rule answers immediately (no checking placeholder)', body2.firewallOk === true && body2.firewallChecking === false, JSON.stringify({ ok: body2.firewallOk, checking: body2.firewallChecking }));
  writeFileSync(stateFile, JSON.stringify({ lanEnabled: false }));
  h2.dispose();
  h.dispose();
}

// ── K3. the shadow folder dialog's own filesystem primitives (v1.5.8) ──────
// Reported: "新建工作区" failed with "无法打开文件夹：… directory browse failed:
// … directoryPicker/list … HTTP 400". Since DSH 0.2.1 requires the Host to bind
// loopback, `directory-picker-auto` composes the NATIVE picker, so
// `uiWorkspace.listDirectory()` has no backend at all. The dialog therefore
// lists through this plugin's own routes; these assertions pin the shape and
// the door in front of them.
{
  const h = makeHarness({ bindHost: '127.0.0.1' });
  const list = h.routes.get('exact /dsh-lan/fs/list');
  const mkdir = h.routes.get('exact /dsh-lan/fs/mkdir');
  check('K3 both filesystem routes are registered', list !== undefined && mkdir !== undefined);
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-lan-fs-'));
  mkdirSync(join(sandbox, 'alpha'), { recursive: true });
  writeFileSync(join(sandbox, 'note.txt'), 'not a folder');

  const okList = makeRes();
  await list.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/dsh-lan/fs/list?path=' + encodeURIComponent(sandbox) }), okList);
  const listing = json(okList).value;
  check('K3 list answers the official DirectoryListing shape', okList.statusCode === 200 && listing.path === sandbox && typeof listing.home === 'string' && Array.isArray(listing.crumbs) && Array.isArray(listing.entries), okList.body.slice(0, 160));
  check('K3 list shows child folders only', listing.entries.some((e) => e.name === 'alpha') && !listing.entries.some((e) => e.name === 'note.txt'), JSON.stringify(listing.entries));
  check('K3 list rows carry name/path/hidden', listing.entries.every((e) => typeof e.name === 'string' && typeof e.path === 'string' && typeof e.hidden === 'boolean'));
  check('K3 crumbs run root → target', listing.crumbs[0].path === listing.crumbs[0].name && listing.crumbs[listing.crumbs.length - 1].path === sandbox, JSON.stringify(listing.crumbs.map((c) => c.path)));

  // No path = the host account's home directory (what the dialog asks for first).
  const homeList = makeRes();
  await list.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/dsh-lan/fs/list' }), homeList);
  check('K3 a pathless list starts at home', json(homeList).value?.path === homedir(), JSON.stringify(json(homeList).value?.path));

  const made = makeRes();
  await mkdir.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/fs/mkdir', body: { path: sandbox, name: 'beta' } }), made);
  check('K3 mkdir creates one child folder', json(made).ok === true && existsSync(join(sandbox, 'beta')), made.body.slice(0, 140));

  const again = makeRes();
  await mkdir.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/fs/mkdir', body: { path: sandbox, name: 'beta' } }), again);
  check('K3 an existing folder is reported, not crashed into', json(again).ok === false && json(again).error.code === 'directory-exists', again.body.slice(0, 140));

  const nested = makeRes();
  await mkdir.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/dsh-lan/fs/mkdir', body: { path: sandbox, name: 'a/b' } }), nested);
  check('K3 mkdir refuses a multi-segment name', json(nested).ok === false && json(nested).error.code === 'directory-create-failed', nested.body.slice(0, 120));

  const relative = makeRes();
  await list.handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/dsh-lan/fs/list?path=relative' }), relative);
  check('K3 a relative path is refused', json(relative).ok === false && json(relative).error.code === 'directory-unreadable', relative.body.slice(0, 120));

  // The door: the proxy lets /dsh-lan/* through for the landing page, so the
  // routes themselves must refuse a device that holds no credential.
  const stranger = makeRes();
  await list.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', url: '/dsh-lan/fs/list?path=' + encodeURIComponent(sandbox) }), stranger);
  check('K3 a LAN device without a credential is refused', stranger.statusCode === 403, `status=${stranger.statusCode}`);

  await setPassword(h, 'hunter2');
  const holder = makeRes();
  await list.handler(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', url: '/dsh-lan/fs/list?path=' + encodeURIComponent(sandbox), headers: { 'x-dsh-lan-key': 'hunter2' } }), holder);
  check('K3 a password holder may browse (that is what the dialog is for)', holder.statusCode === 200 && json(holder).ok === true, `status=${holder.statusCode} ${holder.body.slice(0, 120)}`);
  // v1.6.0 — DSH's frontend-static owns the webserver fallback seat, so a path
  // no route claims would be served as the SPA shell (`200 text/html`). The fs
  // namespace answers JSON instead, which is what the client probes for.
  const unknownFs = makeRes();
  await h.routes.get('prefix /dsh-lan/fs').handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/dsh-lan/fs/nope' }), unknownFs);
  check('K3 an unknown fs path answers JSON 404, not the SPA', unknownFs.statusCode === 404 && json(unknownFs).ok === false && json(unknownFs).error.code === 'not-found', `status=${unknownFs.statusCode} ${unknownFs.body.slice(0, 120)}`);
  rmSync(sandbox, { recursive: true, force: true });
}

// ── K4. a torn-down composition must not break the request path (v1.5.9) ───
// Reported (1.5.7, after running for a while): model calls failed with
// `transport failure for /api/session/selectModel: HTTP 400`, plugins vanished,
// "the backend is unreachable". `dsh-host-webserver` answers an EMPTY 400 to any
// route handler that throws, so the symptom means "handlers are throwing". Once
// the plugin is torn down (reload / removal / a composition that lost its
// services) its closures reach a dead context: `ctx.webServer` itself throws.
// Nothing this plugin installs may ever throw in that situation.
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  // Simulate the dead service: a disposed cordis getter throws on read.
  Object.defineProperty(h.ctx, 'webServer', {
    configurable: true,
    get() { throw new Error('service "webServer" is not available'); },
  });

  const status = makeRes();
  let threw = null;
  try {
    await h.routes.get('exact /dsh-lan/status').handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387' }), status);
  } catch (error) {
    threw = error;
  }
  check('K4 status answers instead of throwing on a dead webServer', threw === null && status.statusCode === 200 && json(status).ok === true, `threw=${String(threw)} status=${status.statusCode} body=${status.body.slice(0, 120)}`);

  const diag = makeRes();
  let diagThrew = null;
  try {
    await h.routes.get('exact /dsh-lan/diag').handler(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387' }), diag);
  } catch (error) {
    diagThrew = error;
  }
  check('K4 diag answers instead of throwing on a dead webServer', diagThrew === null && diag.statusCode === 200, `threw=${String(diagThrew)} status=${diag.statusCode}`);
  check('K4 a dead webServer is reported as port 0, not as a crashed route', json(diag).dshPort === 0, String(json(diag).dshPort));
  check('K4 diag names the dead composition', json(diag).composition === 'dead', String(json(diag).composition));

  // The patched connection methods run inside DSH's request path: any throw there
  // becomes a 400 for EVERY API call. A hostile request object (a getter that
  // throws) stands in for "the closure reached something dead".
  const hostile = {
    method: 'GET',
    url: '/',
    headers: { host: '127.0.0.1:19387' },
    get socket() { throw new Error('dead context'); },
  };
  check('K4 a throwing request degrades to the official trust answer', h.connection.isTrustedRequest(hostile) === OFFICIAL_TRUSTED);
  check('K4 a throwing request degrades to the official credential answer', h.connection.authentication.authenticate(hostile) === OFFICIAL_ADMIT);

  // And dispose itself: it runs while the tree is being torn down, so it must not
  // throw — and it must still unregister every route (a live route on a dead
  // plugin is exactly the 400 generator).
  const registered = h.routes.size;
  let disposeThrew = null;
  try {
    h.dispose();
  } catch (error) {
    disposeThrew = error;
  }
  check('K4 dispose never throws on a dead context', disposeThrew === null, String(disposeThrew));
  check('K4 dispose still unregisters every route', registered > 0 && h.routes.size === 0, `before=${registered} after=${h.routes.size}`);
}

// ── M. locale strings: the escaped Chinese must decode to what was intended ─
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const value = (key) => {
    const match = new RegExp('"' + key + '": "((?:\\\\.|[^"\\\\])*)"').exec(src);
    if (match === null) return null;
    try { return JSON.parse('"' + match[1] + '"'); } catch { return null; }
  };
  check('M zh firewall.system reads 防火墙已放行（系统规则）', value('firewall.system') === '防火墙已放行（系统规则）', String(value('firewall.system')));
  check('M zh firewall.retry reads 系统规则会自动识别，无需重启', value('firewall.retry') === '系统规则会自动识别，无需重启', String(value('firewall.retry')));
  check('M zh firewall.bad still reads 防火墙未放行（需管理员权限）', value('firewall.bad') === '防火墙未放行（需管理员权限）', String(value('firewall.bad')));
}

// ── N. the fence installs once, and every LAN route declares its own policy ─
//
// 0.2.3-alpha.1 authorizes EVERY webserver route before its handler
// (`auth` defaults to 'required'). The landing page, the password exchange and
// the status probe must therefore be reachable without a DSH session, or the
// only page a LAN device can open would answer 401 before it renders. The rest
// stays ‘required’: those handlers get a real Peer and no longer need to guess.
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  check('N applying the row patches the trust funnel', h.connection.isTrustedRequest.__dshLanPatched === true);
  check('N applying the row patches the credential step', h.connection.authentication.authenticate.__dshLanPatched === true);

  // Re-applying must not stack wrappers: the guard compares the connection AND
  // the authentication service.
  const before = h.calls.trusted;
  plugin.apply(h.ctx, {});
  h.connection.isTrustedRequest(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387' }));
  check('N re-applying the row does not stack wrappers', h.calls.trusted - before === 1, `calls=${h.calls.trusted - before}`);

  for (const path of ['/dsh-lan/status', '/dsh-lan/configure', '/dsh-lan/unlock', '/dsh-lan/', '/dsh-lan/diag', '/dsh-lan/fs/list', '/dsh-lan/fs/mkdir']) {
    const route = h.routes.get(`exact ${path}`);
    check(`N ${path} is reachable without a DSH session`, route !== undefined && route.auth === 'anonymous', JSON.stringify(route?.auth));
  }
  check('N the unknown-fs 404 is reachable too', h.routes.get('prefix /dsh-lan/fs')?.auth === 'anonymous');
  check('N /lanapi keeps DSH’s default (a live Peer is required)', h.routes.get('prefix /lanapi')?.auth === undefined);

  // Closing the door restores the official methods.
  h.ctx.webServer.host = '127.0.0.1';
  plugin.apply(h.ctx, {});
  check(
    'N closing the door restores both official methods',
    h.connection.isTrustedRequest.__dshLanPatched !== true && h.connection.authentication.authenticate.__dshLanPatched !== true,
  );
  h.dispose();
}

// ── N2. a stale ?token= no longer dead-ends a LAN browser ─────────────────
// DSH's token plugin intercepts `GET /?token=` BEFORE routing and answers 401
// in plain text. On a LAN browser the password is the credential, so the door
// drops the parameter on the way in — the request becomes an ordinary `/`, and
// the password decides. (Section O proves the proxy actually applies it.)
{
  const { stripTokenFromRequest } = await import('../lib/index.js');
  check('N2 a stale token is stripped from the forwarded path', stripTokenFromRequest({ url: '/?token=stale' }) === '/', String(stripTokenFromRequest({ url: '/?token=stale' })));
  check('N2 other query parameters survive', stripTokenFromRequest({ url: '/?a=1&token=stale&b=2' }) === '/?a=1&b=2', String(stripTokenFromRequest({ url: '/?a=1&token=stale&b=2' })));
  check('N2 a tokenless URL is forwarded untouched', stripTokenFromRequest({ url: '/api/x?y=1' }) === undefined);
  check('N2 a tokenless path without a query is untouched', stripTokenFromRequest({ url: '/' }) === undefined);

  const h = makeHarness({ bindHost: '0.0.0.0' });
  await setPassword(h, 'hunter2');
  const proxiedToken = makeReq({ peer: REMOTE, host: '192.168.0.9:19387', proxied: true, headers: { cookie: 'dsh-lan-key=hunter2' }, url: '/?token=stale' });
  const admission = h.connection.authentication.authenticate(proxiedToken);
  check('N2 a password-holding LAN client is authenticated even on a token URL', admission !== OFFICIAL_ADMIT && admission.peer === h.browserPeer, JSON.stringify(admission));
  h.dispose();
}

// ── O. v1.5.0 LAN proxy: the door, its gate, and the tunnel ────────────────
//
// DSH can no longer BE the LAN door: 0.2.1-rc.2 rejects wildcard bind addresses
// (and `webserver` is required, so the app would not start), while the desktop
// shell authenticates against a URL it builds with a hardcoded 127.0.0.1, so any
// concrete non-loopback bind breaks its handshake. The door is therefore this
// plugin's own reverse proxy forwarding to the loopback listener.
//
// The gate cannot be DSH's: forwarded connections arrive from 127.0.0.1, which
// DSH's peer test rightly reads as "the host machine". So the proxy decides.
{
  const { createServer } = await import('node:http');
  const net = await import('node:net');
  const { createLanProxy } = await import('../lib/lan-proxy.js');
  const { stripTokenFromRequest } = await import('../lib/index.js');

  const upstream = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-upstream-host': String(req.headers.host ?? ''),
      'x-upstream-url': String(req.url ?? '')
    });
    res.end('upstream-ok');
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write('pong-from-upstream');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;

  // 127.0.0.2: a real loopback address that is NOT 127.0.0.1, so the test proves
  // the same-port-different-address bind without touching a LAN interface.
  // The predicate mirrors makeLanAdmit()'s contract: the landing flow must stay
  // reachable without a credential (it is where one is obtained), everything
  // else needs it. The proxy itself applies no path policy of its own.
  const proxy = createLanProxy({
    target: () => ({ host: '127.0.0.1', port }),
    admit: (req) => String(req.url ?? '').startsWith('/dsh-lan/') || req.headers['x-test-credential'] === 'yes',
    rewrite: stripTokenFromRequest,
    addresses: () => ['127.0.0.2'],
    log: () => {}
  });
  const bound = await proxy.refresh();
  check('O proxy binds the LAN address on the DSH port', bound.length === 1 && bound[0] === '127.0.0.2', JSON.stringify(bound));
  check('O proxy reports listening', proxy.listening() === true);

  const base = `http://127.0.0.2:${String(port)}`;
  const denied = await fetch(`${base}/`, { redirect: 'manual' });
  check(
    'O bare / without a credential gets the landing redirect',
    denied.status === 302 && denied.headers.get('location') === '/dsh-lan/',
    `${String(denied.status)} ${String(denied.headers.get('location'))}`
  );
  const deniedApi = await fetch(`${base}/api/whatever`, { redirect: 'manual' });
  check('O a non-index path without a credential is refused', deniedApi.status === 403, String(deniedApi.status));
  const landing = await fetch(`${base}/dsh-lan/`, { redirect: 'manual' });
  check('O /dsh-lan/* stays reachable without a credential', landing.status === 200 && (await landing.text()) === 'upstream-ok', String(landing.status));

  const allowed = await fetch(`${base}/some/path?q=1`, { headers: { 'x-test-credential': 'yes' } });
  const text = await allowed.text();
  check('O a credentialed request is forwarded', allowed.status === 200 && text === 'upstream-ok', `${String(allowed.status)} ${text}`);
  check(
    'O the browser Host is preserved, not rewritten to loopback',
    allowed.headers.get('x-upstream-host') === `127.0.0.2:${String(port)}`,
    String(allowed.headers.get('x-upstream-host'))
  );
  check('O path and query survive the hop', allowed.headers.get('x-upstream-url') === '/some/path?q=1', String(allowed.headers.get('x-upstream-url')));

  // v1.8.0: DSH's token plugin answers 401 to `GET /?token=` before routing. A
  // stale bookmark must not dead-end a phone, so the door drops the parameter.
  const stale = await fetch(`${base}/?token=stale`, { headers: { 'x-test-credential': 'yes' } });
  check(
    'O a stale ?token= is stripped before the hop',
    stale.status === 200 && stale.headers.get('x-upstream-url') === '/',
    `${String(stale.status)} ${String(stale.headers.get('x-upstream-url'))}`
  );

  const rawUpgrade = (credential) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.2', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.2:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `${credential ? 'x-test-credential: yes\r\n' : ''}\r\n`
      );
    });
    let data = '';
    const finish = () => { try { socket.destroy(); } catch {} resolve(data); };
    socket.setTimeout(3000, finish);
    socket.on('data', (chunk) => { data += chunk.toString(); if (data.includes('pong-from-upstream') || data.includes('403')) finish(); });
    socket.on('close', finish);
    socket.on('error', finish);
  });
  const tunneled = await rawUpgrade(true);
  check('O WebSocket upgrades are tunneled through', tunneled.includes('101 Switching Protocols') && tunneled.includes('pong-from-upstream'), JSON.stringify(tunneled.slice(0, 70)));
  const refused = await rawUpgrade(false);
  check('O a credential-less upgrade is refused', refused.includes('403'), JSON.stringify(refused.slice(0, 60)));

  proxy.stop();
  check('O stop() closes the listeners', proxy.listening() === false);
  upstream.close();
}

console.log(`PASS ${ok.length} / ${ok.length + fails.length}`);
for (const f of fails) console.log('  FAIL: ' + f);
rmSync(HOME, { recursive: true, force: true });
process.exit(fails.length === 0 ? 0 : 1);
