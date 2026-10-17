/**
 * dsh-lan-tool — node half.
 *
 * LAN access for the DSH Web GUI with a password-gated full-access channel.
 * Installed as an ordinary profile bundle (`dsh.bundle.patch`); there is no
 * installer script and nothing asks for a password at install time.
 *
 * - Composition: the bundle patch deliberately declares NO `webserver`
 *   override, so while LAN access is off the official row from
 *   `@deepseek-ai/dsh-web-app` keeps the GUI on `127.0.0.1` with gzip on.
 *   Turning LAN access on (settings card) writes a managed override into the
 *   ACTIVE profile's own `cordis.patch.yml`; the harness watches that file
 *   and hot-reloads the composition, so the switch re-binds live.
 * - The managed override restates the whole `webserver` config (host, port and
 *   the three compression keys): patch application replaces the targeted
 *   row's entire `config` block, so anything omitted silently falls back to
 *   the schema default — which would turn gzip off.
 * - Firewall: keeps a host firewall rule for the bound port while LAN
 *   access is on (Windows Defender Firewall via netsh on Windows; firewalld
 *   / ufw / iptables on Linux), removes it when toggled off.
 * - `/lanapi/*` proxy: re-runs any `/api/*` request through the in-process
 *   API gateway via the connection service's shared fetch handler (bypasses
 *   the official Host/Origin trust fence).
 *   Callers that are not the host machine must present the password
 *   (`x-dsh-lan-key`).
 * - Own endpoints: `/dsh-lan/status` (read-only), `/dsh-lan/configure`
 *   (host-machine only), `/dsh-lan/unlock`, `/dsh-lan/mint` (password →
 *   official cookie exchange), `/dsh-lan/` (landing page).
 *
 * SECURITY: turning LAN access on deliberately relaxes the built-in
 * Host/Origin trust posture. Requests from the HOST MACHINE are always open —
 * "local" is decided by the TCP peer address (loopback or one of this machine's
 * own addresses), never by the Host header, so the desktop host keeps working
 * whatever name it reaches the GUI through (1.4.1). Everything else must carry
 * the dsh-LAN password; without a password the LAN is unusable (never
 * unguarded). Anyone on the LAN who knows the password can change settings,
 * credentials, and agent presets. Only enable on networks you trust.
 *
 * @module dsh-lan-tool
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLanProxy, viaProxy } from "./lan-proxy.js";

const name = "dsh-lan-tool";
const inject = ["webServer", "connection"];
/**
 * Kept in sync with package.json (the offline test asserts that). `/dsh-lan/status`
 * reports it and the client sends its own copy as `x-dsh-lan-client`, because in a
 * running app the two halves update at DIFFERENT times: the browser half is re-read
 * from disk by client-hmr, while the node half stays whatever was imported when the
 * app started — reinstalling the plugin in the same session does not swap it. That
 * mixed pair was invisible in 1.4.1 and produced a password gate nobody could
 * explain; now it is logged and the gate stays off.
 */
const PLUGIN_VERSION = "1.5.6";

const LOOPBACK = "127.0.0.1";
const FIREWALL_RULE_NAME = "dsh-lan-tool (auto)";
/**
 * Rule names left behind by the installer-era releases (`install.ps1` created
 * `dsh-LAN (auto)`; the pre-rename build used `DSH LAN Access (auto)`).
 * Renaming the rule makes the old ones unreachable for `removeFirewallRule()`
 * — they would stay in the system forever, still allowing inbound traffic to
 * the port while the UI reports "LAN off". They are removed once by the
 * one-time migration below.
 */
const LEGACY_FIREWALL_RULE_NAMES = ["dsh-LAN (auto)", "DSH LAN Access (auto)"];
/**
 * The `webserver` override this plugin used to write into the active profile's
 * patch file. v1.5.0 removed the WRITE side entirely and kept the markers so
 * leftovers can be recognised and stripped; see LEGACY_BLOCKS.
 */
const BLOCK_BEGIN = "# --- dsh-lan-tool LAN block (managed - do not edit) ---";
const BLOCK_END = "# --- end dsh-lan-tool LAN block ---";
/**
 * Every managed block that must be stripped when found. Three generations:
 *
 * - 1.3.x installer/toggle blocks (pre-rename, still beat the bundle layer and
 *   would keep the socket exposed while the card said "off"),
 * - the pre-1.5.0 LAN block, which wrote `host: '0.0.0.0'`. On DSH 0.2.1-rc.2
 *   that value is no longer merely unsafe, it is REJECTED: `webserver` validates
 *   its bind address as a concrete IP literal and refuses wildcards, and because
 *   `webserver` is a required row the whole Host then refuses to start (measured
 *   2026-10-17). A leftover block therefore bricks the desktop app; stripping it
 *   on load is the only self-healing this plugin can do (it cannot run at all
 *   while the webserver row is failing, so a bricked install needs the README's
 *   manual step once).
 *
 * After stripping, the profile patch is back to the official default — a clean
 * "off". LAN access now comes from this plugin's own proxy (lib/lan-proxy.js),
 * never from a `webserver` override.
 */
const LEGACY_BLOCKS = [
	["# --- dsh-LAN install block (managed - do not edit) ---", "# --- end dsh-LAN install block ---"],
	["# --- dsh-LAN toggle block (managed - do not edit) ---", "# --- end dsh-LAN toggle block ---"],
	[BLOCK_BEGIN, BLOCK_END]
];
/** State-file key holding the DESIRED LAN state (the socket can no longer tell us). */
const LAN_STATE_KEY = "lanEnabled";
const MAX_PROXY_BODY_BYTES = 256 * 1024 * 1024;
const MAX_CONFIG_BODY_BYTES = 1024 * 1024;
/** How often the LAN proxy re-reads this machine's interface addresses. */
const PROXY_REFRESH_MS = 10000;
/**
 * Verdict lifetimes. A verdict we own (our own named rule) is stable; anything
 * else — and every refusal — is provisional, because the OS can change the real
 * state behind our back: Windows' own "allow this app" dialog creates a
 * program-scoped rule that our named-rule check cannot see, which is why the
 * card kept saying "blocked (needs admin)" after the user had already allowed
 * it (≤1.4.2). Refusals are therefore re-checked with a short backoff, in the
 * background, so the card converges on its own.
 */
const FIREWALL_TTL_STABLE_MS = 600 * 1000;
const FIREWALL_TTL_PROVISIONAL_MS = 60 * 1000;
const FIREWALL_RECHECK_MIN_MS = 10 * 1000;
const FIREWALL_RECHECK_MAX_MS = 60 * 1000;
const firewallSummaryCache = new Map();
const firewallRefreshInFlight = new Set();
let firewallRecheckAttempts = 0;
/** When LAN access was last turned on, and when a LAN peer was last admitted. */
let lanEnabledAt = 0;
let remotePeerSeenAt = 0;
let firewallFailureLogged = false;

// ── LAN password fence ─────────────────────────────────────────────────────
// Transport for the dsh-lan-tool credential (the password itself, same scheme
// as the x-dsh-lan-key header the browser already sends): fetch calls carry
// the header (attached by lib/client.js), top-level navigations and WebSocket
// upgrades carry the session cookie (set on unlock, cleared on lock).
const LAN_KEY_HEADER = "x-dsh-lan-key";
const LAN_COOKIE_NAME = "dsh-lan-key";
// unlock/mint brute-force ledger: per-IP failures, lockout after threshold.
const UNLOCK_MAX_FAILS = 5;
const UNLOCK_LOCK_MS = 5 * 60 * 1000;
const unlockAttempts = new Map();

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Password/state file. The name intentionally stays `dsh-lan.json` (it is a
 * data file, not a package name): renaming it would discard the password of
 * every existing installation.
 */
function stateFile() {
	return join(dshHome(), "dsh-lan.json");
}

function readState() {
	try {
		const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function writeState(state) {
	mkdirSync(dirname(stateFile()), { recursive: true });
	writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
}

// ── active profile resolution ──────────────────────────────────────────────
// `profileContext` is provided by the profile boot for every launch path
// (`dsh web`, `dsh --profile …`, the desktop host) and carries the profile's
// name AND its patch path, so the switch reads and writes the file the harness
// actually watches. The row `config.profile` value is only a fallback.
let active = { profile: "web", patchPath: join(dshHome(), "profiles", "web", "cordis.patch.yml") };

function profileOf(ctx, config) {
	let context = null;
	try {
		context = typeof ctx?.get === "function" ? ctx.get("profileContext") : null;
	} catch {
		context = null;
	}
	const fromContext = context?.name;
	const fromConfig = config?.profile;
	const profile = typeof fromContext === "string" && fromContext !== ""
		? fromContext
		: typeof fromConfig === "string" && fromConfig !== ""
			? fromConfig
			: "web";
	const patchPath = typeof context?.patchPath === "string" && context.patchPath !== ""
		? context.patchPath
		: join(dshHome(), "profiles", profile, "cordis.patch.yml");
	return { profile, patchPath };
}

/** Bare hostname from the request's Host header (brackets stripped). */
function hostnameOf(req) {
	const raw = String(req.headers.host ?? "");
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
	if (bracketed) return bracketed[1].toLowerCase();
	return raw.split(":")[0].toLowerCase();
}

/**
 * Host-header loopback — DISPLAY ONLY (`/dsh-lan/status.loopback`), never an
 * access decision. See isLocalRequest() for why.
 */
function isLoopback(req) {
	const host = hostnameOf(req);
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Normalize an address for comparison (brackets, zone id, v4-mapped form). */
function normalizeAddress(value) {
	let address = String(value ?? "").trim().toLowerCase();
	if (address === "") return "";
	const zone = address.indexOf("%"); // fe80::1%eth0
	if (zone !== -1) address = address.slice(0, zone);
	const bracketed = /^\[([^\]]+)\]$/.exec(address);
	if (bracketed) address = bracketed[1];
	if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
	return address;
}

function isLoopbackAddress(address) {
	return address === "127.0.0.1" || address === "::1";
}

/**
 * Every address this machine owns (loopback plus every interface, IPv4 and
 * IPv6), cached briefly: the set follows DHCP/VPN changes and the test runs per
 * request. Used only to recognize OUR OWN addresses as "the host machine".
 */
const LOCAL_ADDRESS_TTL_MS = 10000;
let localAddressCache = { at: 0, set: new Set() };

function localHostAddresses() {
	const now = Date.now();
	if (now - localAddressCache.at < LOCAL_ADDRESS_TTL_MS) return localAddressCache.set;
	const set = new Set(["127.0.0.1", "::1"]);
	try {
		for (const list of Object.values(networkInterfaces())) {
			for (const iface of list ?? []) {
				const address = normalizeAddress(iface?.address);
				if (address !== "") set.add(address);
			}
		}
	} catch {
		// keep the loopback-only set
	}
	localAddressCache = { at: now, set };
	return set;
}

/**
 * Is this request from THE HOST MACHINE?
 *
 * Decided by the TCP peer address ONLY — loopback, or one of this machine's own
 * interface addresses (reaching your own LAN address from the same box is still
 * the same box). The Host header deliberately plays no part:
 *
 * - the desktop host can load the GUI under a name this code cannot enumerate
 *   (`[::1]`, which browsers report WITH brackets; the machine name; the LAN
 *   address; a webview that rewrites the host), and
 * - "the host machine is never asked for the LAN password" is a hard product
 *   rule (1.4.1): a hostname allow-list is exactly how 1.4.0 locked the desktop
 *   out of its own GUI with a password page nobody could satisfy.
 *
 * A LAN device cannot pass this test: the peer address is enforced by TCP, and
 * its address is not in this machine's set (spoofing `Host: 127.0.0.1` does not
 * help either). Residual trade-off, recorded in AGENTS.md §3.6: a browser ON
 * this machine that reaches the GUI through a rebinding domain is treated as
 * local, exactly like DSH's own loopback trust.
 */
function isLocalPeer(req) {
	const peer = normalizeAddress(req.socket?.remoteAddress);
	if (peer === "") return false;
	if (isLoopbackAddress(peer)) return true;
	return localHostAddresses().has(peer);
}

/** Access decision: the host machine is always local, LAN devices never are. */
function isLocalRequest(req) {
	return isLocalPeer(req);
}

/** Client IP for the unlock/mint brute-force ledger (best effort). */
function clientIp(req) {
	return req.socket?.remoteAddress ?? "unknown";
}

function unlockAllowed(req) {
	const entry = unlockAttempts.get(clientIp(req));
	return entry === void 0 || entry.lockedUntil <= Date.now();
}

function recordUnlockFail(req) {
	const ip = clientIp(req);
	const prev = unlockAttempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
	const fails = prev.fails + 1;
	unlockAttempts.set(ip, {
		fails,
		lockedUntil: fails >= UNLOCK_MAX_FAILS ? Date.now() + UNLOCK_LOCK_MS : 0
	});
}

function resetUnlock(req) {
	unlockAttempts.delete(clientIp(req));
}

/** Raw dsh-lan-tool credential from the request (header first, then cookie). */
function lanKeyOf(req) {
	const headerKey = req.headers?.[LAN_KEY_HEADER];
	if (typeof headerKey === "string" && headerKey !== "") return headerKey;
	const rawCookie = req.headers?.cookie;
	if (typeof rawCookie !== "string") return "";
	for (const segment of rawCookie.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1) continue;
		if (segment.slice(0, at).trim() !== LAN_COOKIE_NAME) continue;
		try {
			return decodeURIComponent(segment.slice(at + 1).trim());
		} catch {
			return "";
		}
	}
	return "";
}

/** Whether the request carries the dsh-lan-tool password (header or cookie). */
function hasLanCredential(req) {
	const key = lanKeyOf(req);
	return key !== "" && passwordMatches(readState(), key);
}

/** Cookie-only variant: top-level navigations cannot set custom headers. */
function hasLanCookie(req) {
	const rawCookie = req.headers?.cookie;
	if (typeof rawCookie !== "string") return false;
	for (const segment of rawCookie.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1) continue;
		if (segment.slice(0, at).trim() !== LAN_COOKIE_NAME) continue;
		let value = "";
		try {
			value = decodeURIComponent(segment.slice(at + 1).trim());
		} catch {
			return false;
		}
		if (value !== "" && passwordMatches(readState(), value)) return true;
		return false;
	}
	return false;
}

function hashPassword(password, salt) {
	return createHash("sha256").update(salt).update(password).digest("hex");
}

function passwordMatches(state, candidate) {
	if (typeof state.passwordHash !== "string" || typeof state.salt !== "string") return false;
	const actual = Buffer.from(hashPassword(String(candidate), state.salt), "hex");
	const expected = Buffer.from(state.passwordHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Bump the password epoch whenever the password is set or cleared. */
function bumpPasswordVersion(state) {
	state.passwordVersion = (typeof state.passwordVersion === "number" ? state.passwordVersion : 0) + 1;
	return state;
}

function lanAddresses() {
	const out = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
		}
	}
	return out;
}

// ── firewall (cross-platform) ──────────────────────────────────────────────
// Windows: manage the Windows Defender Firewall rule (private+domain) via
// netsh, exactly as before. Linux: use the first available firewall manager
// among firewalld / ufw / iptables. When no supported firewall tool is found
// (common on desktop distros and containers) the port needs no rule and the
// plugin reports the firewall as unmanaged-but-open. When a tool exists but
// the plugin lacks permission (needs root), the rule cannot be asserted and
// the UI reports "needs admin" — the same posture as Windows without admin.

function spawnTool(cmd, args) {
	const result = spawnSync(cmd, args, {
		shell: false,
		encoding: "utf8",
		windowsHide: process.platform === "win32",
		timeout: 20000
	});
	return { ok: result.status === 0, out: result.stdout ?? "", err: result.stderr ?? "", error: result.error };
}

function execFileAsync(cmd, args, timeout = 20000) {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ shell: false, encoding: "utf8", windowsHide: process.platform === "win32", timeout },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: stdout ?? "", err: stderr ?? "", error });
			}
		);
	});
}

async function ufwRuleExistsAsync(port) {
	const result = await execFileAsync("ufw", ["status"]);
	return result.ok && new RegExp(`${port}/tcp\\s+ALLOW`, "i").test(result.out);
}

/** True when the binary can be spawned (exists on PATH / at its usual spot). */
function toolAvailable(cmd) {
	return spawnTool(cmd, ["--version"]).error === undefined;
}

const netshBackend = {
	label: "netsh",
	ruleExists: () => ruleExistsByName(FIREWALL_RULE_NAME),
	addRule: (port) => spawnTool("netsh", ["advfirewall", "firewall", "add", "rule", `name=${FIREWALL_RULE_NAME}`, "dir=in", "action=allow", "protocol=TCP", `localport=${port}`, "profile=private,domain"]).ok,
	removeRule: () => {
		if (!ruleExistsByName(FIREWALL_RULE_NAME)) return true;
		return spawnTool("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${FIREWALL_RULE_NAME}`]).ok;
	}
};

function ruleExistsByName(ruleName) {
	return spawnTool("netsh", ["advfirewall", "firewall", "show", "rule", `name=${ruleName}`]).ok;
}

const firewalldBackend = {
	label: "firewalld",
	available: () => toolAvailable("firewall-cmd") && spawnTool("firewall-cmd", ["--state"]).ok,
	ruleExists: (port) => spawnTool("firewall-cmd", ["--permanent", "--query-port", `${port}/tcp`]).ok,
	addRule: (port) => {
		const add = spawnTool("firewall-cmd", ["--permanent", "--add-port", `${port}/tcp`]);
		const reload = spawnTool("firewall-cmd", ["--reload"]);
		return add.ok && reload.ok;
	},
	removeRule: (port) => {
		const del = spawnTool("firewall-cmd", ["--permanent", "--remove-port", `${port}/tcp`]);
		const reload = spawnTool("firewall-cmd", ["--reload"]);
		return del.ok && reload.ok;
	}
};

const ufwBackend = {
	label: "ufw",
	available: () => toolAvailable("ufw"),
	ruleExists: (port) => {
		const result = spawnTool("ufw", ["status"]);
		return result.ok && new RegExp(`${port}/tcp\\s+ALLOW`, "i").test(result.out);
	},
	addRule: (port) => spawnTool("ufw", ["allow", `${port}/tcp`]).ok,
	removeRule: (port) => spawnTool("ufw", ["delete", "allow", `${port}/tcp`]).ok
};

const iptablesBackend = {
	label: "iptables",
	available: () => toolAvailable("iptables"),
	ruleExists: (port) => spawnTool("iptables", ["-C", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]).ok,
	addRule: (port) => spawnTool("iptables", ["-A", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]).ok,
	removeRule: (port) => spawnTool("iptables", ["-D", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"]).ok
};

let firewallBackendCache = null;

function firewallBackend() {
	if (firewallBackendCache !== null) return firewallBackendCache;
	let backend = null;
	if (process.platform === "win32") {
		backend = netshBackend;
	} else if (process.platform === "linux") {
		if (firewalldBackend.available()) backend = firewalldBackend;
		else if (ufwBackend.available()) backend = ufwBackend;
		else if (iptablesBackend.available()) backend = iptablesBackend;
	}
	firewallBackendCache = backend;
	return backend;
}

function firewallRuleExists(port) {
	const backend = firewallBackend();
	return backend !== null && backend.ruleExists(port);
}

/**
 * Delete-and-add: recreating the rule is idempotent and locale-proof (netsh
 * output is localized, so parsing the current rule's port is fragile; the
 * Linux backends follow the same recreate pattern).
 */
function ensureFirewallRule(port) {
	const backend = firewallBackend();
	if (backend === null) return true;
	backend.removeRule(port);
	return backend.addRule(port);
}

function removeFirewallRule(port) {
	const backend = firewallBackend();
	if (backend === null) return true;
	return backend.removeRule(port);
}

/**
 * One-time cleanup of the pre-rename rule names. Linux backends match rules by
 * port, not by name, so a renamed rule leaves nothing behind there.
 */
function removeLegacyFirewallRules(log) {
	if (process.platform !== "win32") return;
	for (const ruleName of LEGACY_FIREWALL_RULE_NAMES) {
		if (!ruleExistsByName(ruleName)) continue;
		const removed = spawnTool("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${ruleName}`]).ok;
		log(`migration: legacy firewall rule "${ruleName}" ${removed ? "removed" : "could not be removed (needs admin)"}`);
	}
}

/**
 * Does a Windows port spec ("Any", "19387", "80,443", "8000-8100") cover this
 * port? Pure string work, so it is unit-testable.
 */
function portSpecCovers(spec, port) {
	const wanted = String(port);
	for (const raw of String(spec ?? "").split(",")) {
		const part = raw.trim();
		if (part === "") continue;
		if (part.toLowerCase() === "any") return true;
		if (part === wanted) return true;
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (range !== null && Number(range[1]) <= Number(wanted) && Number(wanted) <= Number(range[2])) return true;
	}
	return false;
}

/** Normalize a Windows path for comparison. */
function sameImage(a, b) {
	const norm = (value) => String(value ?? "").replace(/\//g, "\\").toLowerCase();
	const left = norm(a);
	const right = norm(b);
	if (left === "" || right === "") return false;
	if (left === right) return true;
	// Fall back to the file name: Windows stores the same image under different
	// prefixes (short names, env-var forms) in its own auto-created rules.
	return left.slice(left.lastIndexOf("\\") + 1) === right.slice(right.lastIndexOf("\\") + 1);
}

/**
 * Does one inbound allow rule really admit THIS process on this port?
 *
 * The program test is essential, not decoration: Windows' own "allow this app"
 * dialog creates a PROGRAM-scoped rule with `LocalPort = Any`, and there are
 * plenty of unrelated rules with `Any` ports (measured: 130 inbound allow rules
 * on the author's machine, the first `Any` hit belonged to Wi-Fi Direct). A
 * port-only test would report "open" for anybody.
 */
function ruleAdmitsPort(rule, port, exePath) {
	const protocol = String(rule?.protocol ?? "Any").toUpperCase();
	if (protocol !== "ANY" && protocol !== "TCP") return false;
	if (!portSpecCovers(rule?.port, port)) return false;
	const program = String(rule?.program ?? "").trim();
	if (program === "" || program.toLowerCase() === "any") return true;
	return exePath !== "" && sameImage(program, exePath);
}

/**
 * One PowerShell pass over the inbound allow rules, filtered inside PowerShell
 * (the per-rule join is what costs; a full pass measured ~4s for 130 rules, so
 * this must never run inline in a request). Emits the first rule that admits
 * `Exe` on `Port` as JSON, or nothing.
 */
function windowsAllowScript(port, exePath) {
	const psString = (value) => "'" + String(value).replace(/'/g, "''") + "'";
	return [
		// Windows PowerShell writes its redirected stdout in the console codepage
		// (GBK on a Chinese system), so an allow rule whose DisplayName is Chinese
		// arrived as mojibake ("������ѧУ�˻�") once decoded as UTF-8. Ask for
		// UTF-8 explicitly; sanitizeFirewallNote() is the belt to these braces.
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8",
		"$ErrorActionPreference='Stop'",
		`$Port=${psString(port)}; $Exe=${psString(exePath)}`,
		"foreach ($r in (Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow)) {",
		"  $p = $r | Get-NetFirewallPortFilter",
		"  $proto = [string]$p.Protocol",
		"  if ($proto -ne 'Any' -and $proto -ne 'TCP') { continue }",
		"  $spec = [string]$p.LocalPort",
		"  $covers = $false",
		"  foreach ($part in ($spec -split ',')) {",
		"    $t = $part.Trim()",
		"    if ($t -eq 'Any' -or $t -eq $Port) { $covers = $true; break }",
		"    if ($t -match '^(\\d+)-(\\d+)$' -and [int]$Matches[1] -le [int]$Port -and [int]$Port -le [int]$Matches[2]) { $covers = $true; break }",
		"  }",
		"  if (-not $covers) { continue }",
		"  $a = $r | Get-NetFirewallApplicationFilter",
		"  $prog = [string]$a.Program",
		"  if ($prog -ne '' -and $prog -ne 'Any' -and $prog.ToLower() -ne $Exe.ToLower()) { continue }",
		"  [pscustomobject]@{ name=[string]$r.DisplayName; port=$spec; protocol=$proto; program=$prog } | ConvertTo-Json -Compress",
		"  break",
		"}",
	].join("\n");
}

/**
 * A rule name is shown verbatim in the settings card, so never let a decoding
 * accident reach it: drop replacement characters (the signature of "decoded
 * with the wrong codepage") and control characters, and fall back to a neutral
 * label when nothing legible is left.
 */
function sanitizeFirewallNote(value, fallback) {
	const text = String(value ?? "")
		.replace(/\uFFFD+/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.trim();
	if (text === "") return fallback;
	return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

/** Ask the OS which rule admits this port, or `null` when we cannot tell. */
async function windowsPortAllowed(port) {
	const script = windowsAllowScript(port, process.execPath ?? "");
	const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 60000);
	if (!result.ok) return null;
	const text = result.out.trim();
	if (text === "") return { allowed: false, name: "" };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const rules = Array.isArray(parsed) ? parsed : [parsed];
	for (const rule of rules) {
		// Re-validate in JS: the OS side is a fast filter, this is the verdict.
		if (ruleAdmitsPort(rule, port, String(process.execPath ?? ""))) {
			return { allowed: true, name: String(rule?.name ?? "").trim() };
		}
	}
	return { allowed: false, name: "" };
}

/** One verdict; may spawn processes, so it only ever runs in the background. */
async function probeFirewall(port, enabled) {
	const backend = firewallBackend();
	if (backend === null) {
		return { ok: true, managed: false, note: "no supported firewall detected", source: "none" };
	}
	if (backend.label === "ufw") {
		const exists = await ufwRuleExistsAsync(port);
		return { ok: enabled ? exists : !exists, managed: true, note: backend.label, source: "plugin" };
	}
	const ours = backend.ruleExists(port);
	if (!enabled) return { ok: !ours, managed: true, note: backend.label, source: "plugin" };
	if (ours) return { ok: true, managed: true, note: backend.label, source: "plugin" };
	// Our rule is missing — usually because adding it needs admin. The LAN can
	// still be open: (a) a LAN device already got through, or (b) the user
	// allowed the OS dialog, which creates a rule we do not own.
	if (remotePeerSeenAt > 0 && (lanEnabledAt === 0 || remotePeerSeenAt >= lanEnabledAt)) {
		return { ok: true, managed: false, note: "LAN device admitted", source: "observed" };
	}
	if (process.platform === "win32") {
		const system = await windowsPortAllowed(port);
		if (system !== null && system.allowed) {
			return { ok: true, managed: false, note: sanitizeFirewallNote(system.name, "Windows rule"), source: "system" };
		}
	}
	return { ok: false, managed: true, note: backend.label, source: "plugin" };
}

/** Refresh one cache entry; concurrent refreshes of the same key are coalesced. */
async function refreshFirewallSummary(cacheKey, port, enabled) {
	if (firewallRefreshInFlight.has(cacheKey)) return;
	firewallRefreshInFlight.add(cacheKey);
	try {
		const value = await probeFirewall(port, enabled);
		const stable = value.ok === true && value.source === "plugin";
		if (stable) firewallRecheckAttempts = 0;
		const ttl = stable
			? FIREWALL_TTL_STABLE_MS
			: Math.min(FIREWALL_RECHECK_MAX_MS, FIREWALL_RECHECK_MIN_MS * 2 ** firewallRecheckAttempts);
		firewallSummaryCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
		if (!stable) firewallRecheckAttempts += 1;
	} finally {
		firewallRefreshInFlight.delete(cacheKey);
	}
}

/**
 * Firewall verdict for `/dsh-lan/status`: stale-while-revalidate. No request
 * ever waits on the OS query (a full rule pass is seconds); a stale entry is
 * returned as-is and refreshed in the background with a 10s→60s backoff, which
 * is what lets the card flip to "open" by itself a few seconds after the user
 * clicks Allow in the Windows dialog.
 */
async function firewallSummary(port, enabled) {
	const cacheKey = `${port}:${enabled}`;
	const cached = firewallSummaryCache.get(cacheKey);
	if (cached !== void 0) {
		if (cached.expiresAt <= Date.now()) void refreshFirewallSummary(cacheKey, port, enabled);
		return cached.value;
	}
	await refreshFirewallSummary(cacheKey, port, enabled);
	return firewallSummaryCache.get(cacheKey)?.value ?? { ok: false, managed: true, note: "unknown", source: "plugin" };
}

// ── the managed profile-patch block ────────────────────────────────────────

function escapeRegex(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPatchContent(file) {
	try {
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	} catch {
		return "";
	}
}

function stripBlock(content, begin, end) {
	const pattern = new RegExp(`\\r?\\n?${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\r?\\n?`, "g");
	return content.replace(pattern, "\n");
}

/** Strip every managed block this plugin (or its ancestors) may have written. */
function stripLegacyBlocks(content) {
	let out = content;
	for (const [begin, end] of LEGACY_BLOCKS) out = stripBlock(out, begin, end);
	return out;
}

function hasLegacyBlocks(content) {
	return LEGACY_BLOCKS.some(([begin]) => content.includes(begin));
}

/**
 * A patch file that has become empty must stay a YAML sequence (`[]`), or the
 * loader rejects it; otherwise keep the user's content verbatim.
 */
function tidyPatch(content) {
	const trimmed = content.trim();
	return trimmed === "" ? "[]\n" : `${trimmed}\n`;
}

/**
 * Remove every managed block from the profile patch. v1.5.0: this is the ONLY
 * writer this plugin has for that file — there is no block to compose any more.
 *
 * The old managed block set `webserver.host`, and on DSH 0.2.1-rc.2 no value it
 * could set is both legal and survivable: wildcards are rejected by the schema
 * (and `webserver` is required, so the app will not start), and the desktop
 * shell authenticates against a URL it builds with a hardcoded `127.0.0.1`, so
 * any concrete non-loopback bind breaks its handshake. LAN access therefore
 * comes from lib/lan-proxy.js instead, and this function exists to undo the
 * damage older versions left on disk.
 * @param patchPath - profile patch to clean.
 * @returns whether the file changed.
 */
function clearLanBlock(patchPath = active.patchPath) {
	const content = readPatchContent(patchPath);
	const next = tidyPatch(stripLegacyBlocks(content));
	if (next === content) return false;
	mkdirSync(dirname(patchPath), { recursive: true });
	writeFileSync(patchPath, next);
	return true;
}

/**
 * The LAN port the user pinned, or undefined to follow DSH's own port.
 *
 * Pinning matters because DSH's port is OS-assigned on every launch (the desktop
 * launcher passes `--port 0`), so the LAN URL changes each start — and a page
 * already open on the LAN then reconnects to a dead port for ever ("重新
 * connecting" with the session list still on screen). Pinning belongs HERE, on
 * the plugin's own listener, and not on DSH's: a `webserver` override with a
 * busy port would stop the whole app from starting (see LEGACY_BLOCKS), while a
 * busy LAN port only means "no LAN access" plus a clear line in the card.
 */
function lanPortSetting() {
	const port = readState().lanPort;
	return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

/** The port the LAN door listens on: the pinned one, else DSH's own. */
function lanListenPort(ctx) {
	const pinned = lanPortSetting();
	if (pinned !== undefined) return pinned;
	try {
		return Number.isInteger(ctx?.webServer?.port) ? ctx.webServer.port : 0;
	} catch {
		return 0;
	}
}

/** Desired state: the user's toggle, recorded in the state file. */
function desiredLanOn() {
	return readState()[LAN_STATE_KEY] === true;
}

/** Record the desired state; returns whether it changed. */
function setDesiredLanOn(enabled) {
	const state = readState();
	if ((state[LAN_STATE_KEY] === true) === enabled) return false;
	state[LAN_STATE_KEY] = enabled;
	writeState(state);
	return true;
}

/**
 * Whether a bind address is a loopback literal (127/8 or `::1`, including the
 * IPv4-mapped spelling). This replaces the old `=== "0.0.0.0"` test: the fence
 * must protect any listener that is reachable from off-box, and after 0.2.1 the
 * interesting case is a concrete LAN address rather than the wildcard.
 */
function isLoopbackLiteral(host) {
	const address = normalizeAddress(host);
	if (address === "") return false;
	if (address === "::1") return true;
	return /^127\./.test(address);
}

/** Real state: DSH's own listener is reachable from off-box (not loopback). */function boundToNonLoopback(ctx) {
	try {
		const host = ctx?.webServer?.host;
		return typeof host === "string" && host !== "" && !isLoopbackLiteral(host);
	} catch {
		return false;
	}
}

/**
 * Whether ANYTHING off-box can reach this DSH — the condition that decides
 * whether the request fence must be installed.
 *
 * It is deliberately broader than {@link boundToNonLoopback}: proxied LAN
 * traffic also needs it, and that is not obvious. The proxy only forwards bytes;
 * admission is still DSH's decision, and DSH's own `isTrustedApiRequest` accepts
 * a request only when its Host authority is loopback, the listener's bind
 * address, or a declared `trustedHosts` entry. Proxied requests deliberately
 * keep the browser's `Host` (the LAN authority — see lib/lan-proxy.js), so the
 * official fence rejects every one of them with 403: the page would load while
 * every API call failed. Installing our fence fixes that, because it admits
 * anything whose TCP peer is this machine — and through the proxy that is
 * exactly what a password-checked LAN client looks like.
 *
 * (Missing this is what made 1.5.0 load the GUI over the LAN but 403 all of its
 * RPC; test/lan-proxy-e2e.mjs now compares the local and LAN status of the same
 * paths, so the proxy has to be transparent, not merely reachable.)
 */
function lanDoorOpen(ctx) {
	if (boundToNonLoopback(ctx)) return true;
	return lanProxy !== null && lanProxy.listening();
}

/**
 * "This request really came from the host machine's own browser."
 *
 * Deliberately stricter than {@link isLocalRequest}: through the proxy every LAN
 * client also has a loopback peer, so a peer-only test would let a device that
 * merely knows the password change the password, flip the switch, or read the
 * diagnostics. The proxy stamps what it forwards, so a stamped request is known
 * to be off-box even though its socket says otherwise.
 *
 * Host-only endpoints use this; the *posture* flag in `buildStatus().local` keeps
 * the peer-only meaning on purpose (it drives the client's gate decision, which
 * must not change under this hardening).
 * @param req - request to classify.
 * @returns true only for an unstamped request from this machine.
 */
function isHostOnlyRequest(req) {
	return isLocalRequest(req) && !viaProxy(req);
}

/**
 * One-time upgrade migration (refactor plan §4.8), idempotent by construction:
 *
 * 1. strip every managed block (installer-era, toggle-era, and the pre-1.5.0
 *    LAN block). The profile layer overrides every bundle layer, so a leftover
 *    block keeps overriding the bundle patch forever — and since 0.2.1 a
 *    leftover LAN block is fatal, not just unsafe: its `host: '0.0.0.0'` is
 *    rejected by the `webserver` schema, which is a required row;
 * 2. remove the pre-rename firewall rule names, which no code can reach any
 *    more once `FIREWALL_RULE_NAME` changed.
 *
 * After step 1 the profile patch is back to the official default
 * (127.0.0.1 + gzip). LAN access now lives in this plugin's own proxy, so the
 * desired state comes from the state file rather than from a patch block.
 * NOTE: this runs during plugin activation, which cannot happen while the
 * webserver row is failing to activate — a profile that is already bricked by a
 * leftover block needs the manual step documented in README once.
 */
function migrateLegacy(ctx, log) {
	let migrated = false;
	const content = readPatchContent(active.patchPath);
	if (hasLegacyBlocks(content)) {
		const stripped = stripLegacyBlocks(content);
		if (stripped !== content) {
			mkdirSync(dirname(active.patchPath), { recursive: true });
			writeFileSync(active.patchPath, tidyPatch(stripped));
			migrated = true;
			log(`migration: removed a managed block from ${active.patchPath} — on DSH 0.2.1 a leftover LAN block's wildcard bind makes the app refuse to start, so it is stripped on sight`);
		}
	}
	const state = readState();
	if (state.legacyCleanupDone !== true) {
		removeLegacyFirewallRules(log);
		state.legacyCleanupDone = true;
		writeState(state);
	}
	return migrated;
}

// ── request fence ──────────────────────────────────────────────────────────

// Every connection instance ever wrapped (the tree recreates the service a
// number of times during boot composition; each gets its own wrapper pair).
const fenceWraps = new Set();
let fenceInstallLogged = false;
/**
 * The LAN proxy of the CURRENT apply() (v1.5.0). The LAN door is this plugin's
 * own listener now, so "is LAN on?" is "is this listening?" — and its `admit()`
 * closure is the gate, which is why dispose() must close it immediately rather
 * than leaving it for the 8-second removal timer.
 */
let lanProxy = null;

function enforcementState(ctx) {
	const exposed = boundToNonLoopback(ctx);
	const proxied = lanProxy !== null && lanProxy.listening();
	if (!exposed && !proxied) return "off";
	try {
		const connection = typeof ctx?.get === "function" ? ctx.get("connection") : void 0;
		// Both doors need the fence: the proxy's gate is its own admit(), but DSH's
		// trust funnel still has to accept the LAN authority for the API to answer
		// (see patchedIsTrusted). A recomposition can drop the patch either way.
		return fenceInstalled(connection) ? "full" : "degraded";
	} catch {
		return "degraded";
	}
}

/**
 * Last distinct (host, peer) pairs the fence judged, for diagnosis. "Why did the
 * gate fire on MY machine?" used to be unanswerable without guessing which name
 * the desktop window used; now the host reads it back from /dsh-lan/status.
 * Host-machine eyes only (the status payload hides it from LAN devices).
 */
const seenRequestHosts = new Map();
function noteRequestHost(req, local) {
	// A peer that is NOT this machine got a request through, which by itself
	// proves the firewall admits LAN traffic on this port — the cheapest possible
	// "the LAN really works" signal for the settings card.
	if (local !== true) remotePeerSeenAt = Date.now();
	const key = `${hostnameOf(req) || "(no host)"} · peer=${normalizeAddress(req.socket?.remoteAddress) || "unknown"}`;
	const entry = seenRequestHosts.get(key);
	if (entry === void 0 && seenRequestHosts.size >= 12) return; // keep the first dozen
	seenRequestHosts.set(key, { local, count: (entry?.count ?? 0) + 1, at: Date.now() });
}

/**
 * Warn once when the browser half and the node half disagree: the app is running
 * a stale copy (usually "installed but never restarted"), which is exactly the
 * state that made 1.4.1 look broken.
 */
let clientVersionSeen = null;
function noteClientVersion(req, log) {
	const client = String(req.headers?.["x-dsh-lan-client"] ?? "");
	if (client === "" || client === clientVersionSeen) return;
	clientVersionSeen = client;
	if (client !== PLUGIN_VERSION) {
		log(`WARNING: browser half is ${client} but the node half is ${PLUGIN_VERSION} — the app is running a stale copy; fully quit and restart the desktop app`);
	}
}

/**
 * One line per distinct (peer, host) the password gate refuses. 1.4.0 locked
 * the host machine out of its own GUI silently — with this line the next
 * occurrence names the exact peer/host that was judged non-local.
 */
const gateRefusalLog = new Set();
function noteGateRefusal(log, req, why) {
	if (typeof log !== "function") return;
	const peer = normalizeAddress(req.socket?.remoteAddress) || "unknown";
	const host = hostnameOf(req) || "(no host)";
	const key = `${peer}|${host}`;
	if (gateRefusalLog.has(key)) return;
	if (gateRefusalLog.size > 32) gateRefusalLog.clear();
	gateRefusalLog.add(key);
	log(`password gate: ${why} — peer=${peer} is not an address of this machine (host=${host})`);
}

/**
 * LAN password fence over DSH's own trust checks (runtime patch, no DSH files
 * touched). While the socket is bound to every interface, non-loopback
 * requests additionally require the dsh-lan-tool password; loopback requests
 * are fully open (no password, no DSH token). While LAN access is off the
 * patched functions delegate to the official ones, so DSH behaves as stock.
 *
 * The decision keys on the REAL bind host, never on the patch file: if the
 * socket is exposed, the password gate is up — even in the window where the
 * file already says "off" but the hot reload has not re-bound yet.
 */
function ensureFencePatched(ctx, log) {
	const connection = ctx.get("connection");
	if (connection === void 0 || typeof connection.requestRejection !== "function") return false;
	const browserAuth = connection.browserAuth;
	if (browserAuth === void 0 || typeof browserAuth.authorizeIndex !== "function") return false;
	for (const wrap of fenceWraps) {
		// Both identities matter: re-patching an already-patched authorizeIndex
		// would capture patchedAuthorize as its "original" and nest the
		// delegation. Today cordis rebuilds the pair together, so this is a
		// guard against a future where it does not.
		if (wrap.connection === connection && wrap.browserAuth === browserAuth) return true;
	}
	const origRequestRejection = connection.requestRejection;
	const origAuthorizeIndex = browserAuth.authorizeIndex;
	const origIsTrusted = typeof connection.isTrusted === "function" ? connection.isTrusted : null;
	const patchedRejection = (req) => {
		// Decision 1: the host machine is fully open (no password, no DSH token).
		const local = isLocalRequest(req);
		noteRequestHost(req, local);
		if (local) return undefined;
		// Not exposed: DSH default (fence + official browser session).
		if (!lanDoorOpen(ctx)) return origRequestRejection.call(connection, req);
		// Exposed: the dsh-lan-tool password replaces the DSH token.
		if (hasLanCredential(req)) return undefined;
		noteGateRefusal(log, req, "request refused");
		return 403;
	};
	patchedRejection.__dshLanPatched = true;
	/**
	 * Decision 0 — the trust funnel, and the one that actually matters on 0.2.1.
	 *
	 * `connection.admit()` starts with `isTrusted()`, which is
	 * `isTrustedApiRequest(request, trustedHosts, bindHost, protocol)`: a Host
	 * authority is accepted only when it is loopback, the listener's own bind
	 * address, or a declared `trustedHosts` entry. The API is admitted through
	 * exactly that path (`dsh-api-gateway` → `connection.admitConnection()` →
	 * `admit()`), and 1.4.x only ever patched `requestRejection` — which on
	 * 0.2.1 only two unrelated plugins call. So a request our proxy forwards,
	 * which deliberately keeps the browser's LAN authority, was rejected with
	 * 403 before any password or session check: 1.5.0 served the GUI over the
	 * LAN while every single API call failed.
	 *
	 * The allowance is deliberately narrow: only a request whose TCP peer is
	 * this machine — the host itself, or our own proxy forwarding an already
	 * password-checked client — and only while a LAN door is open. Everything
	 * else keeps DSH's rule, and `admit()` still demands the browser session
	 * that the mint flow hands out.
	 */
	const patchedIsTrusted = origIsTrusted === null ? null : function (req) {
		const local = isLocalRequest(req);
		noteRequestHost(req, local);
		if (local && lanDoorOpen(ctx)) return true;
		return origIsTrusted.call(connection, req);
	};
	if (patchedIsTrusted !== null) patchedIsTrusted.__dshLanPatched = true;
	/**
	 * Decision −1 — admission itself, and the one the event stream really uses.
	 *
	 * `admit()` is reached by `admitConnection()` (the API gateway's WebSocket
	 * upgrade) and by the fetch routes. Beyond the trust funnel it REQUIRES DSH's
	 * own browser session, and that cookie's name is derived from `Host:port`
	 * (`requestAudience` → `cookieName`). DSH used to pick a new port on every
	 * launch, so a browser that authenticated against an earlier port holds a cookie
	 * that can never match again — and a perfectly good LAN client then sits on 401
	 * for ever: the page loads and HTTP keeps working (the fence admits local peers)
	 * while the event stream reconnects endlessly. That is exactly "the page opens
	 * but the conversation never loads", and it is what the machine log showed:
	 * `upgrade-open … cookie=true` followed by `HTTP/1.1 401 Unauthorized`.
	 *
	 * So a local request carrying this plugin's password credential is admitted the
	 * way DSH admits an authenticated browser — `{ peer: browserPeer }`, the very
	 * object its own `isAuthenticated` branch returns. The password IS this plugin's
	 * credential by design, and the proxy has already verified it before anything
	 * reaches here.
	 */
	const origAdmit = typeof connection.admit === "function" ? connection.admit : null;
	const patchedAdmit = origAdmit === null ? null : function (req) {
		const local = isLocalRequest(req);
		noteRequestHost(req, local);
		if (local && lanDoorOpen(ctx) && hasLanCredential(req)) return { peer: connection.browserPeer };
		return origAdmit.call(connection, req);
	};
	if (patchedAdmit !== null) patchedAdmit.__dshLanPatched = true;
	const patchedAuthorize = (req, res) => {
		// Decision 1: the host machine is fully open.
		const local = isLocalRequest(req);
		noteRequestHost(req, local);
		const requestUrl = new URL(req.url ?? "/", "http://x");
		if (local) {
			// Exposed: DSH's launch-token exchange is the desktop shell's ONLY
			// pre-boot handshake. Short-circuiting it hands the shell a 200 where
			// it demands a 303 + Set-Cookie, so the desktop app cannot start
			// (`Desktop Host authentication failed`). Carrying the process token
			// IS being the host: let DSH's own rule decide (valid token → 303 +
			// cookie, anything else → 401). No password is skipped here — that
			// gate is requestRejection, which never delegated by host anyway.
			if (req.method === "GET" && requestUrl.pathname === "/" && requestUrl.searchParams.has("token")) {
				return origAuthorizeIndex.call(browserAuth, req, res);
			}
			return true;
		}
		// Not exposed: DSH default (token still required).
		if (!boundToNonLoopback(ctx)) return origAuthorizeIndex.call(browserAuth, req, res);
		if (req.method === "GET" && requestUrl.pathname === "/") {
			// Password holders delegate to DSH (landing flow mints its cookie first).
			if (hasLanCookie(req)) return origAuthorizeIndex.call(browserAuth, req, res);
			// Decision 3: bare / without credential goes to the landing page.
			noteGateRefusal(log, req, "landing redirect");
			res.writeHead(302, { location: "/dsh-lan/", "cache-control": "no-store" });
			res.end();
			return false;
		}
		return origAuthorizeIndex.call(browserAuth, req, res);
	};
	patchedAuthorize.__dshLanPatched = true;
	connection.requestRejection = patchedRejection;
	if (patchedIsTrusted !== null) connection.isTrusted = patchedIsTrusted;
	if (patchedAdmit !== null) connection.admit = patchedAdmit;
	browserAuth.authorizeIndex = patchedAuthorize;
	fenceWraps.add({ connection, browserAuth, origRequestRejection, origAuthorizeIndex, origIsTrusted, origAdmit });
	if (!fenceInstallLogged && typeof log === "function") {
		fenceInstallLogged = true;
		log("LAN password fence installed");
	}
	return true;
}

function removeFencePatch(ctx, log) {
	if (fenceWraps.size === 0) return;
	for (const wrap of fenceWraps) {
		try {
			if (wrap.connection.requestRejection?.__dshLanPatched === true) {
				wrap.connection.requestRejection = wrap.origRequestRejection;
			}
		} catch {}
		try {
			// Only restore when we actually replaced it: on a DSH whose connection
			// has no `isTrusted`, `origIsTrusted` is null and the property must be
			// left alone.
			if (wrap.origIsTrusted !== null && wrap.connection.isTrusted?.__dshLanPatched === true) {
				wrap.connection.isTrusted = wrap.origIsTrusted;
			}
		} catch {}
		try {
			if (wrap.browserAuth.authorizeIndex?.__dshLanPatched === true) {
				wrap.browserAuth.authorizeIndex = wrap.origAuthorizeIndex;
			}
		} catch {}
		try {
			if (wrap.origAdmit !== null && wrap.connection.admit?.__dshLanPatched === true) {
				wrap.connection.admit = wrap.origAdmit;
			}
		} catch {}
	}
	fenceWraps.clear();
	fenceInstallLogged = false;
	if (typeof log === "function") log("LAN password fence removed");
}

/**
 * Whether the fence is fully in place: the rejection gate, the trust funnel and
 * the admission itself. A DSH whose connection lacks `isTrusted`/`admit` (older
 * than 0.2.1) only needs what it has.
 */
function fenceInstalled(connection) {
	try {
		if (connection?.requestRejection?.__dshLanPatched !== true) return false;
		if (typeof connection.isTrusted === "function" && connection.isTrusted.__dshLanPatched !== true) return false;
		if (typeof connection.admit === "function" && connection.admit.__dshLanPatched !== true) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Keep the firewall, the fence and the LAN proxy aligned with the DESIRED state.
 *
 * Two doors can be open and each has its own gate:
 * - OUR proxy (the supported path since v1.5.0): its `admit()` checks the
 *   password;
 * - a DIRECT non-loopback bind of DSH's listener (a `dsh web --host <ip>`
 *   deployment, or a hand-written override): the request fence is the gate.
 *
 * The fence is installed for BOTH: proxied requests keep the LAN Host authority,
 * and DSH's trust funnel rejects a non-loopback authority, so without the fence
 * the API answers 403 even though the proxy let the client in.
 */
function syncEnforcement(ctx, log) {
	// The firewall must admit the port LAN devices actually connect to — the
	// plugin's listener, which is DSH's port only while nothing is pinned.
	const port = lanListenPort(ctx);
	if (desiredLanOn() && port > 0) {
		if (lanEnabledAt === 0) lanEnabledAt = Date.now();
		if (lanProxy !== null) void lanProxy.refresh();
		if (!ensureFirewallRule(port) && !firewallFailureLogged) {
			firewallFailureLogged = true;
			log("firewall: could not create the rule (needs admin) — Windows asks once when the port opens, and the settings card picks the resulting system rule up on its own");
		}
	} else {
		lanEnabledAt = 0;
		remotePeerSeenAt = 0;
		if (port > 0) removeFirewallRule(port);
	}
	if (lanDoorOpen(ctx)) {
		if (!ensureFencePatched(ctx, log)) log("WARNING: LAN fence patch failed, enforcement degraded");
	} else {
		removeFencePatch(ctx, log);
	}
}

// ── deactivation cleanup ───────────────────────────────────────────────────
// Removing the package (or disabling the row) takes the password gate with it,
// so nothing may keep serving LAN traffic: dispose() closes the proxy at once.
// Two leftovers need a little longer, because a hot reload disposes this row and
// immediately re-applies it (cleaning up on every dispose would fight the on/off
// switch): the firewall rule and any managed block an older version wrote into
// the PROFILE PATCH, which is not part of the package and would outlive it.
// A real removal never re-applies: wait out a generous window (far longer than
// any reload) and only then tidy up. Every failure mode of this timer is
// "LAN ends up closed", never "LAN ends up open".
const DISPOSE_CLEANUP_DELAY_MS = 8000;
let applyGeneration = 0;
let disposeCleanupTimer = null;

function scheduleDisposalCleanup(ctx, log) {
	const generation = applyGeneration;
	const patchPath = active.patchPath; // captured: a later apply may have moved on
	const port = Number.isInteger(ctx?.webServer?.port) ? ctx.webServer.port : 0;
	disposeCleanupTimer = setTimeout(() => {
		disposeCleanupTimer = null;
		if (generation !== applyGeneration) return; // re-applied: a reload, not a removal
		try {
			if (clearLanBlock(patchPath)) {
				log(`deactivated (not reloaded): removed a leftover managed block from ${patchPath}`);
			}
			if (port > 0) removeFirewallRule(port);
		} catch (error) {
			log("WARNING: deactivation cleanup failed:", String(error?.message ?? error));
		}
	}, DISPOSE_CLEANUP_DELAY_MS);
	if (typeof disposeCleanupTimer?.unref === "function") disposeCleanupTimer.unref();
}

/**
 * Self-healing hook for request handlers: the connection service can be
 * recreated by a recomposition (which drops the monkey patch) between the
 * service event and the next request, so every endpoint we serve re-asserts the
 * fence whenever a LAN door is open. Cheap: one Set scan.
 */
function ensureFenceIfExposed(ctx, log) {
	if (lanDoorOpen(ctx)) ensureFencePatched(ctx, log);
}

/**
 * The password gate for PROXIED LAN traffic (v1.5.0).
 *
 * DSH cannot gate it for us: the proxy connects from 127.0.0.1, and DSH's peer
 * test then correctly concludes "the host machine", which is exactly what the
 * old fence keyed on. So the proxy asks this before forwarding anything, and the
 * proxy itself is the only way in from off-box (DSH stays on loopback).
 *
 * A request is admitted when it
 * - addresses `/dsh-lan/*`, where a password is exchanged for a credential and
 *   which rate-limit and verify the password themselves, or
 * - is the launch-token exchange (`GET /` carrying `token`) — the mint flow
 *   hands the browser exactly this URL, and DSH answers 303 for a valid token
 *   and 401 for anything else. Carrying the process token IS the credential, the
 *   same rule the host-side fence applies (see the 1.4.5 note in §3.6), and it
 *   keeps the flow working when a browser drops the LAN cookie, or
 * - carries the LAN credential (the browser half's header / the landing page's
 *   cookie), or
 * - already holds DSH's browser session cookie for THIS authority — which is
 *   what the mint flow ends up handing the browser.
 * @param ctx - plugin context carrying the connection service.
 * @returns the admission predicate.
 */
function makeLanAdmit(ctx) {
	return (req) => {
		let url;
		try {
			url = new URL(req.url ?? "/", "http://x");
		} catch {
			return false;
		}
		if (url.pathname.startsWith("/dsh-lan/")) return true;
		if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) return true;
		if (hasLanCredential(req)) return true;
		try {
			const connection = ctx.get("connection");
			const auth = connection?.browserAuth;
			// `secure` is false: the proxy serves plain HTTP (the desktop listener
			// it forwards to is plain HTTP too — DSH's TLS flag is per-invocation).
			if (auth !== undefined && typeof auth.isAuthenticated === "function" && auth.isAuthenticated(req, false) === true) return true;
		} catch {}
		return false;
	};
}

async function buildStatus(ctx, config, req) {
	const state = readState();
	/**
	 * Real state since v1.5.0: OUR proxy is listening. DSH's own listener can no
	 * longer be the LAN door — 0.2.1 rejects wildcard binds, and the desktop shell
	 * authenticates against a hardcoded 127.0.0.1, so any other bind breaks its
	 * startup handshake. The proxy reuses the DSH port on each LAN address.
	 *
	 * "LAN on" therefore has TWO forms and either one counts:
	 * - our proxy is listening (the supported path since v1.5.0);
	 * - DSH's own listener is bound to a non-loopback address (a deliberate
	 *   `dsh web --host <ip>` deployment, or a hand-written override), where the
	 *   request fence is the gate.
	 */
	const proxied = lanProxy !== null && lanProxy.listening();
	const exposed = boundToNonLoopback(ctx);
	const enabled = proxied || exposed;
	const desired = desiredLanOn();
	const port = ctx.webServer.port;
	/** The port LAN devices connect to (pinned, or DSH's own). */
	const lanPort = lanListenPort(ctx);
	const passwordSet = typeof state.passwordHash === "string";
	/**
	 * Host detail is host-only. A LAN device needs to know whether a password
	 * exists at all (the landing page says so instead of offering a form that
	 * cannot succeed) and what the switch state is — not this machine's
	 * filesystem paths and interface addresses.
	 */
	const local = isLocalRequest(req);
	/**
	 * Whether this request may CHANGE anything (v1.5.5). `local` says "the socket
	 * comes from this machine", which is also true for a LAN client the proxy
	 * forwards; `hostOnly` additionally requires that the proxy did not stamp it.
	 * The card uses it to decide whether to render the mutating controls, so a LAN
	 * device sees the state but cannot flip the switch or change the password.
	 */
	const hostOnly = isHostOnlyRequest(req);
	const firewall = local ? await firewallSummary(lanPort, enabled) : { ok: false, managed: false, note: "" };
	return {
		ok: true,
		/**
		 * Peer-verified: this request came from the host machine itself. This is
		 * the flag clients must use to decide "am I the host?" (the password
		 * gate, the posture classes and the settings card all key on it).
		 */
		local,
		/**
		 * Whether this page may change the plugin's own settings (v1.5.5). A LAN
		 * client the proxy forwarded is `local` (loopback peer) but NOT `hostOnly`,
		 * so the card renders its state read-only for it.
		 */
		hostOnly,
		/** Display only: the page was opened through a loopback NAME. */
		loopback: isLoopback(req),
		/** Real state: something on this machine is reachable from the LAN. */
		enabled,
		/** Desired state: the toggle recorded in the state file. */
		desiredEnabled: desired,
		/**
		 * The toggle moved but the proxy has not caught up. Deliberately compares
		 * the toggle against the PROXY only: an operator-exposed direct bind is
		 * not something the switch is waiting on.
		 */
		applying: desired !== proxied,
		/** DSH's own bind address — informational; the LAN door is the proxy. */
		bindHost: ctx.webServer.host,
		port,
		passwordSet,
		passwordVersion: typeof state.passwordVersion === "number" ? state.passwordVersion : 0,
		/** K5: exposed but nobody can get in — the card must not stay silent. */
		warning: enabled && !passwordSet ? "no-password" : null,
		/** Node-half version: the browser half compares it with its own copy. */
		version: PLUGIN_VERSION,
		...(local
			? {
					profile: active.profile,
					patchFile: active.patchPath,
					/** v1.5.0: LAN is served by this plugin's proxy, not by a bind override. */
					proxied: true,
					/** The port LAN devices use; null means "follow DSH". */
					lanPort: lanPortSetting() ?? null,
					/** The port those URLs actually contain. */
					lanPortEffective: lanPort,
					lanUrls: proxied ? lanProxy.addresses().map((ip) => `http://${ip}:${lanPort}`) : [],
					firewallOk: firewall.ok,
					firewallManaged: firewall.managed,
					firewallNote: firewall.note,
					/** plugin | system | observed | none — drives the card's wording. */
					firewallSource: firewall.source,
					enforcement: enforcementState(ctx),
					platform: process.platform,
					/** Diagnosis: which names/peers the fence has judged so far. */
					seenHosts: [...seenRequestHosts.entries()].map(([request, entry]) => ({ request, local: entry.local, count: entry.count }))
				}
			: { lanUrls: [] })
	};
}

function sendJson(res, status, value) {
	const body = Buffer.from(JSON.stringify(value));
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	res.end(body);
}

function sendText(res, status, text) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(text);
}

async function readJsonBody(req, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) return { tooLarge: true };
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return { value: {} };
	try {
		return { value: JSON.parse(text) };
	} catch {
		return { invalid: true };
	}
}

/** Standalone password landing page (no app shell, no dependencies). */
let landingHtmlCache = null;
function landingHtml() {
	if (landingHtmlCache !== null) return landingHtmlCache;
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		landingHtmlCache = readFileSync(join(here, "landing.html"), "utf8");
	} catch {
		landingHtmlCache = "<!doctype html><html><body>dsh-lan-tool landing page missing</body></html>";
	}
	return landingHtmlCache;
}

/**
 * /lanapi proxy: password-gated re-entry into the in-process API gateway.
 *
 * NOTE (refactor plan §4.5): 0.2.0 has no method-specific loopback tier, so
 * this channel is an optional simplification — privileged methods work over
 * plain `/api` once the fence admits the caller. Removing it needs an
 * end-to-end LAN verification of every official surface that routes through
 * it, so it is kept until that run happens. It is password-gated and
 * loopback-open, exactly like before.
 */
async function handleProxy(ctx, req, res) {
	if (!isLocalRequest(req) && !hasLanCredential(req)) {
		sendText(res, 403, "forbidden: dsh-lan key required");
		return;
	}
	const connection = ctx.get("connection");
	if (connection === void 0 || typeof connection.createSharedFetchHandler !== "function") {
		sendText(res, 503, "api proxy unavailable");
		return;
	}
	const raw = req.url ?? "/";
	const qIndex = raw.indexOf("?");
	const suffix = qIndex === -1 ? raw : raw.slice(0, qIndex);
	const query = qIndex === -1 ? "" : raw.slice(qIndex);
	if (!suffix.startsWith("/lanapi/")) {
		sendText(res, 404, "not found");
		return;
	}
	const rewritten = `/api${suffix.slice("/lanapi".length)}${query}`;
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_PROXY_BODY_BYTES) {
			sendText(res, 413, "payload too large");
			return;
		}
		chunks.push(chunk);
	}
	const body = Buffer.concat(chunks);
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === void 0) continue;
		if (key === "content-length" || key === "x-dsh-lan-key") continue;
		headers[key] = Array.isArray(value) ? value.join(", ") : value;
	}
	let fetchResponse;
	try {
		const request = new Request(`http://127.0.0.1:${ctx.webServer.port}${rewritten}`, {
			method: req.method,
			headers,
			...(body.length === 0 ? {} : { body, duplex: "half" })
		});
		fetchResponse = await connection.createSharedFetchHandler("/api").fetch(request);
	} catch (error) {
		sendText(res, 500, `proxy failure: ${String(error?.message ?? error)}`);
		return;
	}
	try {
		for (const [key, value] of fetchResponse.headers) res.setHeader(key, value);
		res.writeHead(fetchResponse.status);
		res.end(Buffer.from(await fetchResponse.arrayBuffer()));
	} catch (error) {
		sendText(res, 500, `proxy response failure: ${String(error?.message ?? error)}`);
	}
}

function apply(ctx, config = {}) {
	applyGeneration += 1;
	if (disposeCleanupTimer !== null) {
		clearTimeout(disposeCleanupTimer);
		disposeCleanupTimer = null;
	}
	active = profileOf(ctx, config);
	const log = (...args) => console.log("[dsh-lan-tool]", ...args);
	// Defensive: when the webserver row itself failed to activate (a leftover
	// wildcard override does exactly that on 0.2.1), reading its config here
	// would throw and hide the real reason behind a second, misleading error.
	const bindLabel = (() => {
		try {
			return `${ctx.webServer.host}:${String(ctx.webServer.port)}`;
		} catch {
			return "unknown (webServer unavailable)";
		}
	})();
	log(`activated (profile=${active.profile}, bind=${bindLabel})`);

	// Upgrade path first: a leftover managed block must be gone before anything
	// reads state — on 0.2.1 a leftover LAN block's wildcard host makes the
	// required `webserver` row fail, and then this plugin never loads at all.
	try {
		migrateLegacy(ctx, log);
	} catch (error) {
		log("WARNING: profile migration failed:", String(error?.message ?? error));
	}

	// ── v1.5.0: the LAN door is THIS plugin's reverse proxy ────────────────
	// DSH keeps listening on 127.0.0.1. It has to: 0.2.1's schema rejects
	// wildcard binds (and `webserver` is required, so the app would not start),
	// while the desktop shell authenticates against a URL it builds with a
	// hardcoded 127.0.0.1 (measured: binding anything else makes that fetch fail
	// with ECONNREFUSED). So the proxy accepts on this machine's LAN addresses
	// and forwards to the loopback listener, reusing its port number.
	const proxy = createLanProxy({
		target: () => {
			let port;
			try {
				port = ctx.webServer.port;
			} catch {
				return undefined;
			}
			return Number.isInteger(port) && port > 0 ? { host: LOOPBACK, port } : undefined;
		},
		admit: makeLanAdmit(ctx),
		listenPort: lanPortSetting,
		log
	});
	lanProxy = proxy;
	// `refresh()` binds asynchronously, so the fence is (re)asserted AFTER it
	// resolves: `lanDoorOpen()` is false until the proxy is actually listening,
	// and without the fence DSH's own fence 403s every proxied API call.
	if (desiredLanOn()) void proxy.refresh().then(() => ensureFenceIfExposed(ctx, log)).catch(() => {});
	// Interfaces come and go (Wi-Fi toggles, VPN, DHCP lease changes), so the
	// bound set is re-checked periodically — but only while the toggle is on,
	// because `refresh()` re-arms a proxy that `stop()` closed. The same tick
	// re-asserts the fence, which a recomposition can silently drop.
	const proxyTimer = setInterval(() => {
		if (!desiredLanOn()) return;
		void proxy.refresh().then(() => ensureFenceIfExposed(ctx, log)).catch(() => {});
	}, PROXY_REFRESH_MS);
	if (typeof proxyTimer?.unref === "function") proxyTimer.unref();

	const statusRoute = {
		kind: "exact",
		path: "/dsh-lan/status",
		handler: async (req, res) => {
			ensureFenceIfExposed(ctx, log);
			noteRequestHost(req, isLocalRequest(req));
			noteClientVersion(req, log);
			sendJson(res, 200, await buildStatus(ctx, config, req));
		}
	};

	const configureRoute = {
		kind: "exact",
		path: "/dsh-lan/configure",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "POST required" });
				return;
			}
			if (!isHostOnlyRequest(req)) {
				sendJson(res, 403, { ok: false, error: "configure is host-only" });
				return;
			}
			const parsed = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
			if (parsed.tooLarge) {
				sendJson(res, 413, { ok: false, error: "payload too large" });
				return;
			}
			if (parsed.invalid) {
				sendJson(res, 400, { ok: false, error: "invalid JSON" });
				return;
			}
			const body = parsed.value ?? {};
			const state = readState();
			if (Object.prototype.hasOwnProperty.call(body, "password")) {
				const password = body.password;
				if (password === null || password === "") {
					delete state.passwordHash;
					delete state.salt;
					bumpPasswordVersion(state);
					writeState(state);
				} else if (typeof password === "string") {
					if (password.length < 4) {
						sendJson(res, 400, { ok: false, error: "password too short (min 4)" });
						return;
					}
					state.salt = randomBytes(16).toString("hex");
					state.passwordHash = hashPassword(password, state.salt);
					bumpPasswordVersion(state);
					writeState(state);
				} else {
					sendJson(res, 400, { ok: false, error: "password must be a string or null" });
					return;
				}
			}
			if (Object.prototype.hasOwnProperty.call(body, "lanPort")) {
				// null (or 0 / "") means "follow DSH's port"; a number pins it.
				const requested = body.lanPort;
				const clears = requested === null || requested === 0 || requested === "";
				if (clears) {
					delete state.lanPort;
					writeState(state);
				} else if (Number.isInteger(requested) && requested >= 1024 && requested <= 65535) {
					state.lanPort = requested;
					writeState(state);
				} else {
					sendJson(res, 400, { ok: false, error: "lanPort must be null or an integer between 1024 and 65535" });
					return;
				}
				// Rebind now: the proxy closes listeners bound to the old port and
				// opens the new one on the next refresh.
				if (lanProxy !== null && desiredLanOn()) {
					lanProxy.stop();
					void lanProxy.refresh().then(() => syncEnforcement(ctx, log)).catch(() => {});
				}
			}
			if (typeof body.enabled === "boolean") {
				// v1.5.0: the toggle no longer writes a `webserver` override. It
				// records the desire and opens/closes OUR proxy instead — see the
				// LEGACY_BLOCKS note for why no override may be written on 0.2.1.
				const changed = setDesiredLanOn(body.enabled);
				// A missing password makes the LAN unusable (the proxy refuses
				// everything without it); the card warns about that state rather
				// than silently exposing a door nobody can open.
				const passwordSet = typeof readState().passwordHash === "string";
				if (body.enabled) {
					// Same bookkeeping as syncEnforcement: remember when LAN went
					// on (the card's "a LAN device got through" evidence window)
					// and say out loud when the rule needs admin rights, because
					// the OS dialog that follows is expected, not a failure.
					if (lanEnabledAt === 0) lanEnabledAt = Date.now();
					firewallSummaryCache.clear();
					firewallRecheckAttempts = 0;
					// Open the listeners and settle the firewall/fence AFTER replying.
					// Awaiting it here (1.5.0/1.5.1) made the response describe an
					// already-settled state, so `applying` was false and the card's
					// green "正在生效…" line — the one 1.4.6 added on purpose — could
					// never appear. Replying first restores that line, and the card
					// polls a moment later for the settled state.
					if (lanProxy !== null) {
						void lanProxy.refresh()
							.then((bound) => {
								log(`LAN proxy listening on ${bound.length > 0 ? bound.map((ip) => `${ip}:${String(lanProxy.port())}`).join(", ") : "(no LAN interface found)"}`);
								syncEnforcement(ctx, log);
							})
							.catch(() => {});
					} else {
						syncEnforcement(ctx, log);
					}
				} else {
					lanEnabledAt = 0;
					remotePeerSeenAt = 0;
					firewallSummaryCache.clear();
					firewallRecheckAttempts = 0;
					// Closing is immediate — that is the security switch — so this
					// direction settles before the reply and shows no pending line.
					if (lanProxy !== null) lanProxy.stop();
					syncEnforcement(ctx, log);
				}
				log(`LAN ${body.enabled ? "enabled" : "disabled"} (${changed ? "state updated" : "state already set"}; password ${passwordSet ? "set" : "NOT set"})`);
			}
			sendJson(res, 200, await buildStatus(ctx, config, req));
		}
	};

	const unlockRoute = {
		kind: "exact",
		path: "/dsh-lan/unlock",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false });
				return;
			}
			ensureFenceIfExposed(ctx, log);
			if (!unlockAllowed(req)) {
				sendJson(res, 429, { ok: false, error: "too many attempts, try later" });
				return;
			}
			const parsed = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
			if (parsed.invalid || parsed.tooLarge) {
				sendJson(res, 400, { ok: false });
				return;
			}
			const candidate = parsed.value?.password;
			if (typeof candidate !== "string") {
				sendJson(res, 400, { ok: false });
				return;
			}
			const ok = passwordMatches(readState(), candidate);
			if (ok) resetUnlock(req);
			else recordUnlockFail(req);
			sendJson(res, 200, { ok });
		}
	};

	const mintRoute = {
		kind: "exact",
		path: "/dsh-lan/mint",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false });
				return;
			}
			ensureFenceIfExposed(ctx, log);
			if (!unlockAllowed(req)) {
				sendJson(res, 429, { ok: false, error: "too many attempts, try later" });
				return;
			}
			const parsed = await readJsonBody(req, MAX_CONFIG_BODY_BYTES);
			const candidate = parsed.value?.password;
			if (parsed.invalid || parsed.tooLarge || typeof candidate !== "string") {
				sendJson(res, 400, { ok: false });
				return;
			}
			if (!passwordMatches(readState(), candidate)) {
				recordUnlockFail(req);
				sendJson(res, 403, { ok: false });
				return;
			}
			resetUnlock(req);
			const connection = ctx.get("connection");
			if (connection === void 0 || typeof connection.authenticatedUrl !== "function") {
				sendText(res, 503, "mint unavailable");
				return;
			}
			const authority = String(req.headers.host ?? `127.0.0.1:${ctx.webServer.port}`);
			const target = connection.authenticatedUrl(`http://${authority}/`);
			res.writeHead(302, { location: target, "cache-control": "no-store" });
			res.end();
		}
	};

	const landingRoute = {
		kind: "exact",
		path: "/dsh-lan/",
		handler: (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				sendText(res, 405, "method not allowed");
				return;
			}
			ensureFenceIfExposed(ctx, log);
			const body = Buffer.from(landingHtml(), "utf8");
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": String(body.length),
				"cache-control": "no-store"
			});
			res.end(req.method === "HEAD" ? void 0 : body);
		}
	};

	const proxyRoute = {
		kind: "prefix",
		path: "/lanapi",
		handler: (req, res) => {
			void handleProxy(ctx, req, res);
		}
	};

	/**
	 * Host-only diagnosis of the LAN door (v1.5.3).
	 *
	 * "The page opens but the conversation never connects" cannot be answered from
	 * the outside: HTTP succeeding says nothing about the event-stream upgrade, and
	 * the LAN client's own console is not reachable from here. So the proxy keeps a
	 * tiny decision log and this exposes it on loopback only — enough to tell
	 * "the upgrade never arrived", "it arrived without any credential" (a browser
	 * that omits cookies on the WebSocket handshake) and "DSH refused it" apart.
	 */
	const diagRoute = {
		kind: "exact",
		path: "/dsh-lan/diag",
		handler: (req, res) => {
			if (!isHostOnlyRequest(req)) {
				sendJson(res, 403, { ok: false, error: "diag is host-only" });
				return;
			}
			sendJson(res, 200, {
				ok: true,
				version: PLUGIN_VERSION,
				listening: lanProxy !== null && lanProxy.listening(),
				lanPort: lanListenPort(ctx),
				dshPort: Number.isInteger(ctx?.webServer?.port) ? ctx.webServer.port : 0,
				addresses: lanProxy !== null ? lanProxy.addresses() : [],
				seenHosts: [...seenRequestHosts.entries()].map(([request, entry]) => ({ request, local: entry.local, count: entry.count })),
				events: lanProxy !== null ? lanProxy.events() : []
			});
		}
	};

	const disposers = [
		ctx.webServer.register(statusRoute),
		ctx.webServer.register(diagRoute),
		ctx.webServer.register(configureRoute),
		ctx.webServer.register(unlockRoute),
		ctx.webServer.register(mintRoute),
		ctx.webServer.register(landingRoute),
		ctx.webServer.register(proxyRoute)
	];

	// Re-align firewall and fence if the connection/webServer services are
	// (re)created later (tree recomposition drops monkey patches; the gateway
	// uses the same hook). Keyed on the REAL bind host, which also covers the
	// hot-reload that follows a switch flip.
	let serviceListenerOff = null;
	try {
		const off = ctx.on("internal/service", () => {
			syncEnforcement(ctx, log);
		});
		if (typeof off === "function") serviceListenerOff = off;
	} catch {
		// Older hosts without the event: the apply-time alignment below holds.
	}

	syncEnforcement(ctx, log);

	return () => {
		// Close the LAN door FIRST: its gate lives in this instance, so a
		// disposed plugin must never keep accepting connections.
		proxy.stop();
		if (lanProxy === proxy) lanProxy = null;
		if (proxyTimer !== null) clearInterval(proxyTimer);
		removeFencePatch(ctx);
		scheduleDisposalCleanup(ctx, log);
		if (serviceListenerOff !== null) {
			try {
				serviceListenerOff();
			} catch {}
			serviceListenerOff = null;
		}
		for (const dispose of disposers) dispose();
	};
}

export { apply, inject, name };
