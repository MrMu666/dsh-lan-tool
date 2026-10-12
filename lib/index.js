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

const name = "dsh-lan-tool";
const inject = ["webServer", "connection"];

const ALL_INTERFACES = "0.0.0.0";
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
/** The override this plugin writes into the active profile's patch file. */
const BLOCK_BEGIN = "# --- dsh-lan-tool LAN block (managed - do not edit) ---";
const BLOCK_END = "# --- end dsh-lan-tool LAN block ---";
/**
 * Blocks written by 1.3.x (installer + UI toggle). The profile patch layer is
 * applied AFTER every bundle layer and the last writer wins, so a leftover
 * legacy block always beats the bundle patch; a leftover install block would
 * keep the socket on 0.0.0.0 while the card claims "off". They are stripped
 * once, which lands on the official default (127.0.0.1 + gzip) = a clean off.
 */
const LEGACY_BLOCKS = [
	["# --- dsh-LAN install block (managed - do not edit) ---", "# --- end dsh-LAN install block ---"],
	["# --- dsh-LAN toggle block (managed - do not edit) ---", "# --- end dsh-LAN toggle block ---"]
];
const MAX_PROXY_BODY_BYTES = 256 * 1024 * 1024;
const MAX_CONFIG_BODY_BYTES = 1024 * 1024;
const FIREWALL_SUMMARY_TTL_MS = 600 * 1000;
const firewallSummaryCache = new Map();

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

/** Human-readable firewall state for /dsh-lan/status (cached 600s, ufw async). */
async function firewallSummary(port, enabled) {
	const cacheKey = `${port}:${enabled}`;
	const now = Date.now();
	const cached = firewallSummaryCache.get(cacheKey);
	if (cached && cached.expiresAt > now) return cached.value;
	const backend = firewallBackend();
	let value;
	if (backend === null) {
		value = { ok: true, managed: false, note: "no supported firewall detected" };
	} else if (backend.label === "ufw") {
		const exists = await ufwRuleExistsAsync(port);
		const ok = enabled ? exists : !exists;
		value = { ok, managed: true, note: backend.label };
	} else {
		const ok = enabled ? backend.ruleExists(port) : !backend.ruleExists(port);
		value = { ok, managed: true, note: backend.label };
	}
	firewallSummaryCache.set(cacheKey, { value, expiresAt: now + FIREWALL_SUMMARY_TTL_MS });
	return value;
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

/** Strip this plugin's own override (legacy blocks untouched). */
function stripOwnBlock(content) {
	return stripBlock(content, BLOCK_BEGIN, BLOCK_END);
}

/** Strip every installer-era block. */
function stripLegacyBlocks(content) {
	let out = content;
	for (const [begin, end] of LEGACY_BLOCKS) out = stripBlock(out, begin, end);
	return out;
}

function hasLegacyBlocks(content) {
	return LEGACY_BLOCKS.some(([begin]) => content.includes(begin));
}

/**
 * The `host:` this plugin's own block currently requests, or null when there
 * is no managed block. This is the DESIRED state; the truth about what the
 * socket is doing is `ctx.webServer.host`.
 */
function managedBlockHost(content) {
	const begin = content.indexOf(BLOCK_BEGIN);
	if (begin === -1) return null;
	const end = content.indexOf(BLOCK_END, begin);
	const body = content.slice(begin + BLOCK_BEGIN.length, end === -1 ? void 0 : end);
	const match = /^[ \t]*host:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*$/m.exec(body);
	return match === null ? null : match[1];
}

/**
 * A patch file that has become empty must stay a YAML sequence (`[]`), or the
 * loader rejects it; otherwise keep the user's content verbatim.
 */
function tidyPatch(content) {
	const trimmed = content.trim();
	return trimmed === "" ? "[]\n" : `${trimmed}\n`;
}

/** Compose the new patch content: everything except our block, plus `block`. */
function composePatch(content, block) {
	const base = stripOwnBlock(content).trim();
	const head = base === "" || base === "[]" ? "" : base;
	if (block === null) return head === "" ? "[]\n" : `${head}\n`;
	return head === "" ? `${block}\n` : `${head}\n\n${block}\n`;
}

/**
 * The managed override. Every key of the target row's `config` must be
 * restated: patch application replaces the whole block, so a missing key
 * falls back to its schema default (`compression` defaults to `none` — the
 * page would silently lose gzip). The compression values are copied from the
 * config the composition actually resolved, so a deployment that customized
 * them keeps its values.
 */
function lanBlock(ctx) {
	const resolved = ctx?.webServer?.config ?? {};
	const compression = resolved.compression === "none" ? "none" : "gzip";
	const compressionLevel = Number.isInteger(resolved.compressionLevel) ? resolved.compressionLevel : 1;
	const compressionThresholdBytes = Number.isInteger(resolved.compressionThresholdBytes) ? resolved.compressionThresholdBytes : 1024;
	const bound = Number.isInteger(ctx?.webServer?.port) && ctx.webServer.port > 0 ? ctx.webServer.port : 3080;
	return [
		BLOCK_BEGIN,
		"- id: webserver",
		"  config:",
		`    host: '${ALL_INTERFACES}'`,
		`    port: !!js ctx.webStartup.port ?? ${bound}`,
		`    compression: ${compression}`,
		`    compressionLevel: ${compressionLevel}`,
		`    compressionThresholdBytes: ${compressionThresholdBytes}`,
		BLOCK_END
	].join("\n");
}

/** Write (or remove) the managed override. Returns whether the file changed. */
function setLanBlock(ctx, enabled, patchPath = active.patchPath) {
	const content = readPatchContent(patchPath);
	const next = composePatch(content, enabled ? lanBlock(ctx) : null);
	if (next === content) return false;
	mkdirSync(dirname(patchPath), { recursive: true });
	writeFileSync(patchPath, next);
	return true;
}

/** Desired state as recorded in the profile patch (may lag the real socket). */
function desiredLanOn() {
	return managedBlockHost(readPatchContent(active.patchPath)) === ALL_INTERFACES;
}

/** Real state: the socket is bound to every interface. */
function boundToAllInterfaces(ctx) {
	try {
		return ctx?.webServer?.host === ALL_INTERFACES;
	} catch {
		return false;
	}
}

/**
 * One-time upgrade migration (refactor plan §4.8), idempotent by construction:
 *
 * 1. strip the installer-era managed blocks — the profile layer overrides
 *    every bundle layer, so a leftover install block keeps the socket on
 *    0.0.0.0 ("looks off, actually exposed") and would keep overriding the
 *    bundle patch forever;
 * 2. remove the pre-rename firewall rule names, which no code can reach any
 *    more once `FIREWALL_RULE_NAME` changed.
 *
 * After step 1 the profile patch is back to the official default
 * (127.0.0.1 + gzip) — LAN access comes back OFF, which is the only safe
 * direction to migrate in. Users re-enable it from the settings card.
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
			log(`migration: removed the installer-era block from ${active.patchPath}; LAN access is off again (enable it in Settings → General)`);
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

function enforcementState(ctx) {
	if (!boundToAllInterfaces(ctx)) return "off";
	try {
		const connection = typeof ctx?.get === "function" ? ctx.get("connection") : void 0;
		if (connection !== void 0 && connection.requestRejection?.__dshLanPatched === true) return "full";
	} catch {}
	return "degraded";
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
		if (wrap.connection === connection) return true;
	}
	const origRequestRejection = connection.requestRejection;
	const origAuthorizeIndex = browserAuth.authorizeIndex;
	const patchedRejection = (req) => {
		// Decision 1: the host machine is fully open (no password, no DSH token).
		if (isLocalRequest(req)) return undefined;
		// Not exposed: DSH default (fence + official browser session).
		if (!boundToAllInterfaces(ctx)) return origRequestRejection.call(connection, req);
		// Exposed: the dsh-lan-tool password replaces the DSH token.
		if (hasLanCredential(req)) return undefined;
		noteGateRefusal(log, req, "request refused");
		return 403;
	};
	patchedRejection.__dshLanPatched = true;
	const patchedAuthorize = (req, res) => {
		// Decision 1: the host machine is fully open.
		if (isLocalRequest(req)) return true;
		// Not exposed: DSH default (token still required).
		if (!boundToAllInterfaces(ctx)) return origAuthorizeIndex.call(browserAuth, req, res);
		const requestUrl = new URL(req.url ?? "/", "http://x");
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
	browserAuth.authorizeIndex = patchedAuthorize;
	fenceWraps.add({ connection, browserAuth, origRequestRejection, origAuthorizeIndex });
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
			if (wrap.browserAuth.authorizeIndex?.__dshLanPatched === true) {
				wrap.browserAuth.authorizeIndex = wrap.origAuthorizeIndex;
			}
		} catch {}
	}
	fenceWraps.clear();
	fenceInstallLogged = false;
	if (typeof log === "function") log("LAN password fence removed");
}

/** Keep firewall and fence aligned with the real bind host. */
function syncEnforcement(ctx, log) {
	if (boundToAllInterfaces(ctx)) {
		ensureFirewallRule(ctx.webServer.port);
		if (!ensureFencePatched(ctx, log)) log("WARNING: LAN fence patch failed, enforcement degraded");
	} else {
		removeFirewallRule(ctx.webServer.port);
		removeFencePatch(ctx, log);
	}
}

// ── deactivation cleanup ───────────────────────────────────────────────────
// Removing the package (or disabling the row) takes the password fence with
// it, but the managed override lives in the PROFILE PATCH, which keeps binding
// the socket to 0.0.0.0 for a plugin that is no longer there — LAN reachable
// with only the official cookie gate, and the firewall rule still open.
//
// A hot reload disposes this row and immediately re-applies it, so cleaning up
// on every dispose would fight the on/off switch. A real removal never
// re-applies: wait out a generous window (far longer than any reload) and only
// then turn LAN off. Every failure mode of this timer is "LAN ends up off",
// never "LAN ends up on".
const DISPOSE_CLEANUP_DELAY_MS = 8000;
let applyGeneration = 0;
let disposeCleanupTimer = null;

function scheduleDisposalCleanup(ctx, log) {
	const generation = applyGeneration;
	const patchPath = active.patchPath; // captured: a later apply may have moved on
	disposeCleanupTimer = setTimeout(() => {
		disposeCleanupTimer = null;
		if (generation !== applyGeneration) return; // re-applied: a reload, not a removal
		try {
			if (setLanBlock(ctx, false, patchPath)) {
				log(`deactivated (not reloaded): removed the LAN bind override from ${patchPath}; enable LAN access again in Settings if this was a re-enable`);
			}
			removeFirewallRule(ctx.webServer.port);
		} catch (error) {
			log("WARNING: deactivation cleanup failed:", String(error?.message ?? error));
		}
	}, DISPOSE_CLEANUP_DELAY_MS);
	if (typeof disposeCleanupTimer?.unref === "function") disposeCleanupTimer.unref();
}

/**
 * Self-healing hook for request handlers: the connection service can be
 * recreated by a recomposition (which drops the monkey patch) between the
 * service event and the next request, so every endpoint we serve re-asserts
 * the fence while the socket is exposed. Cheap: one Set scan.
 */
function ensureFenceIfExposed(ctx, log) {
	if (boundToAllInterfaces(ctx)) ensureFencePatched(ctx, log);
}

async function buildStatus(ctx, config, req) {
	const state = readState();
	const enabled = boundToAllInterfaces(ctx);
	const desired = desiredLanOn();
	const port = ctx.webServer.port;
	const passwordSet = typeof state.passwordHash === "string";
	/**
	 * Host detail is host-only. A LAN device needs to know whether a password
	 * exists at all (the landing page says so instead of offering a form that
	 * cannot succeed) and what the switch state is — not this machine's
	 * filesystem paths and interface addresses.
	 */
	const local = isLocalRequest(req);
	const firewall = local ? await firewallSummary(port, enabled) : { ok: false, managed: false, note: "" };
	return {
		ok: true,
		/**
		 * Peer-verified: this request came from the host machine itself. This is
		 * the flag clients must use to decide "am I the host?" (the password
		 * gate, the posture classes and the settings card all key on it).
		 */
		local,
		/** Display only: the page was opened through a loopback NAME. */
		loopback: isLoopback(req),
		/** Real state: what the listening socket does. */
		enabled,
		/** Desired state: what the profile patch asks for. */
		desiredEnabled: desired,
		/** The patch was applied but the hot reload has not re-bound yet. */
		applying: enabled !== desired,
		bindHost: ctx.webServer.host,
		port,
		passwordSet,
		passwordVersion: typeof state.passwordVersion === "number" ? state.passwordVersion : 0,
		/** K5: exposed but nobody can get in — the card must not stay silent. */
		warning: enabled && !passwordSet ? "no-password" : null,
		...(local
			? {
					profile: active.profile,
					patchFile: active.patchPath,
					lanUrls: enabled ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
					firewallOk: firewall.ok,
					firewallManaged: firewall.managed,
					firewallNote: firewall.note,
					enforcement: enforcementState(ctx),
					platform: process.platform
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
	log(`activated (profile=${active.profile}, bind=${ctx.webServer.host}:${ctx.webServer.port})`);

	// Upgrade path first: a leftover installer-era block must be gone before
	// anything reads the desired state (it would keep overriding the bind).
	try {
		migrateLegacy(ctx, log);
	} catch (error) {
		log("WARNING: profile migration failed:", String(error?.message ?? error));
	}

	const statusRoute = {
		kind: "exact",
		path: "/dsh-lan/status",
		handler: async (req, res) => {
			ensureFenceIfExposed(ctx, log);
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
			if (!isLocalRequest(req)) {
				sendJson(res, 403, { ok: false, error: "configure is loopback-only" });
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
			if (typeof body.enabled === "boolean") {
				const changed = setLanBlock(ctx, body.enabled);
				// A missing password makes the LAN unusable (non-loopback
				// requests are refused without it); the card warns about that
				// state rather than silently exposing a door nobody can open.
				const passwordSet = typeof readState().passwordHash === "string";
				if (body.enabled) {
					ensureFirewallRule(ctx.webServer.port);
					if (!ensureFencePatched(ctx, log)) log("WARNING: LAN fence patch failed, enforcement degraded");
				} else {
					removeFirewallRule(ctx.webServer.port);
					removeFencePatch(ctx, log);
				}
				log(`LAN ${body.enabled ? "enabled" : "disabled"} (${changed ? "profile patch updated" : "profile patch already in that state"}; password ${passwordSet ? "set" : "NOT set"})`);
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

	const disposers = [
		ctx.webServer.register(statusRoute),
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
