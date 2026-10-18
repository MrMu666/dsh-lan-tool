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
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-lan-test-'));
process.env.DSH_HOME = HOME;
const PATCH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml');

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

function makeHarness({ bindHost = '0.0.0.0', port = 19387 } = {}) {
  const routes = new Map();
  const calls = { rejection: 0, authorize: 0, fetchPeers: [] };
  const browserPeer = { id: 'browser-peer', principal: { kind: 'owner' } };
  const connection = {
    browserPeer,
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
  check('H every 403 path uses the evidence-only helper', !client.includes('if (!clientIsLocal()) mountGate();') && (client.match(/if \(shouldGate\(\)\) mountGate\(\);/g) || []).length === 3);
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
  check('H the gate only auto-focuses on non-phone layouts', client.includes('if (!mobilePortrait) input.focus();'));
  check('H the keyboard guard shares the composer predicate', client.includes('if (active && isComposerField(this) && !composerIsWarm()) return;') && client.includes('if (!isComposerField(t)) return; // our own inputs keep their Enter'));
  check('H the obsolete TEXTAREA/INPUT composer test is gone', !client.includes('closest(\'[class$="_composerSeat"]\') !== null && Date.now() - lastComposerTap'));
  // 1.4.6 — the "applying…" line must read as progress (green), not as the
  // muted status grey or the red error tone.
  check('H the applying line is rendered with the progress class', client.includes('className: c.pending, children: t("status.applying")'));
  check('H the progress class uses the official success token', /\.dshLan_pending\{color:var\(--dsw-alias-state-success-primary/.test(client));
  check('H the progress class is not the error class', !/\.dshLan_pending\{[^}]*state-error/.test(client));
  // v85 — the whale is the title row's FIRST flex child, so the official
  // `_titleCluster{flex:1}` centres the session title between it and the
  // official right-sidebar control at the far end. Same 28px ghost button.
  check('H the whale is seated as the title row\'s first child', client.includes('function seatWhale()') && client.includes('row.insertBefore(whaleEl, row.firstChild)'));
  check('H the title row carries the seat marker', client.includes('row.setAttribute("data-dsh-lan-whale", "1")'));
  check('H the title wrapper takes the free space', client.includes('[data-dsh-lan-whale=\\"1\\"] > :has(> [class$=\\"_titleCluster\\"]){flex:1 1 auto !important;min-width:0}'));
  check('H the title cluster content is centred', client.includes('[data-dsh-lan-whale=\\"1\\"] [class$=\\"_titleCluster\\"]{justify-content:center}'));
  // The whale's id ends in "Whale", so `[class$="_titleRow"]` matches the BUTTON
  // too — every scoped rule must key off the marker attribute instead.
  check('H no whale rule is scoped by the title row class', !/\[class\$=\\"_titleRow\\"\]\[data-dsh-lan-whale\]/.test(client) && !/\[class\$=\\"_titleRow\\"\] \[class\$=\\"_headerCorner\\"\]/.test(client));
  // Double-escaped quotes compile to a bogus attribute value that matches
  // nothing — that silently disabled the centring rule once already.
  check('H the marker rules are not double-escaped', !client.includes('data-dsh-lan-whale=\\\\\\"1\\\\\\"'));
  check('H the whale rule no longer carries the corner ordering', !/#dshLanWhale\{order:0/.test(client) && !client.includes('> [data-slot$=\\\"header.corner\\\"]{order:1}'));
  // Property order inside the rule is not significant, so check each one.
  const whaleRule = /#dshLanWhale\{[^}]*\}/.exec(client)?.[0] ?? '';
  check('H the whale is glyph-only (no background, border or shadow)', whaleRule.includes('background:0 0') && whaleRule.includes('border:none') && whaleRule.includes('box-shadow:none'), whaleRule.slice(0, 80));
  check('H the whale matches the official 28px control', whaleRule.includes('width:28px') && whaleRule.includes('height:28px'), whaleRule.slice(0, 80));
  check('H the floating whale and its drag persistence are gone', !client.includes("dsh-lan-whale-pos") && !client.includes("function applyWhalePos") && !client.includes("whaleSuppressClick"));
  check('H the floating placement and the title reserve are gone', !client.includes("#dshLanWhale{position:fixed") && !client.includes("dsh-lan-rail-hidden [class$=\\\"_titleRow\\\"]{padding-left"));
  // v1.5.0 — the LAN door is the plugin's own proxy, gated by makeLanAdmit().
  // Locked here because the opt-in test/lan-proxy-e2e.mjs is what FOUND the
  // missing token carve-out (its last hop was refused on the LAN), and `npm
  // test` must catch that regression too.
  check('H the proxy is the only LAN door and takes the injected gate', server.includes('createLanProxy({') && server.includes('admit: makeLanAdmit(ctx)'));
  check(
    'H the LAN gate admits the launch-token exchange',
    server.includes('if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) return true;'),
    'the mint flow ends on GET /?token=… through the proxy — without this carve-out the LAN login cannot complete'
  );
  check('H the LAN gate keeps the landing flow reachable', server.includes('if (url.pathname.startsWith("/dsh-lan/")) return true;'));
  check('H nothing writes a webserver override any more', !server.includes('`    host: ') && !server.includes('"- id: webserver"') && !server.includes('host: \'${ALL_INTERFACES}\''));
  // 1.5.1 — the fence must patch the TRUST FUNNEL, not just requestRejection.
  // 0.2.1 admits /api through connection.admit() (dsh-api-gateway →
  // admitConnection), which starts with isTrusted() → isTrustedApiRequest(...);
  // that rule rejects a non-loopback Host authority, and proxied requests keep
  // the browser's LAN authority on purpose. 1.5.0 patched requestRejection only
  // (as every 1.4.x did) and shipped a GUI that loaded over the LAN while every
  // API call answered 403 — test/lan-proxy-e2e.mjs compares both origins now.
  check('H the fence patches the trust funnel too', server.includes('connection.isTrusted = patchedIsTrusted') && server.includes('const patchedIsTrusted'));
  check('H the trust allowance needs a local peer and an open door', server.includes('if (local && lanDoorOpen(ctx)) return true;'));
  // 1.5.4 — the event stream goes through `admit()`, which also demands DSH's own
  // browser session; its cookie name is derived from Host:port and DSH used to change
  // ports every launch, so a valid LAN client could hold a session that can never
  // match again and sit on 401 for ever (measured on the user's machine:
  // `upgrade-open … cookie=true` then `HTTP/1.1 401 Unauthorized`). Admission now
  // accepts this plugin's password credential and hands back DSH's own browserPeer.
  check('H admission accepts the password credential', server.includes('connection.admit = patchedAdmit') && server.includes('return { peer: connection.browserPeer };'));
  check('H admission requires a local peer, an open door and the credential', server.includes('if (local && lanDoorOpen(ctx) && hasLanCredential(req)) return { peer: connection.browserPeer };'));
  check('H the admission override is installed and removed with the rest', server.includes('const origAdmit') && server.includes('wrap.connection.admit = wrap.origAdmit'));
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

// ── K. firewall: a LAN device that got through proves the port is open ─────
{
  const stub = childProcessStub.stubState;
  stub.netshRuleExists = false;
  stub.powershellJson = '';
  const h = makeHarness({ bindHost: '0.0.0.0', port: 19420 });
  // A LAN peer reaches the server while LAN access is on …
  h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19420', headers: { 'x-dsh-lan-key': 'whatever' } }));
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

// ── L. mobile keyboard: real client code on a stubbed DOM ──────────────────
// Covers BOTH halves of the composer story: Enter → newline (1.4.3) and "never
// pop the input method unless the user tapped a text field" (1.4.4).
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const start = src.indexOf('const COMPOSER_WRAP =');
  const stop = src.indexOf('document.addEventListener("keydown", onKeydownCapture, true);');
  const slice = src.slice(start, stop);

  const makeScope = () => {
    const dispatched = [];
    const timers = [];
    const listeners = [];
    class FakeEvent {
      constructor(type, init = {}) {
        Object.assign(this, init);
        this.type = type;
        this.defaultPrevented = false;
        this.propagationStopped = false;
      }
      preventDefault() { this.defaultPrevented = true; }
      stopPropagation() { this.propagationStopped = true; }
    }
    class FakeKeyboardEvent extends FakeEvent {}
    class FakeInputEvent extends FakeEvent {}
    class FakeElement {
      constructor(tag = 'DIV', className = '', editable = false) {
        this.tagName = tag;
        this.className = className;
        this.isContentEditable = editable;
        this.contentEditableAttr = editable ? 'true' : null;
        this.parent = null;
        this.children = [];
        this.dispatched = dispatched;
        this.focusCalls = 0;
        this.blurCalls = 0;
      }
      getAttribute(name) { return name === 'contenteditable' ? this.contentEditableAttr : null; }
      // Minimal matcher for the two selector shapes the plugin uses.
      closest(selector) {
        const matches = (el) => String(selector).split(',').some((raw) => {
          const part = raw.trim();
          const contains = /^\[class\*="(.*)"\]$/.exec(part);
          if (contains !== null) return String(el.className).includes(contains[1]);
          const endsWith = /^\[class\$="(.*)"\]$/.exec(part);
          if (endsWith !== null) return String(el.className).endsWith(endsWith[1]);
          return false;
        });
        for (let el = this; el !== null; el = el.parent) if (matches(el)) return el;
        return null;
      }
      querySelectorAll() { return []; }
      querySelector() { return null; }
      dispatchEvent(event) { dispatched.push(event); return true; }
      focus() { this.focusCalls += 1; }
      blur() { this.blurCalls += 1; }
    }
    const api = new Function(
      'active',
      'document',
      'window',
      'KeyboardEvent',
      'InputEvent',
      'HTMLElement',
      `${slice}\nreturn { onKeydownCapture, insertLineBreakComposer, composerStructure, isComposerField, markComposerWarm: warmComposer, isComposerWarm: composerIsWarm, getWarmAt: () => composerWarmAt, setWarmAt: (value) => { composerWarmAt = value; } };`,
    )(
      true,
      { execCommand: () => true, addEventListener: (type, fn) => listeners.push({ type, fn }) },
      { setTimeout: (fn) => { timers.push(fn); } },
      FakeKeyboardEvent,
      FakeInputEvent,
      FakeElement,
    );
    const fire = (type, event) => {
      for (const entry of listeners.filter((l) => l.type === type)) entry.fn(event);
    };
    // The composer: a Lexical contenteditable inside the official wrapper.
    const wrapper = new FakeElement('DIV', 'uV2eYG_input', false);
    const composer = new FakeElement('DIV', 'lexical', true);
    composer.parent = wrapper;
    const outside = new FakeElement('DIV', 'somewhere', false);
    const ownInput = new FakeElement('INPUT', 'dshLan_input', false);
    return { api, composer, outside, ownInput, dispatched, timers, listeners, fire, FakeKeyboardEvent };
  };

  const enter = (scope, target, init = {}) => {
    const event = new scope.FakeKeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true, ...init });
    event.target = target;
    scope.api.onKeydownCapture(event);
    return event;
  };

  // ── Enter = newline, never send ──────────────────────────────────────────
  const plain = makeScope();
  const plainEvent = enter(plain, plain.composer);
  check('L plain Enter is swallowed', plainEvent.defaultPrevented === true && plainEvent.propagationStopped === true);
  check('L plain Enter is re-issued as Shift+Enter', plain.dispatched.length === 1 && plain.dispatched[0].key === 'Enter' && plain.dispatched[0].shiftKey === true, JSON.stringify(plain.dispatched.map((e) => e.type + ':' + e.key + ':' + e.shiftKey)));
  check('L the re-issued event is marked so it cannot loop', plain.dispatched[0].__dshLanLineBreak === true);

  const composing = makeScope();
  const composingEvent = enter(composing, composing.composer, { isComposing: true });
  check('L Enter during IME composition is left alone', composingEvent.defaultPrevented === false && composing.dispatched.length === 0);
  const imeKeyCode = makeScope();
  const imeEvent = enter(imeKeyCode, imeKeyCode.composer, { keyCode: 229 });
  check('L keyCode 229 (IME) is left alone', imeEvent.defaultPrevented === false && imeKeyCode.dispatched.length === 0);

  const shifted = makeScope();
  const shiftedEvent = enter(shifted, shifted.composer, { shiftKey: true });
  check('L Shift+Enter keeps the app\'s own behaviour', shiftedEvent.defaultPrevented === false && shifted.dispatched.length === 0);
  const outside = makeScope();
  const outsideEvent = enter(outside, outside.outside);
  check('L Enter outside the composer is untouched', outsideEvent.defaultPrevented === false && outside.dispatched.length === 0);
  const own = makeScope();
  const ownEvent = enter(own, own.ownInput);
  check('L Enter in the plugin\'s own input keeps its normal behaviour', ownEvent.defaultPrevented === false && own.dispatched.length === 0);

  const marked = makeScope();
  const markedEvent = enter(marked, marked.composer, { __dshLanLineBreak: true });
  check('L our own synthetic event is ignored', markedEvent.defaultPrevented === false && marked.dispatched.length === 0);

  // If the app ignored the synthetic key, the fallbacks must still fire.
  const fallback = makeScope();
  enter(fallback, fallback.composer);
  check('L a fallback is scheduled after the first attempt', fallback.timers.length === 1);
  fallback.timers[0]();
  check('L the beforeinput fallback carries insertLineBreak', fallback.dispatched.some((e) => e.inputType === 'insertLineBreak'), JSON.stringify(fallback.dispatched.map((e) => e.type + ':' + (e.inputType || e.key || ''))));
  check('L a second fallback is scheduled in turn', fallback.timers.length === 2);
  fallback.timers[1](); // legacy execCommand path — must not throw
  check('L the legacy fallback is reached without throwing', true);

  // ── the keyboard must stay down unless the user tapped a text field ──────
  const cold = makeScope();
  check('L the Lexical contenteditable counts as the composer field', cold.api.isComposerField(cold.composer) === true);
  check('L a plain div is not a composer field', cold.api.isComposerField(cold.outside) === false);
  check('L the plugin\'s own input is not a composer field', cold.api.isComposerField(cold.ownInput) === false);
  cold.composer.focus();
  check('L a programmatic composer focus is dropped while cold', cold.composer.focusCalls === 0, `calls=${cold.composer.focusCalls}`);
  cold.fire('focusin', { target: cold.composer });
  check('L a cold focusin on the composer is taken back', cold.composer.blurCalls === 1, `blur=${cold.composer.blurCalls}`);

  const warm = makeScope();
  warm.fire('pointerdown', { target: warm.composer });
  check('L tapping the composer marks it warm', warm.api.isComposerWarm() === true);
  warm.composer.focus();
  check('L the composer may take focus right after a real tap', warm.composer.focusCalls === 1);
  warm.fire('focusin', { target: warm.composer });
  check('L a warm focusin is left alone', warm.composer.blurCalls === 0);
  warm.ownInput.focus();
  check('L focus on the plugin\'s own input is never blocked', warm.ownInput.focusCalls === 1);

  const stale = makeScope();
  stale.fire('pointerdown', { target: stale.outside });
  check('L a tap outside the composer does not warm it', stale.api.getWarmAt() === 0 && stale.api.isComposerWarm() === false, `warmAt=${stale.api.getWarmAt()}`);
  stale.composer.focus();
  check('L focus stays blocked after an unrelated tap', stale.composer.focusCalls === 0);

  // Warmth is a 3s window, not a latch: after it lapses, the same programmatic
  // focus is dropped again (no need to sit through three real seconds).
  const expired = makeScope();
  expired.api.markComposerWarm();
  expired.api.setWarmAt(Date.now() - 4000);
  check('L warmth expires after ~3s', expired.api.isComposerWarm() === false);
  expired.composer.focus();
  check('L a focus after the warmth expired is dropped again', expired.composer.focusCalls === 0);
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

// ── N. switch ON: the desktop shell's launch-token exchange survives ───────
//
// The desktop shell authenticates itself by fetching the Host's own
// `/?token=…` URL and demanding exactly `303` + `Set-Cookie`. Short-circuiting
// every host request with `return true` hands it a 200 instead, so the shell
// throws `Desktop Host authentication failed` and the desktop app cannot start
// (1.4.4 regression). Carrying the process token IS being the host: the shell
// must reach DSH's own rule, which decides 303/401 by the token alone.
{
  const h = makeHarness({ bindHost: '0.0.0.0' });
  for (const peer of LOCAL_PEERS) {
    for (const host of HOSTS) {
      const res = makeRes();
      const allowed = h.connection.browserAuth.authorizeIndex(makeReq({ peer, host, url: '/?token=abc' }), res);
      check(
        `N shell token exchange delegates to DSH (peer=${peer} host=${host})`,
        allowed === OFFICIAL_AUTHORIZE && res.statusCode === 0,
        `allowed=${JSON.stringify(allowed)} status=${res.statusCode}`,
      );
    }
  }
  // The carve-out is exactly "GET / with a token parameter" — nothing wider.
  check('N a tokenless host request stays local', h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387' }), makeRes()) === true);
  check('N a token on a non-root path stays local', h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/api?token=abc' }), makeRes()) === true);
  check('N POST / with a token stays local', h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', method: 'POST', url: '/?token=abc' }), makeRes()) === true);
  // `has()` semantics (agreed): the parameter merely existing counts, so an
  // empty value is DSH's to judge (its own tokenMatches then answers 401).
  check('N empty ?token= still delegates to DSH', h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/?token=' }), makeRes()) === OFFICIAL_AUTHORIZE);
  check('N a repeated ?token= still delegates to DSH', h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/?token=a&token=b' }), makeRes()) === OFFICIAL_AUTHORIZE);
  // The password gate is a different function and must NOT learn about tokens.
  check('N a token never bypasses requestRejection', h.connection.requestRejection(makeReq({ peer: REMOTE, host: '192.168.0.9:19387', url: '/?token=abc' })) === 403);

  // Re-applying the same plugin row must not stack the delegation: the guard
  // has to compare both the connection and its browserAuth.
  const before = h.calls.authorize;
  const res = makeRes();
  h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/?token=abc' }), res);
  const single = h.calls.authorize - before;
  h.ctx.webServer.host = '0.0.0.0';
  plugin.apply(h.ctx, {});
  const res2 = makeRes();
  h.connection.browserAuth.authorizeIndex(makeReq({ peer: '127.0.0.1', host: '127.0.0.1:19387', url: '/?token=abc' }), res2);
  check(
    'N re-applying the row does not stack delegations',
    single === 1 && h.calls.authorize - before === 2 && res2.statusCode === 0,
    `single=${single} total=${h.calls.authorize - before} status=${res2.statusCode}`,
  );
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
