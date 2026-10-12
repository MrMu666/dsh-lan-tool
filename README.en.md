# dsh-lan-tool

dsh-lan-tool — a plugin that brings the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI to your local network (password-protected; mobile reuses the official desktop UI with an injected portrait touch adaptation).

> ⚠️ **Version requirement: `@deepseek-ai/dsh` `0.2.0-rc.2` and newer** (verified on the 0.2.0-rc.2 desktop build). The 0.1.x APIs (`dsh-host-apiproxy`, dotted endpoints, the client-side `settingsScope` service) are no longer compatible — upgrade DSH first.

> 🚀 **Pair it with [DSH-Launcher](https://github.com/MrMu666/DSH-Launcher) and [dsh-app](https://github.com/MrMu666/dsh-app) for a better experience.**

> 📦 **This package is a standard DSH plugin bundle** (it declares `dsh.bundle.patch`), installed through the official plugin mechanism. There are **no install scripts**, the on/off switch lives in **Settings**, and nothing asks for a password at install time.

Once installed, flip "LAN access" on in Settings and the GUI becomes reachable from the LAN (Windows opens the firewall automatically for Domain + Private; Linux tries firewalld / ufw / iptables in order and treats a missing firewall tool as "no rule needed"):

- ✅ **Off by default**: the bundle writes no `webserver` override at all, so the GUI keeps the official default (loopback-only, gzip intact)
- ✅ **The switch takes effect live**: it writes/removes a managed override in the *active profile's* `cordis.patch.yml`, which the harness hot-reloads and re-binds — **no restart**
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
- **Keyboard**: the page never auto-focuses the composer on load, tapping the whale does not pop the keyboard, and Enter inserts a newline only (sending goes through the send button).
- **UI details**: lingering official Tooltip bubbles are hidden; the `ask_user_question` card is fully adapted to narrow screens (42px option touch targets); the permission/model two-line layout and the bottom stats bar stay aligned with the composer.
- **No password-page flicker**: if the browser cannot keep the login credential (e.g. the page is embedded in a cross-site iframe/WebView, where a `SameSite=Strict` cookie is dropped), the password page stops auto-redirecting after 2 hops and explains the problem instead of looping forever.

## Installation

### Option 1 — the in-app Plugins page (recommended, one click)

Open the DSH sidebar **Plugins** page and install the package name **`dsh-lan-tool`**. `dsh.profile.bundles` is updated automatically.

> ⚠️ **After installing (or updating) the plugin, fully quit and reopen the desktop app once.** The plugin's node half (the password gate, the switch and every `/dsh-lan/*` route) is imported once per app run: **reinstalling or upgrading inside a running app leaves the node half on the old code**, while the browser half does hot-reload — a mixed pair. Since 1.4.2 the client reports that mismatch in the settings card and the console (in older versions it showed up as an unexplained password page).
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
3. Then flip the switch — the plugin writes the managed override and the binding hot-reloads; the card shows `0.0.0.0` about 2 seconds later;
4. Open the `http://<host-ip>:<port>` URL shown in the card from a LAN device and enter the password.

> The desktop build uses port `19387` (pinned by the desktop launcher); plain `dsh web` defaults to `3080`. Trust the port the card displays.

### Firewall notes

- **Windows**: a Windows Defender Firewall allow rule named `dsh-lan-tool (auto)` (Domain + Private) is maintained automatically; without an elevated shell the card reports "firewall blocked (needs admin)".
- **Linux**: an allow rule is maintained via firewalld → ufw → iptables (first available). When no supported firewall tool is found the card reports "firewall not managed", which normally means the port is already reachable.
- On every platform, turning the "LAN access" toggle off removes the override and returns to `127.0.0.1` — that is the primary security switch.

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

On deactivation the password gate goes away immediately, and **the managed bind override is removed by the plugin itself about 8 seconds later**, together with the firewall rule. That window exists to tell a hot reload (which immediately re-applies the plugin and cancels the cleanup) apart from a real removal, so a normal uninstall returns the GUI to **off**.

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
