window.__ModuleLoader__.load({
	id: "dsh-lan-tool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Non-secure contexts (LAN over http://) lack crypto.randomUUID, which
		// the harness RPC id minter depends on — without this every RPC
		// (history, workspaces, settings…) throws "crypto.randomUUID is not a
		// function" on LAN devices. Polyfill a CSPRNG-backed RFC4122 v4.
		if (typeof window.crypto !== "undefined" && typeof window.crypto.randomUUID !== "function") {
			window.crypto.randomUUID = function randomUUID() {
				const bytes = new Uint8Array(16);
				window.crypto.getRandomValues(bytes);
				bytes[6] = (bytes[6] & 15) | 64;
				bytes[8] = (bytes[8] & 63) | 128;
				const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
				return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
			};
		}
		let react = require("react");
		// ── constants ──
		const KEY_STORAGE = "dsh-lan-key";
		const PRIVILEGED = new Set([
			"settings.describe",
			"settings.openDocument",
			"settings.update",
			"settings.replace",
			"settings.mutate",
			"credentials.describe",
			"credentials.set",
			"credentials.unset",
			"llm.discoverModels",
			"agentPreset.read",
			"agentPreset.copy",
			"agentPreset.openDocument",
			"agentPreset.remove",
			// 0.1.2-rc.1 endpoints are slash-separated (settings/describe);
			// the fetch reroute normalizes dotted names to this form.
			"settings/describe",
			"settings/openDocument",
			"settings/update",
			"settings/replace",
			"settings/mutate",
			"credentials/describe",
			"credentials/set",
			"credentials/unset",
			"llm/discoverModels",
			"agentPreset/read",
			"agentPreset/copy",
			"agentPreset/openDocument",
			"agentPreset/remove"
		]);
		// Normalize a method to the gateway endpoint form (slashes).
		function lanMethodOf(method) {
			return String(method).replace(/\./g, "/");
		}

		/** Kept in sync with package.json (the offline test asserts that). */
		const PLUGIN_VERSION = "1.7.1";
		/**
		 * Hostname-level loopback HINT only. Browsers report IPv6 literals with
		 * brackets (`[::1]`), a webview can report a rewritten or empty host, and
		 * the desktop host may reach the GUI through the machine's own name — so
		 * this can never decide the password gate (1.4.0 locked the desktop out
		 * of its own GUI that way). The authoritative answer is the server's
		 * peer-verified `local` flag: see detectLocalClient().
		 */
		function isLoopbackHostname() {
			const host = String(window.location.hostname ?? "").replace(/^\[|\]$/g, "").replace(/^::ffff:/, "").toLowerCase();
			return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
		}
		// true/false once the server has answered; null = UNKNOWN (never a reason
		// to gate: the gate is UX, the server is the security boundary — 1.4.1
		// taught us that guessing here can cover the host's own GUI forever).
		/**
		 * The desktop shell's page is not an HTTP origin: it loads the SPA from
		 * `dsh-app://app/` and forwards everything to the Host with its own
		 * cookie. `__DSH_TRANSPORT__.ownsHost === true` is the shell's own
		 * statement that it OWNS that Host — i.e. this page IS the host machine,
		 * whatever the URL looks like (v1.5.7).
		 *
		 * Without this, `isLoopbackHostname("app")` is false, so the page spent
		 * its first moments classified as a LAN device: it painted the remote
		 * posture, and — worse — `clientIsLocal()` was false until the async
		 * `/dsh-lan/status` probe answered, so privileged calls were rerouted to
		 * `/lanapi` (which used to fail). The desktop app must never depend on a
		 * round trip to be granted its own host-only surfaces.
		 */
		function shellOwnsHost() {
			try {
				return globalThis.__DSH_TRANSPORT__?.ownsHost === true;
			} catch {
				return false;
			}
		}
		let localClient = isLoopbackHostname() || shellOwnsHost() ? true : null;
		let localProbe = null;
		let serverVersion = null;
		/**
		 * Ask the server "am I the host machine?" — it sees the TCP peer, which is
		 * the only reliable test. Returns true / false / null (unknown).
		 */
		async function detectLocalClient() {
			if (localClient !== null) return localClient;
			if (localProbe === null) {
				localProbe = window.fetch("/dsh-lan/status", { cache: "no-store", headers: { "x-dsh-lan-client": PLUGIN_VERSION } })
					.then((response) => (response.ok ? response.json() : null))
					.catch(() => null);
			}
			const data = await localProbe;
			localProbe = null; // a failed probe must not be cached: retry next call
			if (data !== null) {
				serverVersion = typeof data.version === "string" ? data.version : serverVersion;
				noteVersionMismatch();
				if (typeof data.local === "boolean") {
					localClient = data.local;
				} else if (data.loopback === true) {
					// Bridge for a node half older than 1.4.1 that reports only the
					// Host-based `loopback`: a loopback NAME still means the page was
					// loaded from this machine.
					localClient = true;
				}
				if (localClient === true) removeGate(); // a wrongly mounted gate heals itself
			}
			return localClient;
		}
		/**
		 * Synchronous view for call sites that cannot await: a server "yes" or a
		 * loopback hostname counts as local (used for the /lanapi reroute and the
		 * remote posture — never for the gate, see shouldGate()).
		 */
		function clientIsLocal() {
			return localClient === true || shellOwnsHost() || (localClient === null && isLoopbackHostname());
		}
		/**
		 * Gate decisions need EVIDENCE, not a guess: only an explicit "you are a
		 * LAN device" from the server may cover the GUI. Unknown — no answer yet,
		 * probe failed, or an older node half without `local` — never gates. The
		 * gate is UX; the server enforces either way. 1.4.1 proved that guessing
		 * here can cover the host machine's own GUI for good.
		 */
		function shouldGate() {
			return localClient === false;
		}
		/** The two halves of a plugin update at different times; say so once. */
		function noteVersionMismatch() {
			if (serverVersion === null || serverVersion === PLUGIN_VERSION) return;
			if (window.__dshLanVersionWarned === true) return;
			window.__dshLanVersionWarned = true;
			console.warn(
				`[dsh-lan-tool] 浏览器半边是 ${PLUGIN_VERSION}，但服务端仍在运行 ${serverVersion} —— ` +
				"插件已更新而应用没有重启。请完全退出桌面版再重新打开（node 半边不会热更新）。"
			);
		}
		function versionMismatchLine() {
			if (serverVersion === null || serverVersion === PLUGIN_VERSION) return null;
			return `插件已更新到 ${PLUGIN_VERSION}，但服务端仍在运行 ${serverVersion} —— 请完全退出并重启桌面版`;
		}
		function storedKey() {
			return window.localStorage.getItem(KEY_STORAGE) ?? window.sessionStorage.getItem(KEY_STORAGE) ?? "";
		}

		function setStoredKey(key, remember) {
			window.localStorage.removeItem(KEY_STORAGE);
			window.sessionStorage.removeItem(KEY_STORAGE);
			if (remember) window.localStorage.setItem(KEY_STORAGE, key);
			else window.sessionStorage.setItem(KEY_STORAGE, key);
			// Transport cookie for top-level navigations and WebSocket
			// upgrades (session-scoped; cleared on lock or browser close).
			document.cookie = KEY_STORAGE + "=" + encodeURIComponent(key) + "; Path=/";
		}

		function clearStoredKey() {
			window.localStorage.removeItem(KEY_STORAGE);
			window.sessionStorage.removeItem(KEY_STORAGE);
			document.cookie = KEY_STORAGE + "=; Path=/; Max-Age=0";
		}

		// ── stylesheet ────────────────────────────────────────────────────────
		const css = ".dshLan_row{flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex}.dshLan_head{align-items:center;gap:8px;display:flex}.dshLan_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.dshLan_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.dshLan_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.dshLan_toggle{appearance:none;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);cursor:pointer;position:relative;transition:background .15s}.dshLan_toggle:disabled{cursor:default;opacity:.5}.dshLan_toggle::after{content:\"\";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .15s,background .15s}.dshLan_toggle[aria-checked=\"true\"]{background:var(--dsw-alias-brand-primary)}.dshLan_toggle[aria-checked=\"true\"]::after{left:22px;background:#fff}.dshLan_status{flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex}.dshLan_urls{font-family:var(--dsw-font-family-mono,monospace);word-break:break-all}.dshLan_row2{align-items:center;gap:8px;display:flex;flex-wrap:wrap}.dshLan_input{flex:1;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;outline:none;max-width:280px;min-width:160px}.dshLan_btn{height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 14px;cursor:pointer}.dshLan_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshLan_btn:disabled{cursor:default;opacity:.5}.dshLan_badge{align-self:flex-start;border-radius:999px;background:var(--dsw-alias-success-bg,rgba(46,160,67,.15));color:var(--dsw-alias-success-fg,#2ea043);font-size:12px;line-height:18px;padding:2px 10px}.dshLan_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.dshLan_pending{color:var(--dsw-alias-state-success-primary,#2ea043);font-size:12px;line-height:18px}.dshLan_warn{color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px;line-height:18px;white-space:nowrap}.dshLanLock{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}.dshLanLock:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshLanLock.rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}.dshLanLockLabel{white-space:nowrap;overflow:hidden}[class$=\"_footerActions\"]{flex-wrap:wrap}";
		const tagId = "dsh-lan-tool/LanRow.module.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-lan-tool";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const c = {
			row: "dshLan_row",
			head: "dshLan_head",
			rowText: "dshLan_rowText",
			title: "dshLan_title",
			desc: "dshLan_desc",
			toggle: "dshLan_toggle",
			status: "dshLan_status",
			urls: "dshLan_urls",
			row2: "dshLan_row2",
			input: "dshLan_input",
			btn: "dshLan_btn",
			badge: "dshLan_badge",
			err: "dshLan_err",
			pending: "dshLan_pending",
			warn: "dshLan_warn"
		};

		// ── tiny external store ──────────────────────────────────────────────
		function createLanStore() {
			let snapshot = { phase: "loading", data: null, unlocked: storedKey() !== "", error: null };
			const listeners = new Set();
			return {
				get: () => snapshot,
				// the slots renderer's selector hook reads getSnapshot(), not get()
				getSnapshot: () => snapshot,
				set: (patch) => {
					snapshot = { ...snapshot, ...patch };
					for (const fn of listeners) fn();
				},
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				}
			};
		}
		const store = createLanStore();
		const useLan = (select) => react.useSyncExternalStore(store.subscribe, () => select(store.get()));

		// ── controller ───────────────────────────────────────────────────────
		/**
		* Flipping the switch rewrites the profile patch and lets the harness
		* rebind the listening socket (0.0.0.0 ⇄ 127.0.0.1). For a second or two
		* every request is refused or reset, and the browser reports that as a
		* bare "Failed to fetch" — the switch WORKING, not an error. So: stay
		* quiet inside that window and retry; only a failure that outlives it is
		* reported. (The red line used to appear on every toggle; ≤1.4.3.)
		*/
		const REBIND_GRACE_MS = 8000;
		const REBIND_RETRY_MS = 400;
		let rebindUntil = 0;
		let statusRetryTimer = null;
		function isTransientFetchError(message) {
			return /failed to fetch|networkerror|load failed|fetch failed|network request failed|aborted|timeout|HTTP 50[234]/i.test(String(message ?? ""));
		}
		function inRebindWindow() {
			return Date.now() < rebindUntil;
		}
		function markRebindWindow(ms = REBIND_GRACE_MS) {
			rebindUntil = Math.max(rebindUntil, Date.now() + ms);
		}
		function scheduleStatusRetry() {
			if (statusRetryTimer !== null) return;
			statusRetryTimer = window.setTimeout(() => {
				statusRetryTimer = null;
				void fetchStatus();
			}, REBIND_RETRY_MS);
		}
		async function fetchStatus() {
			const previous = store.get().data;
			try {
				const response = await window.fetch("/dsh-lan/status", { cache: "no-store", headers: { "x-dsh-lan-client": PLUGIN_VERSION } });
				if (!response.ok) throw new Error("HTTP " + response.status);
				const data = await response.json();
				if (typeof data?.version === "string") {
					serverVersion = data.version;
					noteVersionMismatch();
				}
				// The server knows when the rebind is still in flight; trust it.
				if (data?.applying === true) markRebindWindow();
				store.set({ phase: "ready", data, error: null });
				return data;
			} catch (error) {
				const message = String(error?.message ?? error);
				const expected = isTransientFetchError(message) && (inRebindWindow() || previous?.applying === true);
				if (expected) {
					// Keep whatever we were showing (the card says "正在生效…") and
					// try again shortly — no red flash while the port re-binds.
					store.set({ phase: previous === null ? "loading" : "ready", data: previous, error: null });
					scheduleStatusRetry();
					return null;
				}
				store.set({ phase: "error", data: previous, error: message });
				return null;
			}
		}

		// ── local / remote posture ───────────────────────────────────────────
		/**
		* Stamp <body> with `dsh-lan-nonlocal` when this browser is NOT on the
		* host machine. The server decides: /dsh-lan/status reports
		* `local: isLocalRequest(req)`, and "local" means the TCP peer is this
		* machine (loopback or one of its own addresses) — NOT which hostname the
		* page used, because the desktop host can reach its own GUI under a name
		* the client cannot recognize (1.4.1). The client-side hostname hint is
		* only a fallback for the first paint, and a correction removes the class
		* again, so a host client never keeps the remote posture by accident.
		*
		* This stylesheet is injected unconditionally, not as part of a
		* portrait-phone adaptation: a LAN client may be a desktop browser too,
		* which is exactly where this useless launcher shows up.
		*/
		const NONLOCAL_CSS_ID = "dsh-lan-tool/nonlocal-header.css";
		const NONLOCAL_CSS = [
			// The host-only app launcher (文件资源管理器 / VS Code / Git Bash) is
			// registered into `conversation.session.header.utilities` by
			// @deepseek-ai/dsh-client-ui-open-in-app and can only launch apps on the
			// HOST; from another machine it is dead weight taking header space.
			// Matched by the official class-name SUFFIX the bundle actually uses
			// (`CAgGvG_split` → `[class$="_split"]`), plus the extra `body.` class for
			// specificity over the official `.CAgGvG_split { display:inline-flex }`.
			"body.dsh-lan-nonlocal [class$=\"_headerUtilities\"] [class$=\"_split\"]{display:none}",
			// v83: the Session-log "more actions" three-dot button
			// (@deepseek-ai/dsh-session-log-export's `nL4_yW_moreButton`,
			// aria-haspopup=menu + ellipsis icon) is unconditionally hidden for a
			// remote browser. It lives in the same utilities slot, and the mobile
			// stylesheet already hides that cluster — but only while the whole
			// mobile-adaptation state is active (portrait + coarse pointer +
			// width < 1100), which is exactly why it could still be seen on a real
			// phone. Keying it to the non-local posture removes that dependency: a
			// LAN browser never needs to download this session log to the wrong
			// machine's disk. The `_trigger` term is a second safety net by ROLE.
			"body.dsh-lan-nonlocal [class$=\"_headerUtilities\"] [class$=\"_moreButton\"],body.dsh-lan-nonlocal [class$=\"_headerUtilities\"] [class$=\"_trigger\"]:has(svg):where([aria-haspopup=\"menu\"]){display:none}"
		].join("");
		function ensureNonLocalStyle() {
			if (document.querySelector("style[data-plugin-css=\"" + NONLOCAL_CSS_ID + "\"]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-lan-tool";
			tag.dataset.pluginCss = NONLOCAL_CSS_ID;
			tag.textContent = NONLOCAL_CSS;
			document.head.appendChild(tag);
		}
		function markNonLocalPosture(isLocal) {
			if (isLocal === true) {
				document.body.classList.remove("dsh-lan-nonlocal");
				return;
			}
			document.body.classList.add("dsh-lan-nonlocal");
			ensureNonLocalStyle();
		}
		async function syncNonLocalPosture() {
			// Hostname hint first (no round trip), then the peer-verified answer:
			// the host machine keeps its host-only affordances whatever name it
			// reached the GUI through, and a correction removes the class again.
			markNonLocalPosture(clientIsLocal());
			markNonLocalPosture(await detectLocalClient());
		}

		async function configure(body) {
			store.set({ phase: "saving" });
			try {
				const response = await window.fetch("/dsh-lan/configure", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				const data = await response.json().catch(() => null);
				if (!response.ok) throw new Error(data?.error ?? "HTTP " + response.status);
				store.set({ phase: "ready", data, error: null });
				// The profile patch is watched with a write-stability window and a
				// debounce, so the socket is re-bound a moment after this response
				// (the status payload's `applying` flag reports the gap). Poll a few
				// times so the card converges on the real bind host instead of
				// showing the pre-toggle state — and treat the refusals in between
				// as the rebind they are, not as errors.
				if (typeof body?.enabled === "boolean") markRebindWindow();
				const delays = typeof body?.enabled === "boolean" ? [600, 1500, 2800, 4500, 7000] : [400];
				for (const delay of delays) window.setTimeout(() => { void fetchStatus(); }, delay);
				return data;
			} catch (error) {
				const message = String(error?.message ?? error);
				// A toggle that appears to fail because the port is mid-rebind is
				// still a toggle that happened: keep the card calm and re-read.
				if (isTransientFetchError(message) && (inRebindWindow() || body?.enabled === true)) {
					markRebindWindow();
					store.set({ phase: "ready", data: store.get().data, error: null });
					window.setTimeout(() => { void fetchStatus(); }, REBIND_RETRY_MS);
					return null;
				}
				store.set({ phase: "error", error: message });
				throw error;
			}
		}

		async function setPassword(password) {
			return configure({ password });
		}

		async function clearPassword() {
			return configure({ password: null });
		}

		async function unlock(password) {
			try {
				const response = await window.fetch("/dsh-lan/unlock", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password })
				});
				const data = await response.json();
				if (response.ok && data.ok === true) {
					setStoredKey(password, true);
					store.set({ unlocked: true });
					return true;
				}
				store.set({ unlocked: false });
				return false;
			} catch {
				return false;
			}
		}

		// ── settings card ────────────────────────────────────────────────────
		function LanRow({ useLan, t }) {
			const state = useLan((snapshot) => snapshot);
			const [passwordInput, setPasswordInput] = react.useState("");
			const [portInput, setPortInput] = react.useState("");
			const [portInvalid, setPortInvalid] = react.useState(false);
			const [unlockInput, setUnlockInput] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [unlockFailed, setUnlockFailed] = react.useState(false);
			const [needPassword, setNeedPassword] = react.useState(false);
			const passwordRef = react.useRef(null);
			// A toggle settles in milliseconds now, so the server's `applying` flag can
			// come and go between two polls. Hold the card's "正在生效…" line for a
			// short, fixed moment after the user flips the switch so the feedback they
			// asked for (1.4.6) is actually visible; the real state still comes from
			// `applying` at every render.
			const pendingUntil = react.useRef(0);
			react.useEffect(() => {
				void fetchStatus();
				const timer = window.setInterval(() => { void fetchStatus(); }, 5000);
				return () => window.clearInterval(timer);
			}, []);
			const data = state.data;
			// Prefill the port box once, from whatever is pinned; never fight the
			// user's typing afterwards.
			const portPrefilled = react.useRef(false);
			react.useEffect(() => {
				if (portPrefilled.current || data === null || data === void 0) return;
				portPrefilled.current = true;
				setPortInput(data.lanPort === null || data.lanPort === void 0 ? "" : String(data.lanPort));
			}, [data]);
			const enabled = data?.enabled === true;
			const passwordSet = data?.passwordSet === true;
			// The card is host-only in practice (DSH withholds the settings scope
			// from non-loopback pages), but decide it from the same authoritative
			// flag: the status payload's peer-verified `local`, hint until it loads.
			const local = data === null || data === void 0 ? clientIsLocal() : data.local === true;
			/**
			 * v1.5.5: `local` only says the socket came from this machine, which is also
			 * true for a LAN client the proxy forwards. `hostOnly` (absent on older
			 * servers) additionally means the proxy did NOT forward it, so this is the
			 * flag that decides whether the mutating controls are offered at all.
			 */
			const canConfigure = local && data?.hostOnly !== false;
			const loading = state.phase === "loading";
			const toggle = react.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": enabled,
				className: c.toggle,
				disabled: busy || loading || data === null,
				title: enabled ? t("toggle.off") : t("toggle.on"),
				onClick: () => {
					// K5 (refactor plan §4.7): "no token" access is implemented by
					// the dsh-lan-tool password gate, so enabling LAN access
					// without a password opens a door nobody can walk through.
					// Refuse the flip and point at the password field instead of
					// leaving the user with a "broken" LAN.
					if (!enabled && !passwordSet) {
						setNeedPassword(true);
						if (passwordRef.current !== null) passwordRef.current.focus();
						return;
					}
					setNeedPassword(false);
					setBusy(true);
					pendingUntil.current = Date.now() + 1600;
					configure({ enabled: !enabled }).catch(() => {}).finally(() => setBusy(false));
				}
			});
			const statusLines = [];
			if (state.phase === "error" && state.error !== null) {
				statusLines.push(react.createElement("div", { className: c.err, children: t("error") + " " + state.error }));
			}
			if (data !== null) {
				// The firewall line reports WHAT the OS admits, and where that
				// knowledge comes from: our own rule ("plugin"), a rule the OS
				// dialog created ("system"), or a LAN device that actually got
				// through ("observed"). Only "plugin + not ok" is a real problem,
				// and even that one re-checks itself in the background.
				//
				// v1.5.7: "we have not asked the OS yet" is its own state. Right
				// after the switch flips, the rule add and the Windows dialog are
				// still in flight, so the server reports `firewallChecking`. Show
				// that as green progress — the old rendering printed "未放行" for
				// the first seconds of a toggle that was working (`防火墙状态要过
				// 几秒才刷新，刚切换完显示的是未放行`).
				const checking = data.firewallChecking === true;
				const firewallLabel = data.firewallSource === "system" || data.firewallSource === "observed"
					? t("firewall.system")
					: data.firewallManaged === false
						? t("firewall.na")
						: t(data.firewallOk ? "firewall.ok" : "firewall.bad");
				const firewallHint = !checking && data.enabled === true && data.firewallSource === "plugin" && data.firewallOk !== true
					? " \u00b7 " + t("firewall.retry")
					: "";
				const firewallText = (data.firewallNote ? firewallLabel + " (" + data.firewallNote + ")" : firewallLabel) + firewallHint;
				// Build the line from non-empty parts only: a blank label (a locale
				// gap, a stripped firewall note) must never leave a dangling " · ".
				// v1.5.0: LAN access is this plugin's reverse proxy, so DSH's own
				// bind is a LOOPBACK listener again — say which is which instead of
				// printing a loopback address next to working LAN URLs.
				const bindLabel = data.proxied === true ? t("status.bindLocal") : t("status.bind");
				const statusParts = [
					bindLabel + " " + data.bindHost + ":" + data.port,
					checking ? null : firewallText,
					t(passwordSet ? "password.set" : "password.unset")
				].filter((part) => typeof part === "string" && part.trim() !== "");
				statusLines.push(react.createElement("div", { children: statusParts.join(" \u00b7 ") }));
				if (checking) {
					statusLines.push(react.createElement("div", { className: c.pending, children: t("firewall.checking") }));
				}
				if (data.proxied === true && data.enabled === true) {
					statusLines.push(react.createElement("div", { children: t("status.proxy") }));
				}
				// the patch file and the listening socket disagree for ~2s:
				// the harness debounces the write before it re-binds.
				// Green, not the muted status grey: this is a normal step on the
				// way to ON/OFF, and 1.4.4's red "Failed to fetch" flash showed
				// how easily a transient window reads as an error.
				if (data.applying === true || Date.now() < pendingUntil.current) {
					statusLines.push(react.createElement("div", { className: c.pending, children: t("status.applying") }));
				}
				if (enabled && data.lanUrls.length > 0) {
					statusLines.push(react.createElement("div", { className: c.urls, children: t("status.urls") + " " + data.lanUrls.join("   ") }));
				} else if (!enabled) {
					statusLines.push(react.createElement("div", { children: t("status.off") }));
				}
				if (data.warning === "no-password") {
					statusLines.push(react.createElement("div", { className: c.err, children: t("warning.noPassword") }));
				}
				// The browser half and the node half update at different times: the
				// bundle is re-read from disk, the node half is not. Say it instead
				// of leaving the user with an unexplained password gate (1.4.1).
				if (typeof data.version === "string" && data.version !== PLUGIN_VERSION) {
					statusLines.push(react.createElement("div", { className: c.err, children: versionMismatchLine() }));
				}
				statusLines.push(react.createElement("div", { children: "插件版本 " + PLUGIN_VERSION + "（服务端 " + (typeof data.version === "string" ? data.version : "未知") + "）" }));
			}
			const passwordSection = react.createElement("div", { className: c.row2, children: [
				react.createElement("input", {
					className: c.input,
					type: "password",
					ref: passwordRef,
					placeholder: t("password.placeholder"),
					value: passwordInput,
					onChange: (event) => setPasswordInput(event.target.value)
				}),
				react.createElement("button", {
					className: c.btn,
					disabled: busy,
					onClick: async () => {
						setBusy(true);
						try {
							await setPassword(passwordInput);
							setPasswordInput("");
							setNeedPassword(false);
						} catch {}
						finally {
							setBusy(false);
						}
					},
					children: t("password.save")
				}),
				data?.passwordSet ? react.createElement("button", {
					className: c.btn,
					disabled: busy,
					onClick: async () => {
						setBusy(true);
						try { await clearPassword(); } catch {}
						finally { setBusy(false); }
					},
					children: t("password.clear")
				}) : null,
				needPassword ? react.createElement("span", { className: c.err, children: t("password.required") }) : null
			] });
			// v1.5.2: the LAN port can be pinned. DSH's own port is OS-assigned on
			// every launch, so without this the LAN URL changes each start and a tab
			// left open reconnects to a dead port ("重新连接中" with the session list
			// still on screen). Empty = follow DSH.
			const portSection = react.createElement("div", { className: c.row2, children: [
				react.createElement("input", {
					className: c.input,
					type: "text",
					inputMode: "numeric",
					placeholder: t("port.placeholder"),
					value: portInput,
					onChange: (event) => setPortInput(event.target.value.replace(/[^\d]/g, ""))
				}),
				react.createElement("button", {
					className: c.btn,
					disabled: busy,
					onClick: async () => {
						const trimmed = portInput.trim();
						const value = trimmed === "" ? null : Number(trimmed);
						if (value !== null && (!Number.isInteger(value) || value < 1024 || value > 65535)) {
							setPortInvalid(true);
							return;
						}
						setPortInvalid(false);
						setBusy(true);
						try { await configure({ lanPort: value }); } catch {}
						finally { setBusy(false); }
					},
					children: t("port.apply")
				}),
				portInvalid ? react.createElement("span", { className: c.err, children: t("port.invalid") }) : null
			] });
			const unlockSection = state.unlocked
				? react.createElement("div", { className: c.badge, children: t("unlock.unlocked") })
				: react.createElement("div", { className: c.row2, children: [
					react.createElement("input", {
						className: c.input,
						type: "password",
						placeholder: t("unlock.placeholder"),
						value: unlockInput,
						onChange: (event) => setUnlockInput(event.target.value)
					}),
					react.createElement("button", {
						className: c.btn,
						disabled: busy,
						onClick: async () => {
							const ok = await unlock(unlockInput);
							setUnlockFailed(!ok);
							if (ok) setUnlockInput("");
						},
						children: t("unlock.btn")
					}),
					unlockFailed ? react.createElement("span", { className: c.err, children: t("unlock.failed") }) : null
				] });
			return react.createElement("div", { className: c.row, children: [
				// First line of the card, on purpose: a one-line red warning that this
				// surface must only be exposed on a trusted network. `nowrap` keeps it a
				// single line as required; it is deliberately not truncated, so if a
				// layout is ever too narrow the message stays fully readable.
				react.createElement("div", { className: c.warn, children: t("notice.trusted") }),
				react.createElement("div", { className: c.head, children: [
					react.createElement("div", { className: c.rowText, children: [
						react.createElement("div", { className: c.title, children: t("title") }),
						react.createElement("div", { className: c.desc, children: t("description") })
					] }),
					canConfigure ? toggle : null
				] }),
				react.createElement("div", { className: c.status, children: statusLines }),
				local && !canConfigure ? react.createElement("div", { children: t("hostOnly.note") }) : null,
				canConfigure ? passwordSection : (local ? null : unlockSection),
				canConfigure ? react.createElement("div", { className: c.rowText, children: [
					react.createElement("div", { className: c.desc, children: t("port.label") }),
					react.createElement("div", { className: c.desc, children: t("port.help") })
				] }) : null,
				canConfigure ? portSection : null
			] });
		}

		// ── privileged-call rerouting ────────────────────────────────────────
		// v62: intercept at the NETWORK layer. DSH 0.2.1 起（0.2.2-rc.1 同）移除了
		// `connection.api` / `postJson` entirely (the connection handle is
		// `{ interactions, isLoopback, generation, state, rpc, openWebSocket, … }`),
		// so there is no per-service call hook left to wrap — every remote call,
		// including the generated namespaces the official surfaces use, goes
		// through `window.fetch`. That is the one seam this plugin owns:
		// - privileged /api/<method> requests reroute to /lanapi/<method>
		//   with the stored key (server-enforced);
		// - every other /api/* request carries the stored key as
		//   x-dsh-lan-key so the server fence accepts it without a DSH
		//   token. /lanapi itself passes through untouched.
		let lanFetchWrapped = false;
		function installLanFetchReroute() {
			if (lanFetchWrapped || typeof window === "undefined") return;
			lanFetchWrapped = true;
			const lanOrigFetch = window.fetch.bind(window);
			window.fetch = function (input, init) {
				let pathname = "";
				try { pathname = new URL(typeof input === "string" ? input : input && input.url, window.location.href).pathname; } catch (err) {}
				const method = pathname.startsWith("/api/") ? pathname.slice(5) : "";
				if (method !== "" && !clientIsLocal() && PRIVILEGED.has(method)) {
					const lanMethod = lanMethodOf(method);
					const headers = new Headers((init && init.headers) || (typeof input === "object" && input.headers) || {});
					const key = storedKey();
					if (key !== "") headers.set("x-dsh-lan-key", key);
					let lanUrl = "";
					try {
						const u = new URL("/lanapi/" + lanMethod, window.location.href);
						u.search = new URL(typeof input === "string" ? input : input && input.url, window.location.href).search;
						lanUrl = u.href;
					} catch (err) { return lanOrigFetch(input, init); }
					const body = (init && init.body) || (typeof input === "object" && input.body);
					return lanOrigFetch(lanUrl, { ...(init || {}), headers, body }).then((response) => {
						if (response.status === 403) {
							clearStoredKey();
							store.set({ unlocked: false });
							if (shouldGate()) mountGate();
						}
						return response;
					});
				}
				if (method !== "" && !clientIsLocal()) {
					const key = storedKey();
					if (key !== "") {
						const headers = new Headers((init && init.headers) || (typeof input === "object" && input.headers) || {});
						headers.set("x-dsh-lan-key", key);
						return lanOrigFetch(input, { ...(init || {}), headers }).then((response) => {
							if (response.status === 403) {
								clearStoredKey();
								store.set({ unlocked: false });
								if (shouldGate()) mountGate();
							}
							return response;
						});
					}
				}
				return lanOrigFetch(input, init);
			};
		}
			// ── login gate overlay (non-loopback desktop) ────────────────────────
			const GATE_CSS = "#dshLanGate{position:fixed;inset:0;z-index:2147483000;background:rgba(10,12,16,.96);display:flex;align-items:center;justify-content:center;padding:24px}#dshLanGate .card{width:100%;max-width:380px;background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:12px;color:#e6e9ef;font:14px/1.55 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}#dshLanGate .t{font-size:20px;font-weight:700;text-align:center}#dshLanGate .s{color:#9aa3b2;font-size:13px;text-align:center;margin-top:-6px}#dshLanGate input[type=password]{font:inherit;color:inherit;background:#0f1117;border:1px solid #2a2f3a;border-radius:10px;padding:11px 12px;outline:none}#dshLanGate input[type=password]:focus{border-color:#4c8dff}#dshLanGate label{display:flex;align-items:center;gap:8px;color:#9aa3b2;font-size:13px}#dshLanGate button{font:inherit;border:none;border-radius:10px;padding:11px;background:#4c8dff;color:#fff;font-weight:600;cursor:pointer}#dshLanGate button:disabled{opacity:.5;cursor:default}#dshLanGate .err{color:#e5534b;font-size:13px;min-height:16px;text-align:center}#dshLanLock{position:fixed;right:14px;bottom:14px;z-index:2147483000;font:13px -apple-system,'Segoe UI','PingFang SC',sans-serif;border-radius:999px;border:1px solid #2a2f3a;background:#171a21;color:#9aa3b2;padding:7px 14px;cursor:pointer}";
			function ensureGateStyle() {
				const id = "dsh-lan-tool/gate.css";
				if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-lan-tool";
				tag.dataset.pluginCss = id;
				tag.textContent = GATE_CSS;
				document.head.appendChild(tag);
			}
		let gateRoot = null;
		async function verifyKey(key) {
			if (key === "") return false;
			try {
				const response = await window.fetch("/dsh-lan/unlock", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: key })
				});
				const data = await response.json();
				return response.ok && data.ok === true;
			} catch {
				return false;
			}
		}
		function removeGate() {
			if (gateRoot !== null) { gateRoot.remove(); gateRoot = null; }
		}
		function mountGate() {
			// Only an explicit server "you are remote" may cover the GUI.
			if (!shouldGate() || gateRoot !== null) return;
			ensureGateStyle();
			gateRoot = document.createElement("div");
			gateRoot.id = "dshLanGate";
			gateRoot.innerHTML = '<div class="card"><div class="t">DSH 远程访问</div><div class="s">输入访问口令后才能查看和使用本页面</div><input type="password" placeholder="访问口令" autocomplete="current-password"><label><input type="checkbox"> 记住口令（仅保存在本机浏览器）</label><button>进入</button><div class="err"></div></div>';
			const input = gateRoot.querySelector("input[type=password]");
			const remember = gateRoot.querySelector("input[type=checkbox]");
			const button = gateRoot.querySelector("button");
			const err = gateRoot.querySelector(".err");
			const attempt = async () => {
				button.disabled = true;
				err.textContent = "";
				const ok = await verifyKey(input.value);
				if (ok) {
					setStoredKey(input.value, remember.checked);
					store.set({ unlocked: true });
					removeGate();
				} else {
					err.textContent = "口令错误";
					button.disabled = false;
					input.select();
				}
			};
			button.addEventListener("click", attempt);
			input.addEventListener("keydown", (event) => { if (event.key === "Enter") attempt(); });
			document.body.appendChild(gateRoot);
			void window.fetch("/dsh-lan/status", { cache: "no-store", headers: { "x-dsh-lan-client": PLUGIN_VERSION } }).then((r) => r.json()).then((data) => {
				const mismatch = versionMismatchLine();
				if (mismatch !== null) {
					// Whatever else is true, the running app is half-updated: that
					// alone explains a gate nobody asked for.
					err.textContent = mismatch;
					return;
				}
				if (data && data.passwordSet !== true) {
					err.textContent = "主机尚未设置访问口令，请先在本机设置页配置";
					input.disabled = true;
					button.disabled = true;
				}
			}).catch(() => {});
			// The gate is our own overlay, not official UI: on touch devices do not
			// pop the input method before the user asks for it (the gate remounts
			// after a refused key or a keyless 403, so it could happen repeatedly).
			// Mouse/keyboard clients keep the autofocus convenience.
			const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
			if (!coarsePointer) input.focus();
		}
		async function initGate() {
			// The server decides (TCP peer). Anything other than an explicit
			// "remote" — a "yes", or no answer at all — leaves the GUI alone.
			if ((await detectLocalClient()) !== false) return;
			const key = storedKey();
			if (await verifyKey(key)) {
				store.set({ unlocked: true });
				return;
			}
			clearStoredKey();
			store.set({ unlocked: false });
			mountGate();
		}

		// ── desktop workspace-folder picker (shadows the official dialog) ─────
		// dsh-lan-tool can bind 0.0.0.0, so the directory-picker resolver
		// (bindHost !== "127.0.0.1" → `browse` backend) serves the in-app
		// DirectoryBrowser on every client — crumbs + path editing, no drive
		// enumeration. We shadow both directoryFlow holes (single slots; the
		// runner assigns strictly decreasing priorities, lowest renders) with
		// our own dialog that adds a drive dropdown, matching the mobile UI
		// (v36). v71: the shadow applies to the host machine too.
		const h = (type, props, ...children) => react.createElement(type, props, ...children);
		const PICKER_CSS = ".dshLanP_overlay{position:fixed;inset:0;z-index:10000;background:rgba(15,18,24,.45);display:flex;align-items:center;justify-content:center;padding:20px;font:13px/1.5 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}.dshLanP_card{width:100%;max-width:680px;max-height:min(560px,100dvh - 40px);background:#ffffff;border:1px solid #d9dee6;border-radius:12px;display:flex;flex-direction:column;gap:10px;padding:16px;overflow:hidden;box-shadow:0 12px 40px rgba(15,18,24,.28);color-scheme:light}.dshLanP_title{font-size:15px;font-weight:600;color:#1c2128;margin:0}.dshLanP_row{display:flex;gap:8px;align-items:center}.dshLanP_row label{flex:none;color:#5b6472}.dshLanP_row select,.dshLanP_row input{flex:1;min-width:0;height:32px;border-radius:8px;border:1px solid #cfd5dd;background:#ffffff;color:#1c2128;font:inherit;font-size:13px;padding:0 10px;outline:none}.dshLanP_row select:focus,.dshLanP_row input:focus{border-color:#4c8dff}.dshLanP_row input::placeholder{color:#98a0ab}.dshLanP_row button{flex:none;height:32px;border-radius:8px;border:1px solid #cfd5dd;background:#f1f3f6;color:#1c2128;font:inherit;font-size:13px;padding:0 14px;cursor:pointer}.dshLanP_row button:disabled{opacity:.5;cursor:default}.dshLanP_row button:hover:not(:disabled){background:#e6e9ee}.dshLanP_crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center;min-height:22px}.dshLanP_crumb{padding:2px 8px;border:none;background:none;color:#2f6fed;font:inherit;font-size:12.5px;cursor:pointer;border-radius:6px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshLanP_crumb:hover{background:#eef1f6}.dshLanP_entries{flex:1;min-height:160px;max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;border:1px solid #cfd5dd;border-radius:8px;padding:6px;background:#ffffff}.dshLanP_entry{padding:7px 10px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:8px;color:#1c2128;word-break:break-all}.dshLanP_entry:hover{background:#f0f2f5}.dshLanP_entry::before{content:\"📁\";font-size:12px;flex:none}.dshLanP_entry.hidden{color:#98a0ab}.dshLanP_entry.hidden::before{content:\"·\"}.dshLanP_err{color:#d93026;font-size:12.5px;min-height:16px}.dshLanP_note{color:#8a919c;font-size:12px}.dshLanP_actions{display:flex;justify-content:flex-end;gap:8px}.dshLanP_actions button{height:32px;border-radius:8px;border:1px solid #cfd5dd;background:#f1f3f6;color:#1c2128;font:inherit;font-size:13px;padding:0 16px;cursor:pointer}.dshLanP_actions button:hover:not(:disabled){background:#e6e9ee}.dshLanP_actions button.primary{background:#4c8dff;border-color:#4c8dff;color:#ffffff;font-weight:600}.dshLanP_actions button:disabled{opacity:.5;cursor:default}";
		function ensurePickerStyle() {
			const id = "dsh-lan-tool/picker.css";
			if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-lan-tool";
			tag.dataset.pluginCss = id;
			tag.textContent = PICKER_CSS;
			document.head.appendChild(tag);
		}
		const LAN_PICKER_NS = "dsh-lan-picker";
		function isWindowsStylePath(p) {
			return typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p);
		}
		function pickerRootOf(value) {
			return value && value.crumbs && value.crumbs.length ? value.crumbs[0].path : "";
		}
		/**
		* Normalize one listDirectory call: an ABSENT method (an inject face that
		* wired the wrong service — the historical `ctx.workspaces` mistake) is a
		* synchronous TypeError, which would escape the caller's `.then/.catch`
		* chain and crash the whole slot entry (the outlet then abdicates the
		* entry and the seat watcher re-seats it every tick → the dialog flickers).
		* Everything is funneled into one rejected promise instead.
		*/
		function callListDirectory(listDirectory, path, signal) {
			if (typeof listDirectory !== "function") {
				return Promise.reject(new Error("directory listing backend is unavailable (listDirectory missing)"));
			}
			try {
				return Promise.resolve(listDirectory(path, signal));
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async function pickerProbe(listDirectory, root, ms) {
			const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
			const timer = ctl ? window.setTimeout(() => ctl.abort(), ms) : null;
			try {
				return await callListDirectory(listDirectory, root, ctl ? ctl.signal : void 0);
			} finally {
				if (timer !== null) window.clearTimeout(timer);
			}
		}
		// Windows: probe A:–Z: and report existing drive roots. POSIX hosts have
		// no drive letters — the caller hides the drive row instead.
		async function probePickerDrives(listDirectory, listing, token, onDone) {
			const sample = (listing && (listing.path || listing.home)) || "";
			if (!isWindowsStylePath(sample)) {
				onDone({ visible: false, drives: [] });
				return;
			}
			const letters = [];
			for (let i = 0; i < 26; i++) letters.push(String.fromCharCode(65 + i));
			const settled = await Promise.allSettled(letters.map((L) => pickerProbe(listDirectory, L + ":\\", 8000)));
			if (token.stale) return;
			const found = [];
			for (const s of settled) {
				if (s.status === "fulfilled" && s.value && s.value.path) found.push(s.value.path);
			}
			onDone({ visible: true, drives: found });
		}
		/**
		* Desktop folder-picker occupant for the workspace directoryFlow holes.
		* Props contract mirrors the official BrowseDirectoryFlow: owner side
		* {open, busy, onPicked, onCancel, onError} + inject face
		* {listDirectory(path, signal), createDirectory(path, name), t(key)}.
		*/
		function LanDirectoryFlow(props) {
			const [listing, setListing] = react.useState(null);
			const [phase, setPhase] = react.useState("idle"); // idle|loading|ready|error
			const [error, setError] = react.useState("");
			const [pathInput, setPathInput] = react.useState("");
			const [newName, setNewName] = react.useState("");
			const [drives, setDrives] = react.useState(null); // null probing / [] none / roots
			const [driveVisible, setDriveVisible] = react.useState(false);
			const [currentRoot, setCurrentRoot] = react.useState("");
			const seqRef = react.useRef(0); // drops stale listing responses
			const probeToken = react.useRef({ stale: false });

			const list = react.useCallback((path) => {
				const seq = ++seqRef.current;
				setPhase("loading");
				setError("");
				callListDirectory(props.listDirectory, path).then((value) => {
					if (seq !== seqRef.current) return;
					setListing(value);
					setCurrentRoot(pickerRootOf(value));
					setPathInput(value.path || "");
					setPhase("ready");
				}).catch((e) => {
					if (seq !== seqRef.current) return;
					setPhase("error");
					setError(props.t("errList") + " " + ((e && e.message) || String(e)));
				});
			}, [props.listDirectory, props.t]);

			react.useEffect(() => {
				if (!props.open) return;
				const seq = ++seqRef.current;
				probeToken.current.stale = true;
				probeToken.current = { stale: false };
				const token = probeToken.current;
				setPhase("loading");
				setError("");
				setDrives(null);
				callListDirectory(props.listDirectory).then((value) => {
					if (seq !== seqRef.current) return;
					setListing(value);
					setCurrentRoot(pickerRootOf(value));
					setPathInput(value.path || "");
					setPhase("ready");
					const win = isWindowsStylePath(value.path) || isWindowsStylePath(value.home);
					setDriveVisible(win);
					if (win) {
						void probePickerDrives(props.listDirectory, value, token, (out) => {
							if (token.stale) return;
							setDriveVisible(out.visible);
							setDrives(out.drives);
						});
					}
				}).catch((e) => {
					if (seq !== seqRef.current) return;
					setPhase("error");
					setError(props.t("errList") + " " + ((e && e.message) || String(e)));
				});
			}, [props.open, props.listDirectory, props.t]);

			react.useEffect(() => {
				if (!props.open) return;
				const onKey = (event) => { if (event.key === "Escape") props.onCancel(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [props.open, props.onCancel]);

			if (!props.open) return null;

			const t = props.t;
			const busy = props.busy === true;
			const ready = phase === "ready";
			const gotoPath = () => {
				const p = pathInput.trim();
				if (p) list(p);
			};
			const mkdir = () => {
				const name = newName.trim();
				if (!name || !listing) return;
				const parent = listing.path;
				setPhase("loading");
				setError("");
				props.createDirectory(parent, name).then(() => {
					setNewName("");
					list(parent);
				}).catch((e) => {
					setPhase("ready");
					setError(t("errCreate") + " " + ((e && e.message) || String(e)));
				});
			};
			const driveOptions = [];
			if (drives === null) driveOptions.push(h("option", { key: "probe", value: "" }, t("probing")));
			else if (drives.length === 0) driveOptions.push(h("option", { key: "none", value: "" }, t("noDrives")));
			else {
				for (let i = 0; i < drives.length; i++) {
					const root = drives[i];
					driveOptions.push(h("option", { key: root, value: root }, root.replace(/\\$/, "")));
				}
			}
			const crumbs = [];
			for (const crumb of (listing ? listing.crumbs : []) || []) {
				crumbs.push(h("button", {
					key: crumb.path,
					type: "button",
					className: "dshLanP_crumb",
					onClick: () => list(crumb.path),
					children: crumb.path === (listing && listing.home) ? t("home") : crumb.name
				}));
			}
			const rows = [];
			for (const entry of (listing ? listing.entries : []) || []) {
				rows.push(h("div", {
					key: entry.path,
					className: "dshLanP_entry" + (entry.hidden ? " hidden" : ""),
					onClick: () => list(entry.path),
					children: entry.name
				}));
			}
			return h("div", { className: "dshLanP_overlay" },
				h("div", { className: "dshLanP_card" },
					h("div", { className: "dshLanP_title", children: t("title") }),
					driveVisible ? h("div", { className: "dshLanP_row" },
						h("label", { children: t("drive") }),
						h("select", {
							value: currentRoot,
							onChange: (e) => { const root = e.target.value; if (root) list(root); },
							children: driveOptions
						})
					) : null,
					h("div", { className: "dshLanP_crumbs", children: crumbs }),
					h("div", { className: "dshLanP_entries", children: rows }),
					(listing && listing.truncated) ? h("div", { className: "dshLanP_note", children: t("truncated") }) : null,
					h("div", { className: "dshLanP_row" },
						h("input", {
							type: "text",
							placeholder: t("pathPlaceholder"),
							value: pathInput,
							onChange: (e) => setPathInput(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") gotoPath(); }
						}),
						h("button", { type: "button", onClick: gotoPath, children: t("jump") })
					),
					h("div", { className: "dshLanP_row" },
						h("input", {
							type: "text",
							placeholder: t("newFolderPlaceholder"),
							value: newName,
							onChange: (e) => setNewName(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") mkdir(); }
						}),
						h("button", { type: "button", onClick: mkdir, disabled: !ready || !newName.trim(), children: t("create") })
					),
					h("div", { className: "dshLanP_err", children: error || "" }),
					h("div", { className: "dshLanP_actions" },
						h("button", { type: "button", onClick: props.onCancel, children: t("cancel") }),
						h("button", { type: "button", className: "primary", disabled: !ready || busy, onClick: () => props.onPicked(listing.path), children: busy ? t("creating") : t("open") })
					)
				)
			);
		}

		// ── sidebar lock button (v48) ────────────────────────────────────────
		// The lock control for LAN clients sits in the official sidebar foot:
		// `sidebar.footer.action` entries render directly above the
		// `sidebar.settings` trigger (SettingsRoot), so the button appears right
		// above the bottom-left settings gear. It mirrors the settings
		// trigger's own CSS (same geometry, tokens, hover and rail variant) —
		// "样式与设置按钮一致". Visible only for non-loopback clients that have
		// unlocked (the gate flow sets store.unlocked); clicking it clears the
		// stored key and re-mounts the login gate.
		const LOCK_ICON_PATH = "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z";
		function LanLockButton({ wide, t }) {
			const unlocked = useLan((snapshot) => snapshot.unlocked);
			if (clientIsLocal() || unlocked !== true) return null;
			return h("button", {
				type: "button",
				className: "dshLanLock" + (wide ? "" : " rail"),
				title: t("lock"),
				"aria-label": t("lock"),
				onClick: () => {
					clearStoredKey();
					store.set({ unlocked: false });
					mountGate();
				},
				children: [
					h("svg", {
						viewBox: "0 0 24 24",
						width: wide ? 16 : 18,
						height: wide ? 16 : 18,
						fill: "currentColor",
						"aria-hidden": "true",
						children: h("path", { d: LOCK_ICON_PATH })
					}),
					wide ? h("span", { className: "dshLanLockLabel", children: t("lock") }) : null
				]
			});
		}

		// ── plugin ───────────────────────────────────────────────────────────
		// Cordis inject takes SERVICE names (what `ctx.get()` returns), not
		// package names. The web client provides `slots` (slot ledger/renderer),
		// `locale` and `connection`; the older package-name list left the
		// fiber pending forever (no service is ever provided under a package
		// name), which failed the whole boot with "Failed to load plugins".
		// `uiWorkspace` backs the desktop folder-picker dialog's browse calls: on
		// current DSH the directory capability (listDirectory / createDirectory)
		// lives on the workspace UI service provided by
		// @deepseek-ai/dsh-client-ui-workspace — exactly what the official
		// directory-picker client half injects. `workspaces` (the bare Workspace
		// controller) only offers create/rename/delete/reorder and is kept as a
		// legacy fallback for older DSH builds that still hung the browse calls
		// there.
		//
		// v1.4.0 — `settingsScope` is GONE on purpose. It no longer exists in
		// DSH 0.2.x (0 hits across the whole tree), and a pending fiber is a
		// HARD boot failure on current DSH: the shell renders "Failed to load
		// plugins" and lists every entry that did not activate. The old
		// `lanHostMode()` helper that flipped the official settings mirror to
		// host mode after unlock was deleted with it: `persistence` is a
		// one-shot constant captured at construction time
		// (dsh-client-ui-settings), several objects subscribe or bail out based
		// on it, and DSH withholds that scope from non-loopback pages
		// deliberately. So LAN users get chat / model / work-mode switching and
		// full workspace & session access, while official settings, permission
		// and credential pages stay host-only — which is what the card's copy
		// now says.
		const inject = [
			"slots",
			"locale",
			"connection",
			"workspaces",
			"uiWorkspace"
		];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("settings.dsh-lan-tool", {
				zh: {
					"title": "局域网访问（dsh-lan-tool）",
					"description": "允许局域网设备打开本页面操作此 DeepSeek Harness。局域网用户可聊天、切换模型与工作模式，并可使用工作区与会话；官方设置、权限与凭据页面只在主机上可用（DSH 对非本机浏览器不提供设置作用域）。请仅在信任的网络启用。",
					"toggle.on": "\u5f00\u542f\u5c40\u57df\u7f51\u8bbf\u95ee",
					"toggle.off": "\u5173\u95ed\u5c40\u57df\u7f51\u8bbf\u95ee",
					"status.bind": "\u7ed1\u5b9a\uff1a",
					"status.bindLocal": "本机监听：",
					"status.proxy": "局域网由插件内置反向代理提供（不改动 DSH 的绑定）",
					"status.urls": "\u5c40\u57df\u7f51\u5730\u5740\uff1a",
					"status.off": "当前仅本机可访问。",
					"status.applying": "正在生效：正在开／关局域网反向代理，稍后自动刷新…",
					"warning.noPassword": "未设口令：局域网设备暂时无法进入，请先在下方设置访问口令。",
					"password.required": "请先设置访问口令",
					"firewall.ok": "\u9632\u706b\u5899\u5df2\u653e\u884c",
					"firewall.bad": "\u9632\u706b\u5899\u672a\u653e\u884c\uff08\u9700\u7ba1\u7406\u5458\u6743\u9650\uff09",
					"firewall.na": "\u9632\u706b\u5899\u672a\u7531\u63d2\u4ef6\u7ba1\u7406\uff08\u672a\u68c0\u6d4b\u5230\u53d7\u652f\u6301\u7684\u9632\u706b\u5899\uff09",
					"firewall.system": "\u9632\u706b\u5899\u5df2\u653e\u884c\uff08\u7cfb\u7edf\u89c4\u5219\uff09",
					"firewall.retry": "\u7cfb\u7edf\u89c4\u5219\u4f1a\u81ea\u52a8\u8bc6\u522b\uff0c\u65e0\u9700\u91cd\u542f",
					"firewall.checking": "\u9632\u706b\u5899\uff1a\u6b63\u5728\u786e\u8ba4\u7cfb\u7edf\u662f\u5426\u653e\u884c\u2026",
					"password.set": "\u5df2\u8bbe\u53e3\u4ee4",					"password.unset": "\u672a\u8bbe\u53e3\u4ee4",
					"password.placeholder": "\u8bbe\u7f6e\u53e3\u4ee4\uff08\u81f3\u5c11 4 \u4f4d\uff09",
					"password.save": "\u4fdd\u5b58\u53e3\u4ee4",
					"password.clear": "\u6e05\u9664\u53e3\u4ee4",
					"hostOnly.note": "这些设置只能在主机（本机）上修改；局域网设备可以正常使用，但不能改口令、端口或开关。",
					"notice.trusted": "仅适用于在安全可信局域网中使用，请勿在其他网络环境开启",
					"port.label": "局域网端口",
					"port.placeholder": "留空 = 跟随 DSH（每次启动可能不同）",
					"port.help": "固定后局域网地址不再随 DSH 重启而改变：已打开的页面、书签与二维码都能继续用。端口被占用时只是无法局域网访问，不会影响应用启动。",
					"port.apply": "应用端口",
					"port.invalid": "端口需在 1024–65535 之间",
					"unlock.placeholder": "\u8f93\u5165\u53e3\u4ee4\u89e3\u9501\u5168\u529f\u80fd",
					"unlock.btn": "\u89e3\u9501",
					"unlock.unlocked": "已解锁：可聊天、切换模型与工作模式；设置项请在主机上修改",
					"unlock.failed": "\u53e3\u4ee4\u9519\u8bef",
					"lock": "\u9501\u5b9a",
					"error": "\u52a0\u8f7d\u5931\u8d25\uff1a"
				},
				en: {
					"title": "LAN access (dsh-lan-tool)",
					"description": "Let LAN devices open this page and operate this DeepSeek Harness. LAN users can chat, switch models and work modes, and use workspaces and sessions; the official settings, permissions and credentials pages stay host-only (DSH withholds the settings scope from non-loopback browsers). Enable only on trusted networks.",
					"toggle.on": "Enable LAN access",
					"toggle.off": "Disable LAN access",
					"status.bind": "Bind:",
					"status.bindLocal": "Local listener:",
					"status.proxy": "LAN access is served by the plugin's own reverse proxy (DSH's bind is untouched)",
					"status.urls": "LAN URLs:",
					"status.off": "Currently localhost-only.",
					"status.applying": "Applying: opening/closing the LAN reverse proxy, refreshing in a moment\u2026",
					"warning.noPassword": "No password set: LAN devices cannot get in yet \u2014 set an access password below.",
					"password.required": "Set an access password first",
					"firewall.ok": "firewall open",
					"firewall.bad": "firewall blocked (needs admin)",
					"firewall.na": "firewall not managed (no supported firewall detected)",
					"firewall.system": "firewall open (OS rule)",
					"firewall.retry": "OS rules are picked up automatically",
					"firewall.checking": "Firewall: checking whether the system admits this port\u2026",
					"password.set": "password set",
					"password.unset": "no password",
					"password.placeholder": "Set password (min 4 chars)",
					"password.save": "Save password",
					"password.clear": "Clear password",
					"hostOnly.note": "These settings can only be changed on the host machine; a LAN device can use the GUI but cannot change the password, port or switch.",
					"notice.trusted": "Trusted LAN only - do not enable on other networks",
					"port.label": "LAN port",
					"port.placeholder": "Empty = follow DSH (may change every launch)",
					"port.help": "Pinning it keeps the LAN URL stable across DSH restarts, so open pages, bookmarks and QR codes keep working. If the port is taken you simply lose LAN access \u2014 the app still starts.",
					"port.apply": "Apply port",
					"port.invalid": "Port must be between 1024 and 65535",
					"unlock.placeholder": "Enter password to unlock everything",
					"unlock.btn": "Unlock",
					"unlock.unlocked": "Unlocked: chat, model and work-mode switching; change settings on the host machine",
					"unlock.failed": "Wrong password",
					"lock": "Lock",
					"error": "Failed to load:"
				}
			}), "dsh-lan-tool: dictionaries");

			ctx.effect(() => ctx.locale.register(LAN_PICKER_NS, {
				zh: {
					"title": "选择工作区目录",
					"drive": "盘符",
					"home": "主目录",
					"jump": "跳转",
					"pathPlaceholder": "输入路径，如 D:\\、C:\\Users\\name 或 /home/name",
					"newFolderPlaceholder": "在此新建文件夹…",
					"create": "创建",
					"open": "打开",
					"cancel": "取消",
					"creating": "正在创建…",
					"loading": "加载中…",
					"probing": "检测盘符中…",
					"noDrives": "未检测到磁盘",
					"truncated": "文件夹过多，仅显示开头部分。",
					"errList": "无法打开文件夹：",
					"errCreate": "新建文件夹失败："
				},
				en: {
					"title": "Select Workspace Directory",
					"drive": "Drive",
					"home": "Home",
					"jump": "Go",
					"pathPlaceholder": "Type a path, e.g. D:\\, C:\\Users\\name or /home/name",
					"newFolderPlaceholder": "New folder",
					"create": "Create",
					"open": "Open",
					"cancel": "Cancel",
					"creating": "Creating…",
					"loading": "Loading…",
					"probing": "Detecting drives…",
					"noDrives": "No drives detected",
					"truncated": "Too many folders to list; only the beginning is shown.",
					"errList": "Cannot open folder: ",
					"errCreate": "Failed to create folder: "
				}
			}), "dsh-lan-tool: picker dictionaries");

			// Shadow the official workspace folder-picker dialog on the desktop
			// SPA (both directoryFlow holes) with our own dialog that adds a
			// drive dropdown. Boot-manifest plugins all register at the default
			// priority 0 (the runner's auto-priority only applies to on-demand
			// dynamic packages) — a same-priority second registration THROWS and
			// fails that plugin's apply. So we seat ourselves at a strictly
			// LOWER priority: the official picker then applies cleanly at 0 and
			// our occupant wins the `single` hole ("lowest renders"). A watcher
			// restores the seat if it is ever lost or abdicated (crashed), and
			// pauses while our dialog is open so an in-flight flow never
			// remounts mid-navigation.
			// v71: shadow the official workspace folder-picker on loopback too
			// — the custom dialog (drive dropdown, path jump) applies on the
			// host machine as well, restoring the pre-v49 behavior.
			{
				ensurePickerStyle();
				// Resolve the directory-browse service lazily (the face is built per
				// registration, so the seat can be re-seated after a service swap):
				// prefer the workspace UI service that owns listDirectory on current
				// DSH, fall back to the bare Workspace controller for older builds.
				// Whatever comes back is passed on as-is — an absent method is
				// reported inside the dialog by callListDirectory, never by crashing
				// the slot entry.
				const pickerBrowse = () => {
					const candidates = ["uiWorkspace", "workspaces"];
					for (const serviceName of candidates) {
						let service = null;
						try {
							service = ctx.get(serviceName);
						} catch (error) {
							service = null;
						}
						if (service && typeof service.listDirectory === "function") return service;
					}
					for (const serviceName of candidates) {
						let service = null;
						try {
							service = ctx.get(serviceName);
						} catch (error) {
							service = null;
						}
						if (service) return service;
					}
					return {};
				};
				/**
				 * The dialog's data source (v1.5.8).
				 *
				 * It cannot be `uiWorkspace.listDirectory()` any more: since DSH
				 * 0.2.1 the Host must bind loopback (a wildcard host is rejected
				 * and the app would not start), and `dsh-host-directory-picker-auto`
				 * composes the NATIVE picker whenever the bind is loopback. In that
				 * composition `directoryPicker/list` does not exist, so every call
				 * answered `directory-picker/unavailable` — the dialog opened on an
				 * error ("无法打开文件夹：… directory browse failed …"). The Host is
				 * the one process that can read its own filesystem, so this plugin
				 * serves the two primitives itself (`/dsh-lan/fs/*`, behind the
				 * same door as every other LAN endpoint) and keeps the dialog
				 * working on the host AND on a LAN device.
				 *
				 * A `null` return means the node half is older than 1.5.8 and has
				 * no such route (404): the caller then falls back to the official
				 * service, exactly as before.
				 */
				const lanFsCall = async (url, init) => {
					const response = await window.fetch(url, {
						cache: "no-store",
						headers: { "x-dsh-lan-client": PLUGIN_VERSION, ...(init?.headers ?? {}) },
						...init
					});
					// Not our endpoint: an older node half answers 404, and DSH's
					// frontend catch-all answers 200 with the SPA shell for an
					// unregistered path. Only our own JSON is a real answer.
					const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
					if (response.status === 404 || !contentType.includes("application/json")) return null;
					const data = await response.json().catch(() => null);
					if (data === null) return null;
					if (data.ok !== true) {
						const error = new Error(data?.error?.message ?? ("HTTP " + response.status));
						error.code = data?.error?.code;
						throw error;
					}
					return data.value;
				};
				const lanListDirectory = async (path, signal) => {
					const query = typeof path === "string" && path !== "" ? "?path=" + encodeURIComponent(path) : "";
					const value = await lanFsCall("/dsh-lan/fs/list" + query, signal === void 0 ? {} : { signal });
					if (value !== null) return value;
					const browse = pickerBrowse();
					return browse.listDirectory(path, signal);
				};
				const lanCreateDirectory = async (path, name) => {
					const value = await lanFsCall("/dsh-lan/fs/mkdir", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ path, name })
					});
					if (value !== null) return value;
					const browse = pickerBrowse();
					return browse.createDirectory(path, name);
				};
				const pickerInjected = () => ({
					listDirectory: lanListDirectory,
					createDirectory: lanCreateDirectory,
					t: ctx.locale.bind(LAN_PICKER_NS)
				});
				const PICKER_HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];
				const pickerSeats = {};
				// Crash-loop dampener. Re-seating an entry that dies again within
				// PICKER_SEAT_STABLE_MS is a crash loop, not normal churn: retrying
				// it every tick makes the dialog flicker open/closed forever. Track
				// it per hole and back off exponentially (an engine-side service
				// swap arrives as a `connection/reset`, which resets the budget).
				const PICKER_SEAT_STABLE_MS = 5000;
				const PICKER_SEAT_RETRY_MAX_MS = 60000;
				const pickerHealth = {};
				for (const hole of PICKER_HOLES) pickerHealth[hole] = { at: 0, retries: 0, blockedUntil: 0 };
				const pickerBackoffTimers = new Set();
				ctx.on("connection/reset", () => {
					for (const timer of pickerBackoffTimers) window.clearTimeout(timer);
					pickerBackoffTimers.clear();
					for (const hole of PICKER_HOLES) {
						pickerHealth[hole] = { at: 0, retries: 0, blockedUntil: 0 };
					}
				});
				ctx.effect(() => {
					const seatIfNeeded = () => {
					// our dialog is open — never churn the entry mid-flow
					if (document.querySelector(".dshLanP_overlay") !== null) return;
					const now = Date.now();
					for (const hole of PICKER_HOLES) {
						if (ctx.slots.spec(hole) === void 0) continue; // not declared yet
						const winners = (typeof ctx.slots.entriesOfSlot === "function" ? ctx.slots.entriesOfSlot(hole) : ctx.slots.entries(hole)) || [];
						const winner = winners[0];
						if (winner && winner.registrant === "dsh-lan-tool") continue; // seated and winning
						const health = pickerHealth[hole];
						if (health.blockedUntil > now) continue; // backing off after a crash loop
						if (pickerSeats[hole]) { pickerSeats[hole](); pickerSeats[hole] = null; }
						if (health.at !== 0 && now - health.at < PICKER_SEAT_STABLE_MS) {
							health.retries += 1;
							health.blockedUntil = now + Math.min(PICKER_SEAT_RETRY_MAX_MS, 1000 * Math.pow(2, health.retries - 1));
							const timer = window.setTimeout(() => {
								pickerBackoffTimers.delete(timer);
								seatIfNeeded();
							}, health.blockedUntil - now);
							pickerBackoffTimers.add(timer);
							if (health.retries === 3) {
								console.error("[dsh-lan-tool] the workspace folder-picker dialog keeps failing right after it mounts; retrying with backoff. The previous failure is logged above by the slot error boundary.");
							}
							continue;
						}
						health.at = now;
						try {
							pickerSeats[hole] = ctx.slots.register({
								name: hole,
								priority: -1000,
								registrant: "dsh-lan-tool",
								inject: pickerInjected
							}, LanDirectoryFlow);
							health.retries = 0;
							health.blockedUntil = 0;
						} catch (error) {
							console.error("[dsh-lan-tool] picker shadow registration failed for " + hole, error);
						}
					}
					};
					seatIfNeeded();
					const watch = window.setInterval(seatIfNeeded, 1000);
					return () => {
						window.clearInterval(watch);
						for (const timer of pickerBackoffTimers) window.clearTimeout(timer);
						pickerBackoffTimers.clear();
						for (const hole of PICKER_HOLES) {
						if (pickerSeats[hole]) { pickerSeats[hole](); pickerSeats[hole] = null; }
						}
					};
				}, "dsh-lan-tool: picker shadow");
			}
			installLanFetchReroute();
			// Hide host-only header affordances (the app launcher) when this
			// browser is on a LAN device rather than the host itself.
			void syncNonLocalPosture();
			// Host machine (or an unknown answer): never gated — stock DSH
			// behaviour, no key, no unlock, no overlay (the server sees a
			// loopback/local peer). Only an explicit "you are remote" proceeds to
			// the silent remembered-key resume and the gate.
			void detectLocalClient().then((isHost) => {
				if (isHost !== false) return;
				const remembered = storedKey();
				if (remembered !== "") {
					// Re-establish the session transport cookie after a browser
					// restart: the remembered key re-verifies silently so
					// navigations and the event-stream upgrade keep working
					// without another password prompt.
					void unlock(remembered).then((ok) => {
						if (!ok) clearStoredKey();
					});
				}
				void initGate();
			});
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "dsh-lan-tool",
				order: -15,
				locale: "settings.dsh-lan-tool",
				inject: () => ({
					hooks: { lan: store },
					refresh: fetchStatus,
					configure,
					setPassword,
					clearPassword,
					unlock
				})
			}, LanRow));
			// settings trigger (`sidebar.settings`). It is a LIST slot — each
			// registrant needs its own id; order 10 keeps it below the official
			// cordis-panel badge (order 0) so it is the entry directly above
			// the settings button. Our CSS wraps the foot row so the two
			// full-width entries stack instead of overflowing.
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-lan-tool-lock",
				order: 10,
				locale: "settings.dsh-lan-tool"
			}, LanLockButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
