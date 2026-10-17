import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * The header this proxy stamps on every forwarded request (v1.5.5).
 *
 * Everything arriving at DSH from here has a loopback TCP peer, so DSH's own
 * "is this the host machine?" test (`isLocalRequest`) says yes for a LAN client
 * too — and endpoints that are supposed to be host-only (changing the password,
 * flipping the switch, reading diagnostics) would accept a LAN device that merely
 * knows the password. The stamp lets those endpoints tell the two apart. Its value
 * is random per process, and any client-supplied copy is dropped before the stamp
 * is applied, so it cannot be forged by anything that does not already run in this
 * process.
 */
export const PROXY_HEADER = "x-dsh-lan-via";
const PROXY_TOKEN = randomBytes(16).toString("hex");

/**
 * Whether this process's proxy forwarded the request.
 * @param req - request whose headers should be inspected.
 * @returns true when the stamp matches this process.
 */
export function viaProxy(req) {
	return req?.headers?.[PROXY_HEADER] === PROXY_TOKEN;
}

/**
 * LAN reverse proxy (v1.5.0).
 *
 * WHY THIS EXISTS — DSH 0.2.1-rc.2 made the old design impossible, twice over:
 *
 * 1. `@deepseek-ai/dsh-host-webserver` now validates its `host` as a concrete
 *    IPv4/IPv6 literal and REJECTS wildcard addresses outright ("binding every
 *    interface would expose remote code execution to the network"). The old
 *    managed patch block wrote `host: '0.0.0.0'`; because `webserver` is a
 *    REQUIRED row, that made the whole Host refuse to start — and since the
 *    webserver failed first, this plugin never loaded, so it could not heal
 *    itself. Writing any `webserver` override is therefore off the table.
 *
 * 2. The desktop shell pins loopback: it spawns the Host with
 *    `--host 127.0.0.1 --port 0` and authenticates against a URL it builds as
 *    `http://127.0.0.1:<port>/?token=…` (measured: binding a concrete
 *    non-loopback address makes that fetch fail with ECONNREFUSED). So DSH's own
 *    listener must stay on 127.0.0.1 for the desktop app to start at all.
 *
 * With DSH on loopback, the only way onto the LAN is a listener of our own: this
 * module accepts connections on the machine's LAN addresses and forwards them to
 * the loopback listener. It reuses the DSH port number, which is legal because
 * the two listeners bind different concrete addresses (measured on Windows:
 * 127.0.0.1:P + 192.168.x.y:P coexist happily).
 *
 * The password gate lives HERE, not in DSH: every forwarded connection arrives
 * from 127.0.0.1, which DSH's own peer test rightly reads as "the host machine".
 * `admit` is the caller's decision; this module only frames requests.
 */

/** How long a resolved LAN-address set is reused before asking the OS again. */
const ADDRESS_TTL_MS = 10000;

/** Hop-by-hop headers that must not be relayed (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
]);

/**
 * Every address this machine can serve the LAN on: non-internal IPv4 addresses
 * of every interface. Deliberately NOT the wildcard: the upstream platform just
 * removed wildcard binding as an RCE-exposure hazard, and binding the concrete
 * addresses it would have covered keeps the same reach without listening on
 * interfaces that did not exist when the user opted in.
 * @returns addresses, newest interfaces included, deduplicated.
 */
export function lanAddresses() {
	const out = [];
	try {
		for (const list of Object.values(networkInterfaces())) {
			for (const iface of list ?? []) {
				if (iface === undefined || iface.internal) continue;
				const family = iface.family;
				if (family !== "IPv4" && family !== 4) continue;
				const address = String(iface.address ?? "").trim();
				if (address === "" || out.includes(address)) continue;
				out.push(address);
			}
		}
	} catch {
		// keep whatever was collected
	}
	return out;
}

/** Relay `req` to the target and stream the response back. */
function forwardHttp(req, res, target, log) {
	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		// Never relay a client's own copy of the provenance stamp.
		if (lower === PROXY_HEADER) continue;
		headers[key] = value;
	}
	headers[PROXY_HEADER] = PROXY_TOKEN;
	// The Host header is intentionally left EXACTLY as the browser sent it.
	// Connection binds its browser-session cookie to the request authority, so
	// rewriting Host to `127.0.0.1:<port>` here would make every forwarded
	// request look unauthenticated and re-mint a cookie for the wrong audience.
	const upstream = httpRequest({
		host: target.host,
		port: target.port,
		method: req.method,
		path: req.url,
		headers
	}, (upstreamRes) => {
		const out = {};
		for (const [key, value] of Object.entries(upstreamRes.headers)) {
			if (value === undefined) continue;
			if (HOP_BY_HOP.has(key.toLowerCase())) continue;
			out[key] = value;
		}
		try {
			res.writeHead(upstreamRes.statusCode ?? 502, out);
		} catch {
			upstreamRes.destroy();
			return;
		}
		upstreamRes.pipe(res);
	});
	upstream.on("error", (error) => {
		if (log !== undefined) log(`proxy: ${String(req.method)} ${String(req.url)} failed: ${String(error?.code ?? error?.message ?? error)}`);
		try {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-lan-tool: the local DSH listener did not answer\n");
		} catch {}
	});
	req.pipe(upstream);
}

/**
 * Tunnel a WebSocket upgrade: replay the request head verbatim over a raw socket
 * and then splice the two sockets. Replaying bytes (rather than re-framing with
 * a HTTP client) keeps every handshake header — `Sec-WebSocket-*`, subprotocols,
 * extensions — exactly as the browser sent it.
 */
function forwardUpgrade(req, clientSocket, head, target, log, onStatus) {
	const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
	const raw = req.rawHeaders ?? [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		// Drop a client's own copy of the provenance stamp, then append ours below.
		if (String(raw[i]).toLowerCase() === PROXY_HEADER) continue;
		lines.push(`${raw[i]}: ${raw[i + 1]}`);
	}
	lines.push(`${PROXY_HEADER}: ${PROXY_TOKEN}`);
	const upstream = netConnect(target.port, target.host, () => {
		upstream.write(lines.join("\r\n") + "\r\n\r\n");
		if (head !== undefined && head.length > 0) upstream.write(head);
		// Peek at the upstream's status line for the diagnostic record. This only
		// inspects bytes — the pipe below still delivers them untouched.
		if (onStatus !== undefined) {
			upstream.once("data", (chunk) => {
				try { onStatus(chunk.toString("latin1").split("\r\n")[0] ?? ""); } catch {}
			});
		}
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	/**
	 * Tear BOTH sides down as soon as either one goes away.
	 *
	 * This is not tidiness. DSH's `admitConnection` refuses a second upgrade for a
	 * peer that already owns a socket (409), and it only clears that flag when the
	 * socket really closes. On a LAN the client disappears abruptly all the time —
	 * a page reload, a phone sleeping, a Wi-Fi handover — and a bare `pipe()` does
	 * not reliably propagate that to the upstream socket. The result is a session
	 * that keeps "owning" a dead socket: every reconnect is refused and the client
	 * shows "reconnecting" for ever, while HTTP (the session list) still works.
	 * That is exactly the shape of the bug this teardown prevents.
	 */
	const teardown = () => {
		try { clientSocket.destroy(); } catch {}
		try { upstream.destroy(); } catch {}
	};
	clientSocket.on("close", teardown);
	clientSocket.on("end", teardown);
	clientSocket.on("error", teardown);
	upstream.on("close", teardown);
	upstream.on("end", teardown);
	upstream.on("error", (error) => {
		if (log !== undefined) log(`proxy: upgrade ${String(req.url)} failed: ${String(error?.code ?? error?.message ?? error)}`);
		teardown();
	});
}

/** Refuse a request that carries no LAN credential. */
function refuse(req, res) {
	const url = new URL(req.url ?? "/", "http://x");
	const isIndex = url.pathname === "/" || url.pathname === "/index.html";
	if (isIndex && (req.method === "GET" || req.method === "HEAD")) {
		res.writeHead(302, { location: "/dsh-lan/", "cache-control": "no-store" });
		res.end();
		return;
	}
	res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	res.end("dsh-lan-tool: LAN password required (open /dsh-lan/)\n");
}

/**
 * Whether the loopback listener we forward to is accepting connections.
 *
 * A door that forwards to nothing is worse than a closed one: it announces LAN
 * URLs that cannot work, and it holds the port. So the proxy never OPENS a
 * listener until the target answers. (An already-open listener is left alone
 * when the target goes away — it reports 502, which is the honest answer, and
 * the next boot or toggle re-evaluates.)
 * @param target - `{ host, port }` of the loopback listener.
 * @returns true when a TCP connection completes.
 */
function targetReachable(target) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			try { socket.destroy(); } catch {}
			resolve(ok);
		};
		const socket = netConnect(target.port, target.host);
		socket.setTimeout(1500, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/**
 * Create the LAN proxy. One listener per current LAN address, all on `port`
 * (the DSH port), each forwarding to the loopback listener.
 * @param options.target - `() => { host, port } | undefined`: the loopback DSH listener.
 * @param options.admit - `(req) => boolean`: whether this request may be forwarded.
 * @param options.log - diagnostic sink.
 * @param options.addresses - address source; defaults to {@link lanAddresses}. Injected by tests so they never touch a real interface.
 * @param options.listenPort - `() => number | undefined`: the port to LISTEN on. Returning a number pins the LAN door to a stable port; otherwise it follows the target's port, which means the LAN URL changes every time DSH restarts (the desktop launcher passes `--port 0`, so the OS picks a new one each launch — and an already-open LAN tab then reconnects to a dead port for ever).
 * @returns control surface: `refresh`, `stop`, `listening`, `port`, `addresses`.
 */
export function createLanProxy({ target, admit, log, addresses = lanAddresses, listenPort }) {
	/** address -> http.Server */
	const servers = new Map();
	let addressCache = { at: 0, list: [] };
	let refreshing = null;
	/**
	 * Recent door activity, for diagnosis. "The page loads but the conversation
	 * never connects" is otherwise invisible from the host side: HTTP succeeding
	 * says nothing about the event-stream upgrade. Each entry is one decision, with
	 * just enough context to tell a cookie problem apart from a transport problem.
	 */
	const events = [];
	const record = (entry) => {
		events.push({ at: Date.now(), ...entry });
		if (events.length > 60) events.shift();
	};
	/** The port the live listeners are bound to, or 0. */
	let boundPort = 0;
	/** The port this configuration wants: pinned if the caller pinned one. */
	const wantedPort = () => {
		if (listenPort !== undefined) {
			const pinned = listenPort();
			if (Number.isInteger(pinned) && pinned > 0) return pinned;
		}
		const up = target();
		return up === undefined ? undefined : up.port;
	};

	const currentAddresses = () => {
		const now = Date.now();
		if (now - addressCache.at < ADDRESS_TTL_MS) return addressCache.list;
		addressCache = { at: now, list: addresses() };
		return addressCache.list;
	};

	const bindOne = (address, port) => new Promise((resolve) => {
		const server = createServer((req, res) => {
			const up = target();
			if (up === undefined) {
				res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-lan-tool: the local DSH listener is not up yet\n");
				return;
			}
			let allowed = false;
			try { allowed = admit(req) === true; } catch { allowed = false; }
			if (!allowed) { refuse(req, res); return; }
			forwardHttp(req, res, up, log);
		});
		server.on("upgrade", (req, socket, head) => {
			const up = target();
			let allowed = false;
			try { allowed = up !== undefined && admit(req) === true; } catch { allowed = false; }
			// Recorded BEFORE forwarding: the interesting failure is an upgrade that
			// carries no credential at all (a browser that omits cookies on the
			// WebSocket handshake), which looks like "reconnecting" for ever while
			// every HTTP request on the same page works.
			const credential = {
				host: String(req.headers.host ?? ""),
				path: String(req.url ?? "").split("?")[0],
				cookie: typeof req.headers.cookie === "string" && req.headers.cookie !== "",
				key: typeof req.headers["x-dsh-lan-key"] === "string"
			};
			if (!allowed) {
				record({ kind: "upgrade-refused", ...credential });
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			record({ kind: "upgrade-open", ...credential });
			forwardUpgrade(req, socket, head, up, log, (status) => record({ kind: "upgrade-upstream", status, ...credential }));
		});
		// A malformed request must not take the listener down.
		server.on("clientError", (_error, socket) => {
			try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
		});
		server.once("error", (error) => resolve({ address, ok: false, error }));
		server.listen(port, address, () => {
			// Never hold the process open: the Host owns the lifetime.
			try { server.unref(); } catch {}
			resolve({ address, ok: true, server });
		});
	});

	/**
	 * Bind every LAN address that is not bound yet and drop listeners whose
	 * address disappeared. Also (re)arms the proxy after `stop()`, which is what
	 * makes the settings toggle work. Never throws: a failure on one address must
	 * not take the others (or the app) down.
	 * @returns the currently listening addresses.
	 */
	const refresh = () => {
		if (refreshing !== null) return refreshing;
		refreshing = (async () => {
			const up = target();
			const port = wantedPort();
			if (up === undefined || port === undefined || !Number.isInteger(port) || port <= 0) return [];
			// A changed port invalidates every existing listener: close them all and
			// rebind, so the pinned port takes effect on the next tick.
			if (servers.size > 0 && boundPort !== port) {
				for (const server of servers.values()) {
					try { server.close(); } catch {}
				}
				servers.clear();
				boundPort = 0;
			}
			// Never open a listener that forwards to nothing.
			if (servers.size === 0 && !(await targetReachable(up))) return [];
			const wanted = currentAddresses();
			for (const [address, server] of [...servers]) {
				if (wanted.includes(address)) continue;
				try { server.close(); } catch {}
				servers.delete(address);
				if (log !== undefined) log(`proxy: stopped listening on ${address}:${String(port)} (interface gone)`);
			}
			for (const address of wanted) {
				if (servers.has(address)) continue;
				const result = await bindOne(address, port);
				if (result.ok) {
					servers.set(address, result.server);
					boundPort = port;
					if (log !== undefined) log(`proxy: listening on ${address}:${String(port)}`);
				} else if (log !== undefined) {
					log(`proxy: cannot listen on ${address}:${String(port)} (${String(result.error?.code ?? result.error?.message ?? result.error)})`);
				}
			}
			return [...servers.keys()];
		})().finally(() => { refreshing = null; });
		return refreshing;
	};

	return {
		refresh,
		/** Recent door decisions, oldest first (see `record`). */
		events: () => [...events],
		/** Currently bound addresses (the LAN URLs users can open). */
		addresses: () => [...servers.keys()],
		/** Whether the LAN door is actually open. */
		listening: () => servers.size > 0,
		/** The port the LAN door listens on, or 0 before the first successful bind. */
		port: () => (boundPort > 0 ? boundPort : (wantedPort() ?? 0)),
		/**
		 * Close every listener. The proxy stays closed until the next
		 * `refresh()` — so a periodic re-check must ask the caller's desired
		 * state first, and the settings toggle re-opens by calling `refresh()`.
		 */
		stop: () => {
			addressCache = { at: 0, list: [] };
			for (const server of servers.values()) {
				try { server.close(); } catch {}
			}
			servers.clear();
			boundPort = 0;
		}
	};
}
