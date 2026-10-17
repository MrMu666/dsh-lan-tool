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

		// 1 ── the door is open, and DSH itself stayed on loopback
		const st = JSON.parse((await step(`${local}/dsh-lan/status`)).body);
		console.log("--- status:", JSON.stringify({ enabled: st.enabled, desired: st.desiredEnabled, applying: st.applying, bindHost: st.bindHost, port: st.port, lanUrls: st.lanUrls, enforcement: st.enforcement }));
		check("1 proxy is listening (enabled)", st.enabled === true, JSON.stringify(st.enabled));
		check("1 no apply gap (applying=false)", st.applying === false, String(st.applying));
		check("1 DSH itself is still bound to loopback", /^(127\.|::1)/.test(String(st.bindHost)), String(st.bindHost));
		check("1 LAN URLs are advertised", Array.isArray(st.lanUrls) && st.lanUrls.length > 0, JSON.stringify(st.lanUrls));
		const lanBase = String(st.lanUrls[0]).replace(/\/$/, "");

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
		// Same request, both origins, both carrying their own valid session cookie:
		// an unknown RPC method must be routed (404/400/…) on both — never 403.
		const rpcInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, method: "noop" }) };
		const lanRpc = await step(`${lanBase}/api/connection`, { ...rpcInit, headers: { ...rpcInit.headers, cookie } });
		const localRpc = await step(`${local}/api/connection`, { ...rpcInit, headers: { ...rpcInit.headers, cookie: localCookie } });
		check(
			"5 the RPC path answers the same local and via the proxy (trust funnel accepts the LAN authority)",
			lanRpc.status === localRpc.status && lanRpc.status !== 403,
			`lan=${String(lanRpc.status)} local=${String(localRpc.status)} lanBody=${lanRpc.body.slice(0, 60)}`
		);

		// 6 ── the invariant this whole release exists for
		const patch = readFileSync(join(env.profile, "cordis.patch.yml"), "utf8");
		check("6 profile patch carries NO webserver override", !patch.includes("id: webserver") && !patch.includes("0.0.0.0"), patch.slice(0, 120));
		const state = JSON.parse(readFileSync(join(env.home, "dsh-lan.json"), "utf8"));
		check("6 state file records the desire", state.lanEnabled === true, JSON.stringify(state).slice(0, 90));
	} catch (error) {
		check("E2E ran without throwing", false, String(error?.stack ?? error).slice(0, 300));
	}
	const failed = rows.filter((r) => !r).length;
	console.log(`\n==== ${rows.length - failed}/${rows.length} end-to-end checks passed ====`);
	await stop();
	env.cleanup();
	setTimeout(() => process.exit(failed === 0 ? 0 : 1), 400);
});
