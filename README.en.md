# dsh-lan-tool

dsh-lan-tool — a plugin that brings the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI to your local network (password-protected; mobile reuses the official desktop UI with an injected portrait touch adaptation).

> ⚠️ **Version requirement: `@deepseek-ai/dsh` `0.2.0-rc.2` and newer; verified on the 0.2.1-rc.2 desktop build.** The 0.1.x APIs (`dsh-host-apiproxy`, dotted endpoints, the client-side `settingsScope` service) are no longer compatible — upgrade DSH first.
>
> 🔧 **1.5.0 changed how LAN access is implemented (read this before upgrading)**: since 0.2.1 DSH refuses to bind a wildcard address (`0.0.0.0`), while the desktop shell requires DSH itself to stay on `127.0.0.1`. So the plugin **no longer touches any DSH binding**: DSH keeps its official loopback-only listener and **the plugin's own built-in reverse proxy** serves your machine's LAN addresses, **reusing the same port number**. Your LAN URL and workflow are unchanged — but **the override older versions left in the profile patch makes 0.2.1 refuse to start**, so read the [Upgrading](#upgrading-14x--150important) section first.

> 🚀 **Pair it with [DSH-Launcher](https://github.com/MrMu666/DSH-Launcher) and [dsh-app](https://github.com/MrMu666/dsh-app) for a better experience.**

> 📦 **This package is a standard DSH plugin bundle** (it declares `dsh.bundle.patch`), installed through the official plugin mechanism. There are **no install scripts**, the on/off switch lives in **Settings**, and nothing asks for a password at install time.

Once installed, flip "LAN access" on in Settings and the GUI becomes reachable from the LAN (Windows opens the firewall automatically for Domain + Private; Linux tries firewalld / ufw / iptables in order and treats a missing firewall tool as "no rule needed"):

- ✅ **Off by default**: the bundle writes no `webserver` override at all, so the GUI keeps the official default (loopback-only, gzip intact)
- ✅ **The switch takes effect live**: it opens/closes **the plugin's own LAN reverse proxy** (listening on this machine's LAN addresses and forwarding to DSH's loopback port). It never touches DSH's binding and needs **no restart**; turning it off stops the external listener immediately
- ✅ **Still the same port**: the LAN URL stays `http://<host-ip>:<DSH-port>`. The proxy forwards the `Host` header unchanged, so credentials behave exactly like the official path
- ✅ **LAN devices must enter a password before seeing any page**: a device on the network (desktop or phone/tablet) opening `http://<host-ip>:<port>` gets the password page first; the address bar **never shows a token** (the plugin completes the official token→cookie exchange in the background)
- ✅ **The host machine never needs a password**: opening the GUI on the host itself (desktop app or browser — via `127.0.0.1`, `localhost`, `[::1]`, the machine name or the host's own LAN address) goes **straight in**, with no password page. The test is the **TCP peer address** (loopback or one of this machine's own addresses), not the hostname the page used — which is why the desktop app can never be locked out by its own gate (the bug fixed in 1.4.1).
- ✅ **Remember password (per device)**: checking "Remember password" stores it in that browser's localStorage; otherwise it is kept only in the current tab (sessionStorage)
- ✅ "LAN access" card in Settings → General: toggle + password set/clear + bind/firewall/password status
- ✅ **No silent exposure without a password**: the switch refuses to turn on until a password exists, and if the GUI is somehow exposed without one the card says so (LAN devices cannot get in)
- ✅ **Every browser sees the exact same conversation**: a single service process holds all session state server-side and pushes identical events to every connected browser

<div align="center">

![LAN password settings](docs/局域网口令设置.png)

<img src="docs/手机端展示.png" alt="Mobile UI" width="50%">

</div>

## ⚠️ Security notes

- The password gate is enforced **server-side**: a request from another machine (i.e. the TCP peer is neither loopback nor one of the host's own addresses) must carry the password (`x-dsh-lan-key` header or session cookie) or it is refused — privileged methods (settings/permissions/credentials) rely on that same gate. Requests from the host machine itself are always admitted, whatever hostname they use; that is deliberate, so the desktop app can never be locked out.
- **That gate is the whole security boundary.** No password means the LAN is simply unusable (it never degrades into "open without a password"). Anyone who knows the password can read and write all of this DSH's data — enable it only on trusted networks and pick a strong password.
- **In 1.5.0 the LAN entry point binds only this machine's current LAN interface addresses — never a wildcard** (upstream disabled wildcards precisely because "binding every interface would expose remote code execution to the network"). The gate is enforced by that entry point: DSH only ever sees connections from the host's own loopback, so **the outward-facing layer is entirely the plugin's** — which is also why turning the switch off disconnects immediately.
- Use only on trusted networks (home/office intranet). Turn the switch off on public networks.

## What LAN clients can do (important)

DSH deliberately withholds the settings scope from non-loopback browsers (`persistence` in `dsh-client-ui-settings` is fixed at page load from `isLoopback`; `dsh-client-locale` and `dsh-client-ui-chat` document this as intentional). Therefore, on a LAN device:

| Capability | LAN device |
|---|---|
| Chat, model & work-mode switching, workspaces & sessions, history, tasks, approvals, terminal | ✅ available |
| Settings / permission presets / credentials / preset management pages | ❌ host-only (change them on the host machine) |
| Workspace directory picker | ✅ the plugin's own dialog (drive dropdown, path jump) |

## Mobile (portrait phones/tablets)

- Mobile **reuses the official desktop UI**: when a phone opens `http://<host-ip>:<port>` in portrait, the plugin injects a touch adaptation over the official interface (compact sidebar rail, ≥44px touch targets, 16px input font to prevent iOS focus zoom, safe-area padding); landscape/wide viewports revert automatically.
- Every available capability is identical to desktop (see the table above): sessions/workspaces/history/live chat/model & mode switching/todo list/approvals & questions/permission switching, all synced with the host in real time.

### Mobile interaction details

- **Sidebar**: hidden while collapsed — the draggable **whale button** at the top-left is the entry point (its drag position is remembered). Tapping a session row, tapping anywhere else, or **swiping left** collapses it; in the conversation view **swiping right** expands the sidebar directly.
- **Keyboard**: the input method appears **only when you tap a text field** — tapping the whale, a session row, toggling the sidebar or closing a dialog no longer pops it (and it is never taken away while you are typing); **Enter inserts a newline instead of sending** (sending goes through the send button; Enter while an IME candidate list is open still commits the candidate).
- **UI details**: lingering official Tooltip bubbles are hidden; the `ask_user_question` card is fully adapted to narrow screens (42px option touch targets); the permission/model two-line layout and the bottom stats bar stay aligned with the composer.
- **No password-page flicker**: if the browser cannot keep the login credential (e.g. the page is embedded in a cross-site iframe/WebView, where a `SameSite=Strict` cookie is dropped), the password page stops auto-redirecting after 2 hops and explains the problem instead of looping forever.

## Installation

### Option 1 — the in-app Plugins page (recommended, one click)

Open the DSH sidebar **Plugins** page and install the package name **`dsh-lan-tool`**. `dsh.profile.bundles` is updated automatically.

> ⚠️ **After installing (or updating) the plugin, fully quit and reopen the desktop app once.** The plugin's node half (the password gate, the switch and every `/dsh-lan/*` route) is imported once per app run: **reinstalling or upgrading inside a running app leaves the node half on the old code**, while the browser half does hot-reload — a mixed pair. Since 1.4.2 the client reports that mismatch in the settings card and the console (in older versions it showed up as an unexplained password page).
>
> ⚠️ **A brand-new release may not install (pnpm's minimum release age)**: pnpm refuses packages published too recently, and the plugin manager only exempts the versions it has actually installed before — so typing the package name can silently resolve to the **previous** version (the new features and fixes never appear). Ask for the version explicitly (e.g. `dsh-lan-tool@1.4.2`), or add it to `minimumReleaseAgeExclude` in `<DSH_HOME>/profiles/<profile>/pnpm-workspace.yaml` first.
>
> This requires the package to be published on npm. If it is not published yet (or you want to install this local checkout), use option 2.

### Option 2 — the CLI (local directory / path / tarball)

```bash
# the local development directory (absolute path)
dsh plugin --profile desktop add D:\DeepSeek\dsh-LAN
# or link: / file: / tarball / git forms
dsh plugin --profile desktop add link:D:\DeepSeek\dsh-LAN
# once published, the plain package name works too
dsh plugin --profile desktop add dsh-lan-tool
```

Quit the desktop app before running the CLI (`dsh-desktop-host` says so in its message; it really only checks that the profile was initialized once, but rewriting `node_modules` while the app runs is easily blocked on Windows).

### After installation (same for both options)

1. Open DSH → Settings → General → "LAN access";
2. **Set an access password** (at least 4 characters);
3. Then flip the switch — the plugin opens a reverse proxy on this machine's LAN addresses and the card lists the usable URLs within a few seconds;
4. Open the `http://<host-ip>:<port>` URL shown in the card from a LAN device and enter the password.

> **The port is chosen by DSH itself** (the 0.2.1 desktop launcher passes `--port 0`, so the OS picks one and it can differ on every start; plain `dsh web` defaults to `3080`). **Trust the address the card displays.**
>
> 📌 **Want a stable LAN address?** Type a "LAN port" (1024–65535) in the card and press "Apply port"; leave it empty to keep following DSH. **You are pinning the plugin's own entry point, not DSH's port** — DSH's cannot be pinned safely (a `webserver` override with a taken port stops the whole app from starting, whereas a taken port here only costs you LAN access while the app starts fine). Once pinned, open pages, bookmarks and QR codes survive a DSH restart. Unpinned, **every restart moves the port, so a LAN page left open keeps reconnecting to the old one** (it shows "reconnecting" while the session list still renders), and a page reload fixes it.

### Firewall notes

- **Windows**: a Windows Defender Firewall allow rule named `dsh-lan-tool (auto)` (Domain + Private) is maintained automatically. **Without an elevated shell the first enable triggers the OS "allow access" prompt once** — click Allow and Windows creates its own rule; the card picks that system rule up **automatically** (within seconds it reports "firewall open" with the rule's name) — no admin rights and no restart needed. "firewall blocked (needs admin)" is only reported when neither our rule nor any OS rule admits the port.
- **Linux**: an allow rule is maintained via firewalld → ufw → iptables (first available). When no supported firewall tool is found the card reports "firewall not managed", which normally means the port is already reachable.
- **The few seconds around a toggle**: the switch opens/closes the plugin's LAN listener, so requests may fail briefly; the card says "applying…" and retries by itself — **no red error**, and rule names in the status line are decoded as UTF-8 (no mojibake).
- Turning the "LAN access" toggle off **immediately** stops the plugin's LAN listener (DSH itself is loopback-only at all times) — that is the primary security switch.
- **The listener binds only this machine's current LAN interface addresses, never a wildcard.** When interfaces change (switching Wi-Fi, VPN up/down, a new DHCP lease) the plugin re-checks every 10 seconds and adds/removes listeners, and the card's addresses follow.

## Upgrading (1.4.x → 1.5.0, important)

**If you upgraded DSH to 0.2.1 while "LAN access" was on, DSH will not start.** You get the "DeepSeek Harness is unavailable" dialog and the log (`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`) says something like:

```
webserver (required)
  Error: host "0.0.0.0" is an unspecified (wildcard) address, which is not supported: …
```

**Why**: 0.2.1's `webserver` row no longer accepts a wildcard bind address (upstream deliberately removed that exposure), and the row is required — so config validation fails and the whole app refuses to boot. Older versions (≤1.4.7) wrote exactly such an override (`host: '0.0.0.0'`) into the profile patch when you flipped the switch on, and **an upgrade does not remove it**, so every start fails. **Your configuration is not corrupt and this is not a DSH bug**; since 1.5.0 the plugin writes no override at all.

Two ways out — pick either:

**A. Use DSH's own button (fastest)**: in the startup-failure dialog, click the third button — "**disable third-party plugins, back up the profile patch and restart**". It backs the patch up, drops third-party bundles and starts normally. Then **upgrade this plugin to 1.5.0 and re-enable it** (1.5.0 cleans up the leftover override by itself).

**B. Delete the block by hand**:

1. Quit DSH completely;
2. Open `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`;
3. Delete everything from `# --- dsh-lan-tool LAN block (managed - do not edit) ---` through `# --- end dsh-lan-tool LAN block ---` inclusive (touch nothing else in the file);
4. Save, start DSH, then upgrade the plugin to 1.5.0.

> Once 1.5.0 is active it also strips any leftover managed block on activation. But on a machine that is already stuck, the plugin never loads at all — hence A or B first, which is exactly why this section exists.
>
> ⚠️ **1.5.0 itself has a defect — use 1.5.1 or newer.** 0.2.1 moved API admission into the trust funnel inside `connection.admit()` (`isTrusted`), while 1.5.0's password fence still replaced only the old `requestRejection` — so a LAN device could open the GUI but **every API call answered 403** (visible, unusable). 1.5.1 fixes it (the fence now owns the trust funnel too) and adds an end-to-end assertion that the local and LAN answers must match, so it cannot come back silently.

### What changed in 1.5.0

| | 1.4.x | 1.5.0 |
|---|---|---|
| DSH's own listener | switched to `0.0.0.0` while on | **always `127.0.0.1`** (official default; the plugin no longer touches it) |
| LAN entry point | DSH listening on the LAN itself | **the plugin's built-in reverse proxy**, forwarding to DSH |
| Port | the same | **the same** (the proxy reuses DSH's port number) |
| Where the switch lives | a managed override in the profile patch | plugin state (`lanEnabled` in `dsh-lan.json`) |
| Turning it off | delete the override, wait for a hot reload | **stop the external listener immediately** |
| Password / landing page / firewall | — | unchanged |

## Upgrading (1.3.x → 1.4.0)

The package was renamed (`dsh-LAN` → `dsh-lan-tool`). Machines that used the old installer scripts are migrated automatically on first activation:

1. **Legacy managed blocks are stripped** from `profiles/<profile>/cordis.patch.yml` (`dsh-LAN install block`, `dsh-LAN toggle block`). The profile patch layer outranks every bundle layer, so leaving them would keep overriding the new composition — that is exactly how "card says off, socket still on 0.0.0.0" happened. After migration the LAN is **off** again; re-enable it from the settings card.
2. **Legacy firewall rules are removed** (`dsh-LAN (auto)`, `DSH LAN Access (auto)`). The rule name is now `dsh-lan-tool (auto)`, and no code could reach the old names any more — they would have kept the port open invisibly forever.
3. **The password is kept**: it still lives in `%USERPROFILE%\.dsh\dsh-lan.json` (the filename is unchanged so no password is lost). No need to set it again.
4. The old `profiles/node_modules/dsh-LAN` directory can be deleted by hand.

Manual fallback (if the migration never ran): delete both managed blocks from `profiles/<profile>/cordis.patch.yml` and toggle LAN off/on once in the settings card.

## Uninstall

Remove the plugin from the Plugins page, or:

```bash
dsh plugin --profile desktop remove dsh-lan-tool
```

On deactivation **the LAN listener is closed immediately** (it is the plugin's own listener and the gate lives inside it, so it cannot wait), while the firewall rule and any leftover managed block in the profile patch are cleaned up about 8 seconds later. That window exists to tell a hot reload (which immediately re-applies the plugin and cancels the cleanup) apart from a real removal, so a normal uninstall returns the GUI to **off**.

Two cases need a manual check (the cleanup never ran):

- DSH was quit immediately after the uninstall, or the package directory was deleted by hand;
- you also want the password gone.

Manual cleanup in three steps: delete `%USERPROFILE%\.dsh\dsh-lan.json`; make sure `profiles/<profile>/cordis.patch.yml` no longer contains a `dsh-lan-tool LAN block` section (delete the whole section if it is there); and confirm `netsh advfirewall firewall show rule name="dsh-lan-tool (auto)"` matches nothing (if it does, `netsh advfirewall firewall delete rule name="dsh-lan-tool (auto)"`).

## How multi-device consistency works

A single DSH service process holds all state: sessions (jsonl persistence + in-memory projections), workspaces, targets, and subagents. Every browser is just a client of the same service: it reads/writes the same state through `/api` RPC and receives the same server-side event pushes over the WebSocket downlink. Desktop and mobile connect to the same state, so any action on either end is visible in real time on all other ends.

## Credits

Early mobile work referenced [dsh-remote-web-ui from dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) (standalone lightweight remote UI + token gate); since v48 mobile reuses the official desktop UI with an injected portrait adaptation, keeping the same password model.

## License

[MIT](package.json) (`license: MIT`)
