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

console.log(`PASS ${ok.length} / ${ok.length + fails.length}`);
for (const f of fails) console.log('  FAIL: ' + f);
rmSync(HOME, { recursive: true, force: true });
process.exit(fails.length === 0 ? 0 : 1);
