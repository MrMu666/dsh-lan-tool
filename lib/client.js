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
				// ── portrait-mobile: adapt the desktop SPA in place (v47) ────────────
		// Mobile uses the desktop UI itself (the standalone /dsh-lan/ui was
		// removed in v48); while a touch device is in portrait we inject a
		// mobile-touch adaptation. The official layout already auto-collapses
		// the sidebar to a compact rail below 1024px; this overlay adds
		// touch-target sizing, input font-size (iOS zoom), safe-area handling,
		// slightly smaller type (v50) and hides the collapsed rail behind a
		// floating whale button (v50). Landscape, desktop and wide viewports
		// stay untouched; a manual sessionStorage opt-out
		// (dsh-lan-force-desktop=1) still disables it.
		(function mobileAdapt() {
			const ADAPT_CSS_ID = "dsh-lan-tool/mobile-adapt.css";
			let active = false;
			let savedViewportContent = null;
			let whaleEl = null;
			let whaleObserver = null;
			let whaleTimer = null;
			function isMobilePortrait() {
				if (!window.matchMedia("(orientation: portrait)").matches) return false;
				if (!window.matchMedia("(pointer: coarse)").matches) return false;
				if (window.innerWidth >= 1100) return false;
				if (window.sessionStorage.getItem("dsh-lan-force-desktop") === "1") return false;
				return true;
			}
			// CSS Modules class names are hash-prefixed with the semantic name
			// as a stable suffix (e.g. `pI_x6G_centerCol`) — attribute suffix
			// selectors survive official rebuilds that change the hash only.
			const ADAPT_CSS = [
				"html,body{height:100%}",
				"[class$=\"_frame\"]{width:100%;height:100dvh}",
				// compact rail: bigger touch targets
				"[class$=\"_railFish\"] button,[class$=\"_panelIcon\"],[class$=\"_newSession\"]{min-width:44px;min-height:44px}",
				// message list padding on narrow screens
				"[class$=\"_scroll\"]{padding:8px 10px}",
				// 16px inputs prevent iOS focus zoom; keep send button touchy
				"[class$=\"_input\"],textarea,input{font-size:16px}",
				"[class$=\"_composer\"]{padding-bottom:calc(4px + env(safe-area-inset-bottom))}",
				// ── v50: slightly smaller type on portrait phones ───────────────
				"[class$=\"_scrollBody\"] [class$=\"_root\"]{font-size:14.5px}",
				"[class$=\"_scrollBody\"] [class$=\"_bubble\"]{font-size:14.5px}",
				"[class$=\"_titleRow\"] *{font-size:13px}",
				"[class$=\"_sidebarCol\"] [class$=\"_root\"],[class$=\"_sidebarCol\"] [class$=\"_newSession\"],[class$=\"_sidebarCol\"] [class$=\"_trigger\"],[class$=\"_sidebarCol\"] [class$=\"_title\"]{font-size:13px}",
				"[class$=\"_sidebarCol\"] [class$=\"_meta\"],[class$=\"_sidebarCol\"] [class$=\"_time\"]{font-size:11.5px}",
				// ── v50: collapsed rail hidden; the whale is the entry ───────────
				// the frame's grid is inline-styled (56px rail track when
				// collapsed); pin the first track to 0 so content uses the full
				// width. On portrait phones the details track is always 0
				// (computeColumns drops it when there is no room), so the
				// three-track override is safe here.
				"[class$=\"_frame\"][data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0 !important}",
				// ── v85: the whale is EMBEDDED in the top bar's LEFT edge ───────
				// It used to float (position:fixed) over the chat header, which
				// forced `padding-left:52px` on `_titleRow` to keep the session
				// title clear of it — that hack is gone with the float.
				// seatWhale() puts the button in as the title row's FIRST flex
				// child, which is all the centring needs: the official title
				// cluster is `._titleCluster{flex:1}`, so it grows into the space
				// between the whale and the official right-sidebar control. The
				// two ends then mirror each other: same 28px ghost button, same
				// 12px glyph, same secondary label colour, no background, no
				// border, no shadow (the official control is a ghost button too).
				// NOTE the marker attribute, never `[class$="_titleRow"]`, as the
				// scope for these: the whale's own id is `dshLanWhale`, which ALSO
				// ends in "Whale" and therefore matches a `[class$="_titleRow"]`
				// selector — scoping on the row's class silently re-styled the
				// button itself (it inherited the cluster's `margin-left:auto` and
				// drifted to the middle of the row).
				// The cluster is NOT the row's flex item: the official markup wraps
				// it in an unclassed div, and `._titleCluster{flex:1}` only grows
				// inside that wrapper — so the wrapper is what has to take the free
				// space. Without this the row's items keep their natural widths,
				// nothing grows, and `margin-left:auto` on the cluster resolves to
				// 0 (there is no free space inside an 84px wrapper to absorb).
				"[data-dsh-lan-whale=\"1\"] > :has(> [class$=\"_titleCluster\"]){flex:1 1 auto !important;min-width:0}",
				// The cluster's own content (breadcrumb, then the header actions)
				// is laid out from its left edge, so a grown cluster still paints
				// the title hard against the whale. Centre it inside the space the
				// two buttons leave, which is what "标题放中间" means.
				"[data-dsh-lan-whale=\"1\"] [class$=\"_titleCluster\"]{justify-content:center}",
				"[data-dsh-lan-whale=\"1\"] [class$=\"_headerCorner\"]{display:flex;align-items:center;gap:0}",
				// −12px mirrors the official control's −16px minus this button's
				// 4px of extra width, so the glyph (not just the box) lands on the
				// same gutter the right-side glyph sits on.
				"#dshLanWhale{flex:none;box-sizing:border-box;width:28px;min-width:28px;height:28px;padding:0;margin:0 0 0 -12px;border:none;border-radius:var(--dsw-radius-sm,4px);background:0 0;box-shadow:none;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;appearance:none;-webkit-tap-highlight-color:transparent}",
				"#dshLanWhale:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				"#dshLanWhale:active{background:var(--dsw-alias-interactive-bg-active)}",
				"#dshLanWhale svg{width:20px;height:15px;display:block;flex:none}",
				// ── v51/v52: mobile-only tweaks ──────────────────────────────
				// smaller collapse toggle in the expanded sidebar (the toggle
				// carries two classes, so match by containment)
				"[class$=\"_sidebarCol\"] [class$=\"_logoRow\"] [class*=\"_iconButton\"]{width:18px;height:18px}",
				// v47's panelIcon touch rule forces a 44px min on the icon
				// itself — zero it out so the 13px glyph fits the 18px button
				"[class$=\"_sidebarCol\"] [class$=\"_logoRow\"] [class*=\"_iconButton\"] svg{width:13px;height:13px;min-width:0;min-height:0}",
				// v77: workspace rows' right-side actions (menu + new session)
				// are hover-only on desktop; always show them on mobile touch.
				"[class$=\"_sidebarCol\"] [class$=\"_projectRow\"] [class$=\"_rowActions\"]{display:inline-flex}",
				// v78: mobile long-press on a row must not start native drag
				"[class$=\"_sidebarCol\"] [class$=\"_sessionRow\"],[class$=\"_sidebarCol\"] [class$=\"_projectRow\"]{-webkit-user-drag:none;user-select:none}",
				// hide the header utilities cluster on phones (no space); both the
				// `open-in-app` app chooser (文件资源管理器 / VS Code / Git Bash) and
				// `session-log-export` register into THIS slot, so the whole cluster
				// goes away. The app chooser is additionally hidden for every
				// non-local browser (see the nonlocal stylesheet).
				"[class$=\"_headerUtilities\"]{display:none}",
				// v83: hide the Session-log "more actions" button (three dots) on its
				// own as well. It is `@deepseek-ai/dsh-session-log-export`'s
				// `nL4_yW_moreButton` (aria-haspopup=menu, aria-label「更多操作」,
				// ellipsis icon) and it registers into the utilities slot — which the
				// rule above already hides — but keying off the parent alone made this
				// depend on the whole mobile-adaptation state being active (portrait,
				// coarse pointer, width < 1100). Hiding the button by its own class
				// removes that coupling. The `_trigger` term is a second safety net by
				// ROLE: a menu-trigger button carrying an ellipsis icon is this
				// control, whatever the module hash is. Measured: `[class$=\"_moreButton\"]`
				// matches only this one element in the app.
				"[class$=\"_headerUtilities\"] [class$=\"_moreButton\"],[class$=\"_headerUtilities\"] [class$=\"_trigger\"]:has(svg):where([aria-haspopup=\"menu\"]){display:none}",
				// v52 composer: the permission / model / attach buttons share ONE
				// line on the left; the command, context-meter and send/stop
				// buttons float at the left/right edges vertically centered over
				// it; permission label expanded; 1px bottom gap
				"[class$=\"_composerSeat\"] [class$=\"_card\"]{margin-bottom:1px}",
				"[class$=\"_composerSeat\"] [class$=\"_row\"]{padding:2px 8px 1px;position:relative;column-gap:10px;justify-content:flex-start}",
				// v79: `nowrap` is what guarantees the single line. With the wrapping
				// official flow, a viewport too narrow for attach + permission +
				// model (measured: it wraps at 320px) drops the model button onto a
				// second line instead of shrinking its label; nowrap keeps the row
				// and lets the label ellipsize.
				"[class$=\"_composerSeat\"] [class$=\"_row\"]{flex-wrap:nowrap;row-gap:0}",
				"[class$=\"_composerSeat\"] [class$=\"_add\"]{position:absolute;left:8px;top:50%;transform:translateY(-50%)}",
				"[class$=\"_composerSeat\"] [class$=\"_modes\"]{min-width:0;padding-left:38px}",
				"[class$=\"_composerSeat\"] [class$=\"_modes\"] [class$=\"_trigger\"]{max-width:none}",
				"[class$=\"_composerSeat\"] [class$=\"_modes\"] [class$=\"_triggerLabel\"]{display:block}",
				// v79: the model button joins the permission button on one line
				// instead of taking a full row of its own. Three overrides used to
				// force the stack and all three are gone: `flex-basis:100%` on
				// `_trailing` (the actual cause), its `padding-left:38px` (it now
				// starts right after the permission trigger), and its
				// `padding-right:78px` (that existed to keep the model button clear
				// of the send/stop circle when the model owned a whole row, but in
				// the shared row it just steals 78px from the label).
				// `justify-content:flex-start` on `_row` is the one addition: the
				// official rule is `space-between`, and with the send button pulled
				// out of flow (`position:absolute`) the row has only `_tools` and
				// `_trailing` left, so space-between pushed the model button all the
				// way to the right edge. `margin-left:0` on `_trailing` cancels the
				// official `margin-left:auto`, and `min-width:0` + `overflow:hidden`
				// let a long model label ellipsize instead of overflowing or
				// wrapping under the send button.
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"]{flex:0 1 auto;margin-left:0;min-width:0;overflow:hidden;justify-content:flex-start;padding-left:0;padding-right:0}",
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"] *{font-size:12px}",
				// v54: smaller permission/model buttons (font + height); v79: same
				// 12px type on both so the two lines read as one row, and the model
				// label degrades to an ellipsis instead of overflowing when the
				// viewport is too narrow to hold attach + permission + model.
				"[class$=\"_composerSeat\"] [class$=\"_modes\"] [class$=\"_trigger\"]{height:24px;min-height:24px;font-size:12px}",
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"] [class$=\"_trigger\"]{height:24px;min-height:24px;font-size:12px;min-width:0;max-width:100%}",
				// v80/v81: hard ceiling on the model trigger so a long model name can
				// never reach the context ring / send circle. The 100cqw unit is
				// deliberate: `_row` is `container-type:inline-size`, so `cqw` is the
				// reliable handle on its width while a percentage in this position is
				// not (a percentage max-width here silently failed to clamp, measured
				// at 360px: container stayed 239px wide and ran 34px under the send
				// button).
				// The binding obstacle is the CONTEXT RING, not the send button: the
				// ring is the official 28px ContextMeter, absolutely placed at
				// `right:52px; translateY(-50%)`, so it sits 12px to the LEFT of the
				// send circle (at 360px: ring left 280, send left 292). Reserving
				// against the send button (an earlier 140px) therefore left the model
				// button overlapping the ring — exactly the reported overlap.
				// Calibration, measured as the gap from the model trigger's trailing
				// chevron to the ring's left edge (the real visual gap; the trigger's
				// right edge sits ~30px further right because of the icon and
				// chevron): reservation 160 -> gap 0 (the reported overlap),
				// 185 -> gap 25. So gap ~= reservation - 160, and 175 buys a ~15px
				// gap while truncating the model name as little as possible
				// ("DeepSeek V4.1 Flash (C…)" at 390px). The trade is explicit: on
				// phone widths the model name ellipsizes, because the ring gap wins.
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"] [class$=\"_trigger\"]{max-width:calc(100cqw - 175px)}",
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"] [class$=\"_triggerLabel\"]{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				// context meter + send/stop float at the right edge, vertically
				// centered over both lines (the meter's root contains the track)
				"[class$=\"_composerSeat\"] [class$=\"_trailing\"] > [class$=\"_root\"]:has([class$=\"_track\"]){position:absolute;right:52px;top:50%;transform:translateY(-50%)}",
				"[class$=\"_composerSeat\"] [class$=\"_primary\"]{position:absolute;right:8px;top:50%;transform:translateY(-50%)}",
				// bottom stats line (N 轮 · M 步 …) two sizes below the tabs —
				// higher specificity than the reply-root rule above; v55: wrap
				// freely but clamp at two lines (the official rule is
				// nowrap + single-line ellipsis); v56: left-aligned with the
				// v60: drop the official 32px right padding so the text also
				// extends to the card's right edge
				// v82 (3): back to CENTERED. The official StatsPills root already
				// centres its pills (`justify-content:center`) and is a flex row, so
				// the v56 `text-align:left` only ever affected the multi-line case —
				// it made wrapped lines hug the left edge. `justify-content:center`
				// is repeated here so a wrapped row stays centred too, not just its
				// text. The zero left/right padding from v60 stays.
				"[class$=\"_composerSeat\"] [data-slot=\"conversation.composer.dock\"] [class$=\"_root\"]{font-size:10px;white-space:normal;word-break:break-word;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-align:center;line-height:13px;letter-spacing:-0.2px;padding-left:0;padding-right:0}",
				// (user bubbles keep the v50 14.5px via the _bubble rule)
				"[class$=\"_scrollBody\"] [class$=\"_root\"]{font-size:13px}",
				"[class$=\"_scrollBody\"] [class$=\"_body\"]{gap:6px}",
				// v58/v65: on touch, taps leave :hover/:focus stuck, so the official
				// Tooltip bubbles ("发送消息" above the send button, sidebar
				// toggle "收起/打开侧边栏"…) stay visible on mobile. The bubble
				// class hash sits AFTER the name (_bubble_<hash>), so match by
				// containment, still scoped by role=tooltip so user message
				// bubbles (hash_prefix_bubble, no tooltip role) stay visible.
				"[class*=\"_bubble\"][role=\"tooltip\"]{display:none}",
				// PlanReviewPanel share the _frame/_card suffixes) overflows a
				// narrow phone: its frame is width:100% + 32px content-box
				// paddings (446px on a 390px screen) and the sticky bottom
				// composer seat pushes the card top above the viewport. Pin
				// the frame to the viewport with border-box and cap its
				// height so the card sits fully on screen.
				"[class$=\"_composerSeat\"] [class$=\"_frame\"]{box-sizing:border-box;width:100%;max-width:100%;padding-left:12px;padding-right:12px;height:auto;max-height:calc(100dvh - 96px);align-items:flex-start;overflow-y:auto}",
				"[class$=\"_composerSeat\"] [class$=\"_frame\"] [class$=\"_card\"]{max-width:none;width:100%}",
				// v67: header actions (agent-preset mode label + background-task
				// badge) are re-seated from the title row into the tabs row
				// ("对话 / 轨迹"). Hidden in the original spot so React
				// re-renders don't flicker them back between re-seats.
				"[class$=\"_header\"] [class$=\"_titleCluster\"] [class$=\"_headerActions\"]{display:none}",
				// the official header keeps a 28px right padding on phones; the
				// tabs row used to be stretched 58px past it while the actions were
				// pinned to the right (v67). v84 re-anchors everything to the LEFT
				// (see the `_headerActions` rule below), so all that matters now is
				// that the row does not overflow the viewport: keep the official
				// 28px padding and let the actions ellipsize instead.
				"[class$=\"_header\"] [class$=\"_tabs\"]{margin-right:0}",
				// v70: match the 对话/轨迹 tab text size with the seated mode
				// label & background badge (12px), and keep each tab on one line
				// NB: [class$="_tab"] misses the active tab (its class ends in
				// "_tabActive") — use *= containment so BOTH tabs match.
				"[class$=\"_header\"] [class$=\"_tabs\"] [class*=\"_tab\"]{font-size:12px;white-space:nowrap}",
				// Text-bottom alignment is dynamic (alignActionsText below): the
				// tabs row height is not stable (28px idle, 43px while a
				// background task runs — Chrome lays the label+badge pair out
				// 43px tall), so a fixed transform would point the wrong way.
				// v84: the actions follow the 轨迹 tab instead of hugging the right
				// edge. The node is appended as a flex child of `_tabs`, and the
				// official `.tabs` already carries the very spacing used between
				// 对话 and 轨迹 (`gap:36px`), so the uniform 36px comes from the
				// container — no `margin-left` patch. Only `flex:none` and
				// `min-width:0` remain: `min-width:0` lets a long preset name
				// ellipsize rather than push the row past the viewport (which is
				// what "标准模式 超出屏幕边缘" was). The earlier `margin-left:auto`
				// was an explicit "hug the right edge" instruction — that was the bug.
				"[class$=\"_header\"] [class$=\"_tabs\"] [class$=\"_headerActions\"]{margin-left:0;display:flex;align-items:center;gap:36px;flex:none;min-width:0}",
				// v72: the official model-select menu anchors right:0 to its narrow
				// trigger container; on a phone the 240px menu then overflows the
				// left viewport edge (x=-27). Pin the left edge inside the screen.
				"[class$=\"_7KE1Ra_menu\"]{left:8px;right:auto;max-width:calc(100vw - 16px)}",
				// v68: settings modal on mobile — the official panel is a fixed
				// 800px two-column layout (188px nav + content); on a phone that
				// squeezes every form to ~150px. Switch to a column layout: the
				// section nav becomes a horizontal scrollable row on top, the
				// content takes the full remaining width.
				"[class$=\"_overlay\"] [class$=\"_panel\"]{flex-direction:column;max-height:calc(100dvh - 32px)}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_nav\"]{flex-direction:row;gap:4px;width:100%;padding:12px 12px 0;overflow-x:auto;overflow-y:hidden}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_navTitle\"]{display:none}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_navList\"]{flex-direction:row;gap:4px}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_navCell\"]{height:34px;padding:0 12px;gap:6px;flex:none;border-radius:10px}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_navLabel\"]{font-size:13px}",
				"[class$=\"_overlay\"] [class$=\"_panel\"] [class$=\"_content\"]{flex:1;min-height:0}"
			].join("");
			function apply() {
				if (active) return;
				active = true;
				document.body.classList.add("dsh-lan-portrait");
				if (document.querySelector("style[data-plugin-css=\"" + ADAPT_CSS_ID + "\"]") === null) {
					const tag = document.createElement("style");
					tag.dataset.plugin = "dsh-lan-tool";
					tag.dataset.pluginCss = ADAPT_CSS_ID;
					tag.textContent = ADAPT_CSS;
					document.head.appendChild(tag);
				}
				// viewport-fit=cover enables env(safe-area-inset-*); restore on revert
				const meta = document.querySelector("meta[name=viewport]");
				if (meta && meta.getAttribute("content") && meta.getAttribute("content").indexOf("viewport-fit") === -1) {
					savedViewportContent = meta.getAttribute("content");
					meta.setAttribute("content", savedViewportContent + ", viewport-fit=cover");
				}
				ensureWhale();
				syncWhale();
				// React builds nodes with attributes before inserting them, so
				// attribute observers miss the initial collapsed state — a
				// light interval is the reliable sync.
				if (whaleTimer === null) whaleTimer = window.setInterval(syncWhale, 600);
				seatHeaderActions();
			}
			function revert() {
				if (!active) return;
				active = false;
				unseatHeaderActions();
				document.body.classList.remove("dsh-lan-portrait");
				document.body.classList.remove("dsh-lan-rail-hidden");
				const tag = document.querySelector("style[data-plugin-css=\"" + ADAPT_CSS_ID + "\"]");
				if (tag) tag.remove();
				const meta = document.querySelector("meta[name=viewport]");
				if (meta && savedViewportContent !== null) {
					meta.setAttribute("content", savedViewportContent);
					savedViewportContent = null;
				}
				if (whaleEl !== null) unseatWhale();
				if (whaleTimer !== null) { window.clearInterval(whaleTimer); whaleTimer = null; }
			}
			// The whale (fish logo) button: the only entry point to the sidebar
			// while the collapsed rail is hidden. Clicking expands the sidebar
			// through the layout service (wired by the plugin apply() once
			// ctx.layout is live). Hidden while the sidebar is expanded (its own
			// collapse control takes over) and while any overlay/modal is up.
			const FISH_PATH = "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";
			function ensureWhale() {
				if (whaleEl !== null) return;
				if (typeof document === "undefined" || !document.body) return;
				whaleEl = document.createElement("button");
				whaleEl.id = "dshLanWhale";
				whaleEl.type = "button";
				whaleEl.title = "打开侧边栏";
				whaleEl.setAttribute("aria-label", "打开侧边栏");
				// v85: no wrapper box — the glyph IS the button, exactly like the
				// official right-sidebar control (`_ghost_` button + 15px icon).
				// The box is square (matches the official 28x28 hit target) while
				// the fish is wider than tall, so `preserveAspectRatio="none"`
				// lets the 20x15 viewport stretch it into that square box instead
				// of letterboxing it back down to 15x11.
				whaleEl.innerHTML = '<svg viewBox="0 0 23.16 17.04" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="' + FISH_PATH + '" fill="currentColor"/></svg>';
				whaleEl.addEventListener("click", () => {
					// v61: opening the sidebar must not leave a focused composer
					// input behind — on phones a still-focused input makes the
					// first tap re-pop the keyboard (iOS) or keeps it open.
					// Blur before handing control to the toggle (the old pointer
					// path did this at pointerdown; there is no drag any more).
					const ta = document.querySelector('[class$="_composerSeat"] textarea, [class$="_composerSeat"] input');
					if (ta !== null && document.activeElement === ta) {
						ta.blur();
						lastComposerTap = 0;
					}
					const toggle = window.__dshLanAdapt && window.__dshLanAdapt.toggleSidebar;
					if (typeof toggle === "function") toggle();
				});
			}
			// v85: the whale lives INSIDE the header's title row as its FIRST
			// flex child, so it mirrors the official right-sidebar control at the
			// other end while the official `_titleCluster{flex:1}` keeps the
			// session title between them. React rebuilds the row on session
			// changes, so re-seat on every sync tick; never keep a second copy in
			// the body.
			function seatWhale() {
				if (whaleEl === null) return;
				const row = document.querySelector('[class$="_titleRow"]');
				if (row === null) {
					if (whaleEl.parentElement !== document.body && document.body !== null) document.body.appendChild(whaleEl);
					return;
				}
				if (row.firstElementChild !== whaleEl) row.insertBefore(whaleEl, row.firstChild);
				// Marker for the centring rule (the cluster only needs the nudge
				// when the whale is really seated in this row).
				if (row.getAttribute("data-dsh-lan-whale") !== "1") row.setAttribute("data-dsh-lan-whale", "1");
			}
			function unseatWhale() {
				if (whaleEl === null) return;
				const row = whaleEl.parentElement;
				if (document.body !== null && row !== document.body && row !== null) document.body.appendChild(whaleEl);
				if (row !== null && row !== document.body && row.getAttribute("data-dsh-lan-whale") === "1") row.removeAttribute("data-dsh-lan-whale");
				whaleEl.style.display = "none";
			}
			// v78: on touch, official session/project rows are draggable for
			// reordering; a long-press would start native drag instead of our
			// action menu. Force them non-draggable while the mobile adapt is
			// active (React may re-create rows, so re-apply on the sync tick).
			function disableRowDrag() {
				if (!active) return;
				const rows = document.querySelectorAll('[class$="_sidebarCol"] [class$="_sessionRow"], [class$="_sidebarCol"] [class$="_projectRow"]');
				for (const row of rows) row.setAttribute("draggable", "false");
			}
			document.addEventListener("dragstart", (e) => {
				if (!active) return;
				const t = e.target;
				if (t instanceof HTMLElement && (t.closest('[class$="_sessionRow"]') !== null || t.closest('[class$="_projectRow"]') !== null)) {
					e.preventDefault();
				}
			}, true);
			function syncWhale() {
				if (whaleEl === null) return;
				if (!active) { unseatWhale(); return; }
				const collapsed = document.querySelector('[class$="_frame"][data-sidebar-collapsed]') !== null;
				const overlayUp = document.querySelector('[class$="_overlay"]') !== null;
				seatWhale();
				whaleEl.style.display = (collapsed && !overlayUp) ? "" : "none";
				// v85: the title row no longer needs a reserve for a floating
				// button — the whale is a flex item in the row, and the official
				// control's own −16px margin (which we mirror) is what keeps both
				// glyphs clear of the measured title cluster.
				document.body.classList.remove("dsh-lan-rail-hidden");
				disableRowDrag();
				seatHeaderActions();
				alignActionsText();
			}
			// v67: on mobile the header actions (agent-preset mode label +
			// background-task badge) move from the title row into the tabs row
			// ("对话 / 轨迹"). React re-creates the node in its original spot
			// on re-render, so the interval re-seats it; stale seated copies
			// are removed first.
			function seatHeaderActions() {
				if (!active) return;
				const tabs = document.querySelector('[class$="_header"] [class$="_tabs"]');
				const fresh = document.querySelector('[class$="_titleCluster"] [class$="_headerActions"]');
				const seated = tabs ? tabs.querySelector(':scope > [class$="_headerActions"]') : null;
				// fresh === null means the node is either not rendered yet or
				// already seated — the seated copy IS the moved node, so never
				// remove it in that case (that would delete it from the DOM).
				if (fresh !== null && tabs !== null) {
					// React re-created the node in its original spot — drop any
					// stale seated copy, then move the fresh one into the tabs.
					if (seated !== null) seated.remove();
					tabs.appendChild(fresh);
				}
			}
			// Align the mode/badge text bottom edge with the 对话/轨迹 tab text.
			// The tabs row height is not stable (28px idle; 43px while a
			// background task is running — Chrome lays the label+badge pair
			// out 43px tall), so a static transform would be wrong half the
			// time. Measure the real text boxes each tick and compensate.
			function alignActionsText() {
				if (!active) return;
				const tabs = document.querySelector('[class$="_header"] [class$="_tabs"]');
				if (!tabs) return;
				const actions = tabs.querySelector(':scope > [class$="_headerActions"]');
				const tabBtn = tabs.querySelector(':scope > [class*="_tab"]');
				if (!actions || !tabBtn) return;
				const textBottom = (el) => {
					if (!el) return null;
					const t = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());
					if (!t) return null;
					try { const r = document.createRange(); r.selectNode(t); return r.getBoundingClientRect().bottom; } catch (err) { return null; }
				};
				const tabBottom = textBottom(tabBtn);
				if (tabBottom === null) return;
				// the label/count rects already include the transform we set on
				// the last tick — subtract it so the measurement is stable and
				// the compensation converges instead of oscillating.
				const curMatch = /translateY\((-?[\d.]+)px\)/.exec(actions.style.transform || "");
				const cur = curMatch ? parseFloat(curMatch[1]) : 0;
				let maxBottom = null;
				for (const sel of ['[class$="_label"]', '[class$="_count"]']) {
					const b = textBottom(actions.querySelector(sel));
					if (b !== null && (maxBottom === null || b - cur > maxBottom)) maxBottom = b - cur;
				}
				if (maxBottom === null) return;
				const delta = Math.round((tabBottom - maxBottom) * 10) / 10;
				if (Math.abs(delta) < 0.5) {
					if (actions.style.transform !== "") actions.style.transform = "";
					return;
				}
				actions.style.transform = "translateY(" + delta + "px)";
			}
			function unseatHeaderActions() {
				const tabs = document.querySelector('[class$="_header"] [class$="_tabs"]');
				const seated = tabs ? tabs.querySelector(':scope > [class$="_headerActions"]') : null;
				const wrap = document.querySelector('[class$="_titleCluster"] > div');
				if (seated !== null) {
					if (wrap !== null) wrap.appendChild(seated);
					else seated.remove();
				}
			}
			function ensureWhaleObserver() {
				if (whaleObserver !== null || typeof MutationObserver === "undefined" || !document.body) return;
				whaleObserver = new MutationObserver(() => syncWhale());
				whaleObserver.observe(document.body, { attributes: true, attributeFilter: ["data-sidebar-collapsed"], subtree: true });
			}
			function evaluate() {
				if (isMobilePortrait()) { apply(); ensureWhaleObserver(); }
				else revert();
			}
			evaluate();
			window.addEventListener("orientationchange", evaluate);
			window.addEventListener("resize", evaluate);
			// ── keyboard discipline ───────────────────────────────────────────
			// The composer is a shell-owned LEXICAL editor — a contenteditable div,
			// NOT a textarea. Two separate ≤1.4.3 bugs came from assuming otherwise:
			// the Enter handler called execCommand (which Lexical ignores), and the
			// "don't pop the keyboard" guard tested `TEXTAREA || INPUT` inside
			// `[class$="_composerSeat"]`, so it never matched and the input method
			// kept appearing when the user tapped the whale button, a session row,
			// or anything else that makes the app hand the keyboard back
			// ("An overlay that takes the keyboard hands it back through
			// SessionInput.focus()" — the conversation plugin's own docs).
			// Everything below now shares one predicate.
			const COMPOSER_WRAP = '[class$="_composerSeat"],[class$="_input"],[class$="_composer"]';
			const OWN_UI = '[class*="dshLan"]';
			function isTextEntry(el) {
				if (!(el instanceof HTMLElement)) return false;
				if (el.isContentEditable === true) return true;
				return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
			}
			function isComposerField(el) {
				if (!isTextEntry(el)) return false;
				if (el.closest(OWN_UI) !== null) return false; // our own gate/picker inputs
				if (el.getAttribute("contenteditable") === "true") return true; // the Lexical composer
				return el.closest(COMPOSER_WRAP) !== null;
			}
			// "Warm" = the user is typing here right now (or was, moments ago).
			// Every real interaction with the composer refreshes it, so the app can
			// still restore the caret after a send — closing the keyboard
			// mid-conversation would be a bug of its own — while a focus that
			// follows an unrelated tap is dropped.
			const COMPOSER_WARM_MS = 3000;
			let composerWarmAt = 0;
			const warmComposer = () => { composerWarmAt = Date.now(); };
			const composerIsWarm = () => Date.now() - composerWarmAt < COMPOSER_WARM_MS;
			document.addEventListener("pointerdown", (e) => {
				if (active && isComposerField(e.target)) warmComposer();
			}, true);
			document.addEventListener("keydown", (e) => {
				if (active && isComposerField(e.target)) warmComposer();
			}, true);
			document.addEventListener("input", (e) => {
				if (active && isComposerField(e.target)) warmComposer();
			}, true);
			// Backstop: however the focus happened (including code that captured
			// the original focus() before we patched it), take the keyboard back
			// whenever it was not the user's idea.
			document.addEventListener("focusin", (e) => {
				if (!active) return;
				const t = e.target;
				if (!isComposerField(t)) return;
				if (composerIsWarm()) { warmComposer(); return; }
				t.blur();
			}, true);
			const lanOrigFocus = HTMLElement.prototype.focus;
			HTMLElement.prototype.focus = function (options) {
				if (active && isComposerField(this) && !composerIsWarm()) return;
				return lanOrigFocus.call(this, options);
			};
			// ── mobile input & sidebar behaviors ─────────────────────────────
			// Plain Enter sends; the app's own keymap inserts a line break on
			// Shift+Enter ("Plain Enter uses the configured delivery mode, exactly
			// Ctrl+Enter uses its complement, and Shift+Enter inserts a line
			// break"). On mobile we want Enter = newline, so we swallow the plain
			// Enter and re-issue it as Shift+Enter on the same target: the app then
			// runs its own newline command. ≤1.4.2 called
			// document.execCommand("insertText", "\n"), which a Lexical editor
			// ignores — and because the event was also prevented, the key did
			// NOTHING at all.
			function composerStructure(el) {
				if (el === null) return -1;
				return el.querySelectorAll("br").length * 1000 + el.children.length;
			}
			function dispatchSyntheticShiftEnter(target) {
				const event = new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					keyCode: 13,
					which: 13,
					shiftKey: true,
					bubbles: true,
					cancelable: true,
					composed: true
				});
				// Mark it so our own capture listener leaves it alone (the
				// shiftKey guard would do that too; this is belt and braces).
				try {
					Object.defineProperty(event, "__dshLanLineBreak", { value: true });
				} catch (err) {}
				target.dispatchEvent(event);
			}
			function insertLineBreakComposer(target) {
				const root = target.getAttribute("contenteditable") === "true"
					? target
					: target.querySelector('[contenteditable="true"]') ?? target.closest(COMPOSER_WRAP)?.querySelector('[contenteditable="true"]') ?? null;
				const before = composerStructure(root);
				const changed = () => root !== null && composerStructure(root) !== before;
				// 1) the app's own binding
				dispatchSyntheticShiftEnter(target);
				window.setTimeout(() => {
					if (changed()) return;
					// 2) Lexical also honours a beforeinput line-break request
					try {
						(root ?? target).dispatchEvent(new InputEvent("beforeinput", {
							inputType: "insertLineBreak",
							bubbles: true,
							cancelable: true,
							composed: true,
							data: null
						}));
					} catch (err) {}
					window.setTimeout(() => {
						if (changed()) return;
						// 3) legacy path, for a plain contenteditable
						try { document.execCommand("insertLineBreak"); } catch (err) {}
					}, 60);
				}, 60);
			}
			function onKeydownCapture(e) {
				if (!active) return;
				if (e.__dshLanLineBreak === true) return;
				if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
				const t = e.target;
				if (!isComposerField(t)) return; // our own inputs keep their Enter
				// Never fight the IME: while composing, Enter commits a candidate.
				if (e.isComposing || t.isComposing || e.keyCode === 229) return;
				e.preventDefault();
				e.stopPropagation();
				insertLineBreakComposer(t);
			}
			// registration was accidentally dropped in the v65 swipe rewrite —
			// without it the official Enter-to-send handler wins again
			document.addEventListener("keydown", onKeydownCapture, true);
			function collapseSidebar() {
				const toggle = window.__dshLanAdapt && window.__dshLanAdapt.toggleSidebar;
				if (typeof toggle === "function") toggle();
			}
			function expandSidebar() {
				const toggle = window.__dshLanAdapt && window.__dshLanAdapt.toggleSidebar;
				if (typeof toggle === "function") toggle();
			}
			// Auto-collapse the expanded sidebar on mobile: after clicking a
			// session row, or when tapping anywhere outside the sidebar
			// (overlays/dialogs/whale excluded).
			function onClickCapture(e) {
				if (!active) return;
				const frame = document.querySelector('[class$="_frame"]');
				if (!frame || frame.hasAttribute("data-sidebar-collapsed")) return;
				const t = e.target;
				if (t.closest('[class$="_sidebarCol"]')) {
					// v68: opening settings also folds the sidebar so the modal
					// closes back into a clean conversation view. Clicks on the
					// session row-actions ellipsis (or its opened menu anchor)
					// must NOT collapse the sidebar — they open the action menu.
					// v76: clicking the top-level New Session also folds.
					// v77: clicking a workspace row's "new conversation" button
					// (the second button in its rowActions) also folds.
					const topNewSessionClicked = t.closest('[class$="_newSession"], [class$="_brand"]') !== null;
					let projectNewSessionClicked = false;
					const projectActions = t.closest('[class$="_projectRow"] [class$="_rowActions"]');
					if (projectActions !== null) {
						const btn = t.closest('button');
						const btns = projectActions.querySelectorAll('button');
						projectNewSessionClicked = btn !== null && btns.length > 0 && btn === btns[btns.length - 1];
					}
					let shouldCollapse = false;
					if (t.closest('[class$="_sessionRow"]') !== null) {
						shouldCollapse = t.closest('[class$="_rowActions"]') === null;
					} else if (t.closest('[class$="_settingsArea"]') !== null || topNewSessionClicked || projectNewSessionClicked) {
						shouldCollapse = true;
					}
					if (shouldCollapse) collapseSidebar();
					return;
				}
				if (t.closest('[class$="_overlay"], [class$="_dialog"], [class$="_menu"], [class*="_portal"], #dshLanWhale, #dshLanGate')) return;
				collapseSidebar();
			}
			document.addEventListener("click", onClickCapture, true);
			// v65/v66: swipe gestures on mobile. Uses touch events (headless
			// touch emulation synthesizes touchstart/move/end but NOT
			// pointerup). Swiping LEFT while the sidebar is expanded collapses
			// it (dragging the left-edge rail back); swiping RIGHT in the
			// conversation view opens the official sidebar (the whale button
			// stays as the other entry point). Vertical swipes (list scrolling),
			// swipes starting on inputs (textarea horizontal scroll) and swipes
			// starting on the whale are ignored.
			// v85: the whale no longer drags (it is a fixed header control now),
			// but a swipe that begins on it must still not toggle the sidebar.
			// v73: wide tables (trajectory view) and other horizontally
			// scrollable containers must swallow horizontal swipes — a
			// scroll-pan on the table must never become a sidebar gesture.
			function insideHScrollable(el) {
				let n = el;
				while (n && n !== document.body) {
					const cs = getComputedStyle(n);
					if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && n.scrollWidth > n.clientWidth + 4) return true;
					n = n.parentElement;
				}
				return false;
			}
			document.addEventListener("touchstart", (e) => {
				if (!active) return;
				const t = e.target;
				// tables (trajectory ledger) use overflow-x:hidden panes with wide
				// payload cells — panning across them must never open the sidebar
				if (t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.closest("#dshLanWhale") !== null || insideHScrollable(t) || t.closest('table, [class$="_table"], [class$="_tablePane"]') !== null)) { swipeTouch = null; return; }
				const ct = e.changedTouches && e.changedTouches[0];
				if (!ct) return;
				swipeTouch = { x: ct.clientX, y: ct.clientY, id: ct.identifier };
			}, { capture: true, passive: true });
			document.addEventListener("touchend", (e) => {
				if (swipeTouch === null) return;
				const ct = e.changedTouches && e.changedTouches[0];
				if (!ct || ct.identifier !== swipeTouch.id) return;
				const dx = ct.clientX - swipeTouch.x;
				const dy = ct.clientY - swipeTouch.y;
				swipeTouch = null;
				if (!active) return;
				if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
				const frame = document.querySelector('[class$="_frame"]');
				if (!frame) return;
				if (document.querySelector('[class$="_overlay"], [class$="_dialog"], [class$="_menu"], [class*="_portal"]') !== null) return;
				const collapsed = frame.hasAttribute("data-sidebar-collapsed");
				if (dx < 0 && !collapsed) collapseSidebar();
				else if (dx > 0 && collapsed) expandSidebar();
			}, { capture: true, passive: true });
			document.addEventListener("touchcancel", () => {
				swipeTouch = null;
			}, true);
			// ── v??: long-press a session row opens the same action menu as the
			// desktop's right-side ellipsis button (rename / fork / archive).
			// On touch the row-actions button is display:none (it is hover-only
			// on desktop), so a long press must reveal + click it programmatically.
			const LONG_PRESS_MS = 500;
			const LONG_PRESS_MOVE = 10;
			let longPress = null;
			let suppressSessionClickUntil = 0;
			let suppressSessionClickRow = null;
			// After a long-press opens the menu, the finger-lift fires pointerleave
			// on the Menu root; with closeOnPointerLeave the official menu would
			// arm a 200ms close and vanish. Guard against that for a short window.
			let longPressMenuGuardUntil = 0;
			function clearLongPress() {
				if (longPress !== null) {
					if (longPress.timer !== null) window.clearTimeout(longPress.timer);
					longPress = null;
				}
			}
			function openSessionMenu(row) {
				const actions = row.querySelector('[class$="_rowActions"]');
				const btn = actions && actions.querySelector('button');
				if (!actions || !btn) return;
				// The official row hides actions until hover/menuOpen; force the
				// anchor visible just long enough for .click() to be accepted.
				longPressMenuGuardUntil = Date.now() + 1200;
				actions.style.display = "inline-flex";
				try {
					btn.click();
				} finally {
					// After React flushes the menuOpen state, the official CSS
					// keeps the actions visible; if it did not open, hide again.
					window.setTimeout(() => { actions.style.display = ""; }, 50);
				}
			}
			document.addEventListener("touchstart", (e) => {
				if (!active) return;
				const t = e.target;
				if (!(t instanceof HTMLElement)) { clearLongPress(); return; }
				const row = t.closest('[class$="_sessionRow"]');
				if (!row || t.closest('[class$="_rowActions"]') !== null) {
					clearLongPress();
					return;
				}
				const ct = e.changedTouches && e.changedTouches[0];
				if (!ct) return;
				clearLongPress();
				const lp = {
					row,
					x: ct.clientX,
					y: ct.clientY,
					timer: null,
					triggered: false
				};
				lp.timer = window.setTimeout(() => {
					if (longPress !== lp) return;
					lp.triggered = true;
					openSessionMenu(lp.row);
					try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
				}, LONG_PRESS_MS);
				longPress = lp;
			}, { capture: true, passive: true });
			document.addEventListener("touchmove", (e) => {
				if (!active || longPress === null) return;
				const ct = e.changedTouches && e.changedTouches[0];
				if (!ct) return;
				if (Math.abs(ct.clientX - longPress.x) > LONG_PRESS_MOVE || Math.abs(ct.clientY - longPress.y) > LONG_PRESS_MOVE) {
					clearLongPress();
				}
			}, { capture: true, passive: true });
			document.addEventListener("touchend", (e) => {
				if (!active || longPress === null) return;
				const ct = e.changedTouches && e.changedTouches[0];
				if (!ct) return;
				const lp = longPress;
				clearLongPress();
				if (lp.triggered) {
					// Stop the finger-lift from also opening the session; the menu
					// is already open and the sidebar should stay put.
					e.preventDefault();
					suppressSessionClickUntil = Date.now() + 800;
					suppressSessionClickRow = lp.row;
				}
			}, { capture: true, passive: false });
			document.addEventListener("touchcancel", () => {
				clearLongPress();
			}, true);
			// A long press ends with a synthetic click; swallow that one click so
			// it neither opens the conversation nor collapses the sidebar.
			window.addEventListener("click", (e) => {
				if (!active || Date.now() > suppressSessionClickUntil) return;
				const t = e.target;
				if (t instanceof HTMLElement && suppressSessionClickRow !== null && (t === suppressSessionClickRow || suppressSessionClickRow.contains(t))) {
					e.stopPropagation();
					e.preventDefault();
					suppressSessionClickUntil = 0;
					suppressSessionClickRow = null;
				}
			}, true);
			// Some Android browsers fire a native context menu after a long press.
			document.addEventListener("contextmenu", (e) => {
				if (!active) return;
				const t = e.target;
				if (!(t instanceof HTMLElement)) return;
				if (t.closest('[class$="_sessionRow"]') !== null && ((longPress !== null && longPress.triggered) || Date.now() <= suppressSessionClickUntil)) {
					e.preventDefault();
				}
			}, true);
			// Keep the long-press menu open across the finger-lift: the official
			// Menu closes on pointerleave of its root, which fires on touch end.
			document.addEventListener("pointerleave", (e) => {
				if (!active || Date.now() > longPressMenuGuardUntil) return;
				const t = e.target;
				if (t instanceof HTMLElement && (t.closest('[class$="_rowActions"]') !== null || t.closest('[class$="_sessionRow"]') !== null || t.closest('[class$="_projectRow"]') !== null)) {
					e.stopPropagation();
				}
			}, true);
			// (The keyboard-suppression guard lives in the "keyboard discipline"
			// section above, together with the Enter handler: one predicate for
			// "is this the composer field", because the composer is a Lexical
			// contenteditable and the old TEXTAREA/INPUT test never matched it.)
			// plugin apply() wires toggleSidebar to ctx.layout once it is live
			window.__dshLanAdapt = { evaluate, toggleSidebar: null, isMobilePortrait };
		})();
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
		const PLUGIN_VERSION = "1.5.3";
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
		let localClient = isLoopbackHostname() ? true : null;
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
			return localClient === true || (localClient === null && isLoopbackHostname());
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
		const css = ".dshLan_row{flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex}.dshLan_head{align-items:center;gap:8px;display:flex}.dshLan_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.dshLan_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.dshLan_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.dshLan_toggle{appearance:none;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);cursor:pointer;position:relative;transition:background .15s}.dshLan_toggle:disabled{cursor:default;opacity:.5}.dshLan_toggle::after{content:\"\";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .15s,background .15s}.dshLan_toggle[aria-checked=\"true\"]{background:var(--dsw-alias-brand-primary)}.dshLan_toggle[aria-checked=\"true\"]::after{left:22px;background:#fff}.dshLan_status{flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex}.dshLan_urls{font-family:var(--dsw-font-family-mono,monospace);word-break:break-all}.dshLan_row2{align-items:center;gap:8px;display:flex;flex-wrap:wrap}.dshLan_input{flex:1;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;outline:none;max-width:280px;min-width:160px}.dshLan_btn{height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 14px;cursor:pointer}.dshLan_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshLan_btn:disabled{cursor:default;opacity:.5}.dshLan_badge{align-self:flex-start;border-radius:999px;background:var(--dsw-alias-success-bg,rgba(46,160,67,.15));color:var(--dsw-alias-success-fg,#2ea043);font-size:12px;line-height:18px;padding:2px 10px}.dshLan_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.dshLan_pending{color:var(--dsw-alias-state-success-primary,#2ea043);font-size:12px;line-height:18px}.dshLanLock{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}.dshLanLock:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshLanLock.rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}.dshLanLockLabel{white-space:nowrap;overflow:hidden}[class$=\"_footerActions\"]{flex-wrap:wrap}";
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
			pending: "dshLan_pending"
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
		* This stylesheet is injected here rather than living in the mobileAdapt
		* block on purpose: `mobileAdapt` only writes its CSS in portrait-phone
		* mode, so a rule placed there would never apply on a desktop browser —
		* which is exactly where a LAN client with this useless launcher shows up.
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
				const firewallLabel = data.firewallSource === "system" || data.firewallSource === "observed"
					? t("firewall.system")
					: data.firewallManaged === false
						? t("firewall.na")
						: t(data.firewallOk ? "firewall.ok" : "firewall.bad");
				const firewallHint = data.enabled === true && data.firewallSource === "plugin" && data.firewallOk !== true
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
					firewallText,
					t(passwordSet ? "password.set" : "password.unset")
				].filter((part) => typeof part === "string" && part.trim() !== "");
				statusLines.push(react.createElement("div", { children: statusParts.join(" \u00b7 ") }));
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
				react.createElement("div", { className: c.head, children: [
					react.createElement("div", { className: c.rowText, children: [
						react.createElement("div", { className: c.title, children: t("title") }),
						react.createElement("div", { className: c.desc, children: t("description") })
					] }),
					local ? toggle : null
				] }),
				react.createElement("div", { className: c.status, children: statusLines }),
				local ? passwordSection : unlockSection,
				local ? react.createElement("div", { className: c.rowText, children: [
					react.createElement("div", { className: c.desc, children: t("port.label") }),
					react.createElement("div", { className: c.desc, children: t("port.help") })
				] }) : null,
				local ? portSection : null
			] });
		}

		// ── privileged-call rerouting ────────────────────────────────────────
		function wrapApi(connection) {
			const api = connection?.api;
			if (api === void 0 || api.__dshLanWrapped === true) return;
			api.__dshLanWrapped = true;
			const original = api.postJson.bind(api);
			api.postJson = function (path, body, signal, timeoutPolicy = "default") {
				const method = typeof path === "string" && path.startsWith("/api/") ? path.slice(5) : "";
				if (method === "" || clientIsLocal() || !PRIVILEGED.has(method)) {
					return original(path, body, signal, timeoutPolicy);
				}
				const lanMethod = lanMethodOf(method);
				const requestSignal = timeoutPolicy === "default"
					? signal === void 0
						? AbortSignal.timeout(this.timeoutMs)
						: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
					: signal;
				const key = storedKey();
				return window.fetch(new URL("/lanapi/" + lanMethod, window.location.origin), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(key === "" ? {} : { "x-dsh-lan-key": key })
					},
					body: JSON.stringify(body),
					signal: requestSignal
				}).then((response) => {
					if (response.status === 403) {
						clearStoredKey();
						store.set({ unlocked: false });
						if (shouldGate()) mountGate();
					}
					if (!response.ok) throw new Error("transport failure for " + path + ": HTTP " + response.status);
					return response;
				});
			};
			}
		// v62: official surfaces (agent-preset controller etc.) call
		// connection.api.postJson — so wrapApi above never sees them and
		// they hit /api/* directly, which the host gates by Host/Origin trust
		// (allowed for LAN literals when bound to 0.0.0.0). Intercept at the
		// network layer instead:
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
			// On a phone, focusing this field pops the input method before the user
			// asked for anything — and the gate is remounted after a refused key or
			// a keyless 403, so it could happen again and again (reported ≤1.4.3).
			// Desktop keeps the convenience; touch clients tap the field.
			const mobilePortrait = typeof window.__dshLanAdapt?.isMobilePortrait === "function" && window.__dshLanAdapt.isMobilePortrait() === true;
			if (!mobilePortrait) input.focus();
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
			"uiWorkspace",
			"layout"
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
					"password.set": "\u5df2\u8bbe\u53e3\u4ee4",					"password.unset": "\u672a\u8bbe\u53e3\u4ee4",
					"password.placeholder": "\u8bbe\u7f6e\u53e3\u4ee4\uff08\u81f3\u5c11 4 \u4f4d\uff09",
					"password.save": "\u4fdd\u5b58\u53e3\u4ee4",
					"password.clear": "\u6e05\u9664\u53e3\u4ee4",
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
					"password.set": "password set",
					"password.unset": "no password",
					"password.placeholder": "Set password (min 4 chars)",
					"password.save": "Save password",
					"password.clear": "Clear password",
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
				const pickerInjected = () => {
					const browse = pickerBrowse();
					return {
						listDirectory: (path, signal) => browse.listDirectory(path, signal),
						createDirectory: (path, name) => browse.createDirectory(path, name),
						t: ctx.locale.bind(LAN_PICKER_NS)
					};
				};
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
			wrapApi(ctx.get("connection"));
			installLanFetchReroute();
			// Hide host-only header affordances (the app launcher) when this
			// browser is on a LAN device rather than the host itself.
			void syncNonLocalPosture();
			ctx.on("connection/reset", () => {
				wrapApi(ctx.get("connection"));
			});
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
			// the mobile whale button expands the collapsed sidebar through the
			// official layout service (narrow mode flips narrowExpanded)
			if (window.__dshLanAdapt) {
				window.__dshLanAdapt.toggleSidebar = () => ctx.layout.toggleSidebar();
			}

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
