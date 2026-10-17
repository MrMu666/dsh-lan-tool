// End-to-end verification of the v1.5.0 LAN proxy against a REAL DSH Host.
//
// OPT-IN — not part of `npm test`. It boots a real Host process and opens
// listeners on this machine's LAN addresses (which may make Windows ask once
// about firewall access), so run it deliberately, after changing anything in
// lib/lan-proxy.js or the proxy wiring in lib/index.js:
//
//   node test/lan-proxy-e2e.mjs
//
// Isolation: it builds a throwaway DSH_HOME under the OS temp directory whose
// profile is a copy of the live one, with `node_modules/dsh-lan-tool` junctioned
// to THIS repository and the bundle added to `dsh.profile.bundles`. The live
// profile and any installed copy of the plugin are never touched.
//
// What it proves, in order:
//   1. with LAN desired, the Host boots and the proxy comes up on the LAN
//      addresses — while DSH's own listener stays on loopback;
//   2. the proxy reuses the DSH port, and an uncredentialed LAN request is
//      refused (`/` gets the landing redirect, other paths get 403);
//   3. the password flow works THROUGH the proxy: unlock → mint → token URL;
//   4. the token exchange returns 303 + a cookie bound to the LAN authority, and
//      the SPA is served to a cookie-carrying LAN client;
//   5. the profile patch still carries NO `webserver` override — the whole point
//      of v1.5.0, since a wildcard host there makes 0.2.1 refuse to start.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Live DSH home: override with DSH_E2E_HOME when it is not the default. */
const liveHome = process.env.DSH_E2E_HOME ?? join(homedir(), ".dsh");
/** DSH install: override with DSH_E2E_INSTALL when the app lives elsewhere. */
const install = process.env.DSH_E2E_INSTALL ?? join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness");
const RES = join(install, "resources");
const EXE = join(install, "DeepSeek Harness.exe");
const RUNTIME = join(RES, "app.asar", "dsh");
const PASSWORD = "e2e-test-pw";

const rows = [];
const check = (label, ok, detail = "") => {
	rows.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"} | ${label}${ok ? "" : "  <- " + detail}`);
};
const step = async (url, init = {}) => {
	const r = await fetch(url, { redirect: "manual", ...init });
	return { status: r.status, location: r.headers.get("location"), cookie: r.headers.get("set-cookie"), body: await r.text() };
};

/** Build the throwaway home + profile and return `{ home, profile, cleanup }`. */
async function prepare() {
	const { execFileSync } = await import("node:child_process");
	const home = mkdtempSync(join(tmpdir(), "dsh-lan-e2e-"));
	const liveProfile = join(liveHome, "profiles", "desktop");
	const profile = join(home, "profiles", "desktop");
	mkdirSync(profile, { recursive: true });
	for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
		if (existsSync(join(liveProfile, file))) copyFileSync(join(liveProfile, file), join(profile, file));
	}
	for (const file of [".credentials.yaml", ".anonymous-user-id"]) {
		if (existsSync(join(liveHome, file))) copyFileSync(join(liveHome, file), join(home, file));
	}
	// Real conversation data makes the GUI attempt real work. Sessions are copied
	// read-only into the throwaway home so the browser phase loads a populated
	// interface instead of an empty state.
	if (process.env.DSH_E2E_WITH_DATA === "1") {
		for (const dir of ["sessions", "storages"]) {
			if (existsSync(join(liveHome, dir))) {
				execFileSync("cmd", ["/c", "xcopy", join(liveHome, dir), join(home, dir), "/E", "/I", "/Q", "/Y"], { stdio: "ignore" });
			}
		}
	}
	// State: LAN desired, so the proxy opens on boot. The password is set later
	// from the host side, so this test never needs the user's real password.
	const liveState = join(liveHome, "dsh-lan.json");
	const state = existsSync(liveState) ? JSON.parse(readFileSync(liveState, "utf8")) : {};
	delete state.passwordHash;
	delete state.salt;
	state.lanEnabled = true;
	writeFileSync(join(home, "dsh-lan.json"), JSON.stringify(state));
	// The plugin under test: a junction straight to the working tree.
	mkdirSync(join(profile, "node_modules"), { recursive: true });
	const link = join(profile, "node_modules", "dsh-lan-tool");
	execFileSync("cmd", ["/c", "mklink", "/J", link, repo], { stdio: "ignore" });
	const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	manifest.dsh ??= {};
	manifest.dsh.profile ??= {};
	manifest.dsh.profile.bundles ??= [];
	if (!manifest.dsh.profile.bundles.includes("dsh-lan-tool")) manifest.dsh.profile.bundles.push("dsh-lan-tool");
	writeFileSync(join(profile, "package.json"), JSON.stringify(manifest, void 0, 2));
	return { home, profile, cleanup: () => { try { rmSync(home, { recursive: true, force: true }); } catch {} } };
}

/**
 * OPTIONAL browser phase (`DSH_E2E_BROWSER=1`): drive a headless Chrome over the
 * LAN URL with a real session cookie, and report what the page actually does.
 *
 * This exists because a Node probe cannot answer "does the GUI work over the
 * LAN" — the client half behaves differently on a non-loopback origin (it
 * rewrites `/api` to `/lanapi`, mounts its password gate, and opens a WebSocket
 * to `/api/remote.mux`), and those paths only exist inside a browser.
 */
async function browserPhase({ localBase, lanBase, localCookie, lanCookie, chrome, log }) {
	const { spawn } = await import("node:child_process");
	const { createServer } = await import("node:net");
	const freePort = await new Promise((resolve) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
	const userDataDir = mkdtempSync(join(tmpdir(), "dsh-lan-chrome-"));
	const child = spawn(chrome, [
		"--headless=new",
		`--remote-debugging-port=${String(freePort)}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"about:blank"
	], { stdio: "ignore" });

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	let wsUrl = null;
	for (let i = 0; i < 40 && wsUrl === null; i += 1) {
		await sleep(250);
		try {
			const info = await (await fetch(`http://127.0.0.1:${String(freePort)}/json/version`)).json();
			wsUrl = info.webSocketDebuggerUrl ?? null;
		} catch {}
	}
	if (wsUrl === null) {
		log("browser: Chrome never exposed a debugging endpoint");
		child.kill("SIGKILL");
		return;
	}

	const socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	const events = { consoleErrors: [], exceptions: [], failedRequests: [], badResponses: [], sockets: [] };
	socket.addEventListener("message", (event) => {
		const msg = JSON.parse(String(event.data));
		if (msg.id !== undefined && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			return;
		}
		const method = msg.method;
		if (method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
			events.consoleErrors.push(`${msg.params.type}: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`.slice(0, 240));
		} else if (method === "Runtime.exceptionThrown") {
			events.exceptions.push(String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "").slice(0, 240));
		} else if (method === "Network.loadingFailed") {
			events.failedRequests.push(`${String(msg.params.type)} ${String(msg.params.errorText)}`.slice(0, 160));
		} else if (method === "Network.responseReceived" && Number(msg.params.response?.status) >= 400) {
			events.badResponses.push(`${String(msg.params.response.status)} ${String(msg.params.response.url).slice(0, 120)}`);
		} else if (method === "Network.webSocketCreated") {
			events.sockets.push(`created ${String(msg.params.url).slice(0, 90)}`);
		} else if (method === "Network.webSocketHandshakeResponseReceived") {
			events.sockets.push(`handshake ${String(msg.params.response?.status)} ${String(msg.params.response?.statusText ?? "")}`.slice(0, 120));
		} else if (method === "Network.webSocketClosed") {
			events.sockets.push("CLOSED");
		} else if (method === "Network.webSocketFrameError") {
			events.sockets.push(`frameError ${String(msg.params.errorMessage).slice(0, 90)}`);
		} else if (method === "Network.webSocketFrameReceived") {
			events.sockets.push(`frameReceived(${String(msg.params.response?.payloadData ?? "").length}B)`);
		}
	});
	const send = (method, params = {}, sessionId) => new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
	});

	/** Load one origin in a fresh target and report what the page did. */
	const probe = async (label, base, cookie, viewport, options = {}) => {
		events.consoleErrors.length = 0;
		events.exceptions.length = 0;
		events.failedRequests.length = 0;
		events.badResponses.length = 0;
		events.sockets.length = 0;
		const created = await send("Target.createTarget", { url: "about:blank" });
		const targetId = created.result?.targetId;
		const session = (await send("Target.attachToTarget", { targetId, flatten: true })).result?.sessionId;
		for (const domain of ["Page", "Runtime", "Network", "Log"]) await send(`${domain}.enable`, {}, session);
		// The viewport matters: the plugin's touch adaptation collapses the sidebar
		// on narrow portrait screens, which is EXACTLY where a phone sees "no
		// conversations" if the rail cannot be reopened.
		await send("Emulation.setDeviceMetricsOverride", {
			width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile === true
		}, session);
		// A phone is not just a narrow window: `isMobilePortrait()` (and the whole
		// touch adaptation) keys on `(pointer: coarse)`, which device metrics alone
		// do NOT provide. Without this the probe silently tests a desktop.
		if (viewport.mobile === true) {
			await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, session);
			await send("Emulation.setUserAgentOverride", {
				userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
			}, session);
		}
		const origin = new URL(base);
		await send("Network.setCookie", {
			name: cookie.split("=")[0],
			value: cookie.split("=").slice(1).join("="),
			domain: origin.hostname,
			path: "/"
		}, session);
		await send("Page.navigate", { url: `${base}/` }, session);
		await sleep(14000);
		const evaluated = await send("Runtime.evaluate", {
			expression: options.expression ?? `JSON.stringify({
				href: location.href,
				width: innerWidth,
				textLen: (document.body?.innerText ?? "").length,
				head: (document.body?.innerText ?? "").slice(0, 90).replace(/\\s+/g, " "),
				mentionsWorkspace: /dsh-LAN|github|deepseek-harness/.test(document.body?.innerText ?? ""),
				hasWhale: document.querySelector("#dshLanWhale") !== null,
				railCollapsed: document.querySelector('[class*="_frame"][data-sidebar-collapsed]') !== null,
				sidebarWidth: Math.round(document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect().width ?? -1),
				hasGate: document.querySelector("#dshLanGate") !== null,
				hasComposer: document.querySelector('[class*="_composerSeat"]') !== null
			})`,
			returnByValue: true
		}, session);
		const snapshot = JSON.parse(evaluated.result?.result?.value ?? "{}");
		log(`browser[${label}]: ${JSON.stringify(snapshot).slice(0, 400)}`);
		log(`browser[${label}]: console=${events.consoleErrors.length} exceptions=${events.exceptions.length} failed=${events.failedRequests.length} bad=${events.badResponses.length} ws=${events.sockets.length}`);
		for (const line of [...events.exceptions, ...events.consoleErrors].slice(0, 6)) log(`browser[${label}]: ${line}`);
		for (const line of [...events.failedRequests, ...events.badResponses].slice(0, 10)) log(`browser[${label}]: ${line}`);
		for (const line of events.sockets.slice(0, 4)) log(`browser[${label}]: ws ${line}`);
		send("Target.closeTarget", { targetId }).catch(() => {});
		await sleep(500);
		return snapshot;
	};

	/** Open a fresh target on `base` at a phone viewport (touch on) and hand it back. */
	const openPhoneTarget = async (base, cookie, viewport) => {
		const created = await send("Target.createTarget", { url: "about:blank" });
		const targetId = created.result?.targetId;
		const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result?.sessionId;
		for (const domain of ["Page", "Runtime", "Network"]) await send(`${domain}.enable`, {}, sessionId);
		await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true }, sessionId);
		await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
		await send("Emulation.setUserAgentOverride", {
			userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
		}, sessionId);
		const origin = new URL(base);
		await send("Network.setCookie", {
			name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), domain: origin.hostname, path: "/"
		}, sessionId);
		await send("Page.navigate", { url: `${base}/` }, sessionId);
		await sleep(14000);
		return { sessionId, targetId };
	};
	const evaluate = async (handle, expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true }, handle.sessionId);
		return result.result?.result?.value ?? "null";
	};

	const desktop = { width: 1280, height: 900 };
	const phone = { width: 390, height: 844, mobile: true };
	if (process.env.DSH_E2E_CONCURRENT === "1") {
		// The user's machine runs the desktop app AND the LAN client. If the event
		// stream tolerates only one holder per browser session, the second client
		// (or a reconnect) is exactly where "重新连接中" would come from.
		const first = await openPhoneTarget(lanBase, lanCookie, desktop);
		const second = await openPhoneTarget(lanBase, lanCookie, desktop);
		await sleep(9000);
		const read = (handle) => evaluate(handle, `JSON.stringify({
			reconnecting: /重新连接|reconnect/i.test(document.body?.innerText ?? ""),
			tail: (document.body?.innerText ?? "").replace(/\\s+/g, " ").slice(-90),
			ws: performance.getEntriesByType("resource").filter((e) => e.name.includes("remote.mux")).length
		})`);
		log(`browser[concurrent]: A=${await read(first)}`);
		log(`browser[concurrent]: B=${await read(second)}`);
		for (const line of events.sockets.slice(0, 14)) log(`browser[concurrent]: ws ${line}`);
		for (const line of [...events.exceptions, ...events.consoleErrors].slice(0, 6)) log(`browser[concurrent]: ${line}`);
		await send("Target.closeTarget", { targetId: first.targetId }).catch(() => {});
		await send("Target.closeTarget", { targetId: second.targetId }).catch(() => {});
	}
	const localSnapshot = await probe("local/desktop", localBase, localCookie, desktop);
	const lanSnapshot = await probe("lan/desktop", lanBase, lanCookie, desktop);
	const phoneSnapshot = await probe("lan/phone", lanBase, lanCookie, phone);
	// The phone is where "I can open the page but see no conversations" happens:
	// DSH collapses its sidebar to a 56px rail on a narrow screen, and the whale
	// is the plugin's affordance for opening it. So: is the whale there, and does
	// tapping it actually reveal the list?
	if (process.env.DSH_E2E_PHONE_TAP === "1") {
		const handle = await openPhoneTarget(lanBase, lanCookie, phone);
		const before = await evaluate(handle, `JSON.stringify({
			whale: document.querySelector("#dshLanWhale") !== null,
			visible: (document.querySelector("#dshLanWhale")?.getBoundingClientRect().width ?? 0) > 0,
			ourAttr: document.querySelector("[data-dsh-lan-whale]") !== null,
			sidebar: Math.round(document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect().width ?? -1),
			rows: document.querySelectorAll('[class$="_sessionRow"]').length
		})`);
		log(`browser[phone-tap]: before=${before}`);
		const box = await evaluate(handle, `(() => {
			const el = document.querySelector("#dshLanWhale");
			if (el === null) return null;
			const r = el.getBoundingClientRect();
			return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
		})()`);
		if (box !== null && box !== "null") {
			const point = JSON.parse(box);
			for (const type of ["mousePressed", "mouseReleased"]) {
				await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, handle.sessionId);
			}
			await sleep(1500);
		}
		const after = await evaluate(handle, `JSON.stringify({
			sidebar: Math.round(document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect().width ?? -1),
			rows: document.querySelectorAll('[class$="_sessionRow"]').length,
			visibleText: (document.querySelector('[class*="_sidebarCol"]')?.innerText ?? "").slice(0, 70).replace(/\\s+/g, " ")
		})`);
		log(`browser[phone-tap]: after=${after}`);
		await send("Target.closeTarget", { targetId: handle.targetId }).catch(() => {});
	}
	// Why is there no way back to the conversation list on a phone? Dump the
	// affordances that could open the collapsed rail, and whether the session
	// header (where 1.4.7 seats the whale) exists at all on this screen.
	if (process.env.DSH_E2E_DOMDUMP === "1") {
		await probe("lan/phone-dom", lanBase, lanCookie, phone, {
			dumpOnly: true,
			expression: `JSON.stringify({
				whale: document.querySelector("#dshLanWhale") !== null,
				titleRows: document.querySelectorAll('[class$="_titleRow"]').length,
				headerSessionless: document.querySelector('[class$="_headerSessionless"]') !== null,
				headerBlank: document.querySelector('[class$="_headerBlank"]') !== null,
				railFish: document.querySelector('[class$="_railFish"]') !== null,
				panelIcon: document.querySelector('[class$="_panelIcon"]') !== null,
				newSession: document.querySelector('[class$="_newSession"]') !== null,
				collapsedAttr: document.querySelector('[class*="_frame"]')?.getAttribute("data-sidebar-collapsed") ?? null,
				ourAttr: document.querySelector('[data-dsh-lan-whale]') !== null,
				railText: (document.querySelector('[class*="_sidebarCol"]')?.innerText ?? "").slice(0, 80).replace(/\\s+/g, " "),
				railButtons: [...document.querySelectorAll('[class*="_sidebarCol"] button, [class*="_sidebarCol"] a')].slice(0, 8).map((el) => (el.className || el.id || el.tagName).toString().slice(0, 40))
			})`
		});
	}
	const same = localSnapshot.textLen === lanSnapshot.textLen && localSnapshot.mentionsWorkspace === lanSnapshot.mentionsWorkspace;
	console.log(`browser: local vs lan identical=${String(same)} (textLen ${String(localSnapshot.textLen)}/${String(lanSnapshot.textLen)}, workspaces visible ${String(localSnapshot.mentionsWorkspace)}/${String(lanSnapshot.mentionsWorkspace)})`);

	try { socket.close(); } catch {}
	await sleep(300);
	child.kill("SIGKILL");
	try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

/** Boot the real Host and hand every ready/fatal event to `onReady`. */
function boot({ profile, home }, onReady) {
	const entry = join(RUNTIME, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
	const child = spawn(EXE, [
		"--expose-internals", entry, RUNTIME, profile,
		join(RES, "runtime", "primary-runtime"),
		join(RES, "runtime", "pnpm", "bin", "pnpm.mjs"),
		join(RES, "runtime", "bin")
	], {
		cwd: profile,
		env: {
			...process.env,
			DSH_HOME: home,
			ELECTRON_RUN_AS_NODE: "1",
			DSH_DESKTOP_NODE_EXECUTABLE: EXE,
			PATH: `${join(RES, "runtime", "bin")};${process.env.PATH ?? ""}`
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"]
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => process.stdout.write("[host] " + c));
	child.stderr.on("data", (c) => { const s = String(c); if (/error|fail/i.test(s)) process.stdout.write("[host err] " + s); });
	/**
	 * Shut the child down the way the desktop shell does: ask over IPC, give it a
	 * moment, then escalate. A bare kill() leaves an orphan on Windows holding the
	 * LAN listeners, which the next run would then fight over.
	 */
	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		try { child.send({ type: "shutdown" }); } catch {}
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
		clearTimeout(timer);
	};
	let handled = false;
	child.on("message", async (msg) => {
		if (msg?.type === "fatal") {
			console.log("HOST FATAL:", String(msg.message).slice(0, 400));
			await stop(); process.exit(3);
		}
		if (msg?.type !== "ready" || handled) return;
		handled = true;
		await onReady(new URL(msg.url).origin, msg.url, stop);
	});
	setTimeout(async () => { console.log("TIMEOUT"); await stop(); process.exit(5); }, 150000);
}

const env = await prepare();
console.log("isolated home:", env.home);

boot(env, async (local, readyUrl, stop) => {
	// Handed to the optional browser phase, which runs after the assertions.
	let lanBaseForBrowser = "";
	let cookieForBrowser = "";
	let localCookieForBrowser = "";
	try {
		// 0 ── the desktop shell's own handshake. It fetches the ready URL with
		// redirect:"manual" and demands exactly 303 + Set-Cookie, otherwise it
		// aborts startup with "Desktop Host authentication failed" — the 1.4.5
		// regression. It runs FIRST because a broken handshake means the app the
		// rest of this file describes never starts at all.
		const own = await step(readyUrl);
		check(
			"0 the host's own launch-token exchange → 303 + cookie (shell handshake)",
			own.status === 303 && own.cookie !== null,
			`${String(own.status)} cookie=${own.cookie === null ? "null" : "present"}`
		);
		const localCookie = String(own.cookie ?? "").split(";")[0];
		localCookieForBrowser = localCookie;

		// 1 ── the door is open, and DSH itself stayed on loopback
		const st = JSON.parse((await step(`${local}/dsh-lan/status`)).body);
		console.log("--- status:", JSON.stringify({ enabled: st.enabled, desired: st.desiredEnabled, applying: st.applying, bindHost: st.bindHost, port: st.port, lanUrls: st.lanUrls, enforcement: st.enforcement }));
		check("1 proxy is listening (enabled)", st.enabled === true, JSON.stringify(st.enabled));
		check("1 no apply gap (applying=false)", st.applying === false, String(st.applying));
		check("1 DSH itself is still bound to loopback", /^(127\.|::1)/.test(String(st.bindHost)), String(st.bindHost));
		check("1 LAN URLs are advertised", Array.isArray(st.lanUrls) && st.lanUrls.length > 0, JSON.stringify(st.lanUrls));
		const lanBase = String(st.lanUrls[0]).replace(/\/$/, "");
		lanBaseForBrowser = lanBase;

		// 2 ── a known password, set from the host side (configure is loopback-only)
		const cfg = await step(`${local}/dsh-lan/configure`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD })
		});
		check("2 host sets a password", cfg.status === 200 && JSON.parse(cfg.body).passwordSet === true, `${String(cfg.status)} ${cfg.body.slice(0, 90)}`);

		// 3 ── the gate, seen from the LAN
		const bare = await step(`${lanBase}/`);
		check("3 LAN bare / → landing redirect", bare.status === 302 && bare.location === "/dsh-lan/", `${String(bare.status)} ${String(bare.location)}`);
		const api = await step(`${lanBase}/api/session`);
		check("3 LAN /api without a credential → 403", api.status === 403, String(api.status));
		const landing = await step(`${lanBase}/dsh-lan/`);
		check("3 landing page is served through the proxy", landing.status === 200 && landing.body.includes("<"), `${String(landing.status)} ${landing.body.slice(0, 40)}`);

		// 4 ── the password flow, all of it through the proxy
		const wrong = await step(`${lanBase}/dsh-lan/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
		check("4 wrong password refused", JSON.parse(wrong.body).ok === false, wrong.body.slice(0, 60));
		const ok = await step(`${lanBase}/dsh-lan/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
		check("4 correct password accepted", JSON.parse(ok.body).ok === true, ok.body.slice(0, 60));
		const mint = await step(`${lanBase}/dsh-lan/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
		check(
			"4 mint → 302 to a token URL on the LAN authority",
			mint.status === 302 && String(mint.location).startsWith(lanBase) && String(mint.location).includes("token="),
			`${String(mint.status)} ${String(mint.location).slice(0, 70)}`
		);

		// 5 ── redeem the token THROUGH the proxy; the cookie must bind to the LAN authority
		const redeem = await step(String(mint.location));
		check("5 token exchange → 303 + cookie", redeem.status === 303 && redeem.cookie !== null, `${String(redeem.status)} cookie=${redeem.cookie === null ? "null" : "present"}`);
		const cookie = String(redeem.cookie ?? "").split(";")[0];
		cookieForBrowser = cookie;
		check("5 the cookie is a DSH session cookie for this authority", cookie.startsWith("dsh-auth-"), cookie.slice(0, 24));
		const spa = await step(`${lanBase}/`, { headers: { cookie } });
		check("5 SPA is served to a cookie-carrying LAN client", spa.status === 200 && spa.body.includes("<html"), `${String(spa.status)} len=${spa.body.length}`);

		// 5b ── the proxy must be TRANSPARENT, not merely reachable: the same path
		// with the same credentials has to answer the same way locally and over the
		// LAN. 1.5.0 shipped with this broken — the page loaded over the LAN while
		// every /api call got a 403, because DSH's own trust funnel
		// (`isTrustedApiRequest`) rejects a non-loopback Host authority and 1.4.x
		// only ever patched `requestRejection`, which the API path no longer uses.
		// Hence these comparisons.
		check("5 the SPA manifest advertises this plugin", spa.body.includes("dsh-lan-tool"), spa.body.slice(0, 120));
		const idContext = (spa.body.match(/[^"'\s]{0,70}dsh-lan-tool[^"'\s]{0,70}/) ?? [""])[0];
		check("5 the manifest names the plugin's browser bundle", /\.js/.test(idContext), idContext || spa.body.slice(0, 200));
		// 0.2.1 does not spell out a per-plugin URL: client-modules preloads a
		// manifest whose combo href lists every bundle (`…,dsh-lan-tool/client.js,…`).
		// Take that href verbatim (HTML-escaped ampersands included) so this stays
		// a test of the PROXY, not of my ability to reconstruct the URL.
		const combo = (spa.body.match(/["']([^"']*dsh-lan-tool\/client\.js[^"']*)["']/) ?? [])[1];
		if (typeof combo === "string") {
			const href = combo.replace(/&amp;/g, "&");
			// The combo href is relative (`plugins/?…`), so resolve it against the
			// document it came from rather than concatenating.
			const lanBundle = await step(new URL(href, `${lanBase}/`).href, { headers: { cookie } });
			const localBundle = await step(new URL(href, `${local}/`).href, { headers: { cookie: localCookie } });
			check(
				"5 the client bundle is served identically local and via the proxy",
				lanBundle.status === 200 && localBundle.status === 200 && lanBundle.body === localBundle.body && lanBundle.body.includes("dsh-lan-tool"),
				`href=${href.slice(0, 60)} lan=${String(lanBundle.status)} local=${String(localBundle.status)} len=${lanBundle.body.length}`
			);
		} else {
			check("5 the client bundle is served identically local and via the proxy", false, `no combo href found; ctx=${idContext}`);
		}
		// 5c ── the EVENT STREAM. The conversation data arrives over the WebSocket
		// mux (`/api/remote.mux`, dsh-api-gateway's REMOTE_STREAM_MUX_PATH), and the
		// client shows "reconnecting" while it cannot hold that socket. A created
		// WebSocket proves nothing — the handshake has to be ADMITTED — so do the
		// upgrade by hand and read the status line.
		const net = await import("node:net");
		const wsProbe = (base, session) => new Promise((resolve) => {
			const url = new URL(base);
			const socket = net.connect(Number(url.port), url.hostname, () => {
				socket.write(
					`GET /api/remote.mux HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					`Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${base}\r\n` +
					`Cookie: ${session}\r\n\r\n`
				);
			});
			let data = "";
			let settled = false;
			const finish = () => { if (settled) return; settled = true; try { socket.destroy(); } catch {} resolve(data.split("\r\n")[0] ?? "(no response)"); };
			socket.setTimeout(5000, finish);
			socket.on("data", (chunk) => { data += chunk.toString("latin1"); if (data.includes("\r\n\r\n")) finish(); });
			socket.on("close", finish);
			socket.on("error", () => finish());
		});
		const lanWs = await wsProbe(lanBase, cookie);
		const localWs = await wsProbe(local, localCookie);
		check(
			"5 the event-stream WebSocket upgrades on the LAN",
			lanWs.startsWith("HTTP/1.1 101") && localWs.startsWith("HTTP/1.1 101"),
			`lan="${lanWs}" local="${localWs}"`
		);
		// 5d ── and it must be RELEASABLE. DSH refuses a second upgrade for a peer
		// that already owns one (409 in `admitConnection`) and clears that only when
		// the socket really closes; LAN clients vanish abruptly all the time (page
		// reload, phone sleeping, Wi-Fi handover). If the tunnel does not propagate
		// the loss, the session keeps owning a dead socket: the session list still
		// loads over HTTP while the event stream says "reconnecting" for ever —
		// exactly the reported symptom.
		const openUpgrade = (base, session) => new Promise((resolve) => {
			const url = new URL(base);
			const socket = net.connect(Number(url.port), url.hostname, () => {
				socket.write(
					`GET /api/remote.mux HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					`Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${base}\r\n` +
					`Cookie: ${session}\r\n\r\n`
				);
			});
			let data = "";
			let settled = false;
			const done = (status) => { if (settled) return; settled = true; resolve({ socket, status }); };
			socket.setTimeout(5000, () => done("(timeout)"));
			socket.on("data", (chunk) => { data += chunk.toString("latin1"); if (data.includes("\r\n\r\n")) done(data.split("\r\n")[0]); });
			socket.on("error", () => done("(error)"));
		});
		const first = await openUpgrade(lanBase, cookie);
		first.socket.destroy(); // the abrupt disappearance: RST, no close handshake
		await new Promise((resolve) => setTimeout(resolve, 500));
		const second = await openUpgrade(lanBase, cookie);
		second.socket.destroy();
		check(
			"5 the event stream can reconnect after an abrupt client loss",
			first.status.startsWith("HTTP/1.1 101") && second.status.startsWith("HTTP/1.1 101"),
			`first="${first.status}" second="${second.status}"`
		);
		const rpcInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, method: "noop" }) };
		const lanRpc = await step(`${lanBase}/api/connection`, { ...rpcInit, headers: { ...rpcInit.headers, cookie } });
		const localRpc = await step(`${local}/api/connection`, { ...rpcInit, headers: { ...rpcInit.headers, cookie: localCookie } });
		check(
			"5 the RPC path answers the same local and via the proxy (trust funnel accepts the LAN authority)",
			lanRpc.status === localRpc.status && lanRpc.status !== 403,
			`lan=${String(lanRpc.status)} local=${String(localRpc.status)} lanBody=${lanRpc.body.slice(0, 60)}`
		);
		// …and the path the LAN browser ACTUALLY uses. Its client half calls
		// `clientIsLocal() === false` on a LAN origin and rewrites `/api` to
		// `/lanapi`, which this plugin serves by re-issuing the request in-process
		// as the host. So `/lanapi` — not `/api` — is what carries a real LAN
		// session's traffic, and it has to answer the same way.
		const lanApi = await step(`${lanBase}/lanapi/connection`, {
			method: "POST", headers: { "content-type": "application/json", cookie }, body: rpcInit.body
		});
		const localApi = await step(`${local}/lanapi/connection`, {
			method: "POST", headers: { "content-type": "application/json", cookie: localCookie }, body: rpcInit.body
		});
		check(
			"5 the client half's /lanapi reroute answers the same local and via the proxy",
			lanApi.status === localApi.status && lanApi.status !== 403,
			`lan=${String(lanApi.status)} local=${String(localApi.status)} lanBody=${lanApi.body.slice(0, 60)}`
		);

		// 6 ── the invariant this whole release exists for
		const patch = readFileSync(join(env.profile, "cordis.patch.yml"), "utf8");
		check("6 profile patch carries NO webserver override", !patch.includes("id: webserver") && !patch.includes("0.0.0.0"), patch.slice(0, 120));
		const state = JSON.parse(readFileSync(join(env.home, "dsh-lan.json"), "utf8"));
		check("6 state file records the desire", state.lanEnabled === true, JSON.stringify(state).slice(0, 90));

		// 7 ── a PINNED LAN port. DSH's own port is OS-assigned on every launch (the
		// desktop launcher passes `--port 0`), so an open LAN tab reconnects to a dead
		// port after a restart and sits on "reconnecting" for ever. Pinning belongs on
		// the plugin's own listener: a busy port there costs LAN access (plus a clear
		// line in the card), never the app.
		const { createServer } = await import("node:net");
		const free = await new Promise((resolve) => {
			const probe = createServer();
			probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
		});
		const pinned = await step(`${local}/dsh-lan/configure`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanPort: free })
		});
		check("7 pinning a LAN port is accepted", pinned.status === 200 && JSON.parse(pinned.body).lanPort === free, `${String(pinned.status)} ${pinned.body.slice(0, 90)}`);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const moved = JSON.parse((await step(`${local}/dsh-lan/status`)).body);
		check(
			"7 the LAN door moves to the pinned port",
			moved.lanPortEffective === free && Array.isArray(moved.lanUrls) && moved.lanUrls.every((u) => u.endsWith(`:${String(free)}`)),
			`effective=${String(moved.lanPortEffective)} urls=${JSON.stringify(moved.lanUrls)}`
		);
		const pinnedOrigin = `http://${new URL(lanBase).hostname}:${String(free)}`;
		const throughPinned = await step(`${pinnedOrigin}/dsh-lan/`);
		check("7 the pinned port serves the LAN door", throughPinned.status === 200, `${String(throughPinned.status)}`);
		let oldReleased = false;
		try {
			await fetch(`${lanBase}/dsh-lan/`, { redirect: "manual" });
		} catch {
			oldReleased = true;
		}
		check("7 the previous port is released, not duplicated", oldReleased);
		const cleared = await step(`${local}/dsh-lan/configure`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanPort: null })
		});
		check("7 clearing the pin returns to following DSH", cleared.status === 200 && JSON.parse(cleared.body).lanPort === null, `${String(cleared.status)} ${cleared.body.slice(0, 80)}`);
	} catch (error) {
		check("E2E ran without throwing", false, String(error?.stack ?? error).slice(0, 300));
	}
	const failed = rows.filter((r) => !r).length;
	console.log(`\n==== ${rows.length - failed}/${rows.length} end-to-end checks passed ====`);
	// Optional deep phase: what does a REAL browser do with this LAN origin?
	if (process.env.DSH_E2E_BROWSER === "1") {
		await browserPhase({
			localBase: local,
			lanBase: lanBaseForBrowser,
			localCookie: localCookieForBrowser,
			lanCookie: cookieForBrowser,
			chrome: process.env.DSH_E2E_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			log: (line) => console.log(line)
		});
	}
	await stop();
	env.cleanup();
	setTimeout(() => process.exit(failed === 0 ? 0 : 1), 400);
});
