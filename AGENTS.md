# AGENTS.md — dsh-lan-tool 维护指南

给后续修改本项目的 AI/开发者：先读完本文件再动代码。这里记录的是**踩过的坑、必须遵守的契约、以及验证方法**，不是项目介绍（介绍见 `README.md`）。

当前基线：**dsh-lan-tool 1.5.0 ↔ DeepSeek Harness 桌面版 0.2.1-rc.2**（版本号见 `resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion`）。本文件的运行时事实均已在 0.2.1-rc.2 的 `app.asar` 内逐文件核对，括号里给的是 asar 内路径（以 `dsh/node_modules/` 开头）。**0.2.0-rc.2 → 0.2.1-rc.2 的破坏性变更见 §3.5（那一条改了整个局域网实现方式）。**

---

## 1. 项目定位与文件地图

dsh-lan-tool 是 DeepSeek Harness（DSH）Web GUI 的局域网访问插件，双半边结构，**按官方 bundle 插件规范安装**（没有安装脚本）：

```
package.json      name=dsh-lan-tool；dsh.bundle.patch / dsh.compatibility / dsh.client.{platform,inject}
cordis.patch.yml  bundle 补丁：只有一条 insert 行，**故意不写 webserver 覆盖**
lib/index.js      node 半边（host 平面）：状态文件、防火墙、口令门、/lanapi、/dsh-lan/*、反代的装配与门禁
lib/lan-proxy.js  局域网反向代理（v1.5.0 起"局域网访问"的实现本体）：按接口地址监听 + HTTP/WS 反代
lib/client.js     浏览器半边：登录门、移动端触控适配、设置页「局域网访问」卡片、侧栏锁定按钮、工作区目录选择器（影子）
lib/landing.html  门后落地页（口令 → /dsh-lan/unlock → /dsh-lan/mint → 干净 /）
README.md / README.en.md   面向用户；**不放更新记录**
test/loopback-gate.test.mjs   `npm test`（离线，自包含）
test/lan-proxy-e2e.mjs        **可选**端到端（真 Host + 真代理，会占用局域网监听端口）
```

- `package.json` 的 `dsh.client.platform = "web"`、`dsh.client.inject` 决定客户端半边被谁加载、按什么顺序加载；`type: module`。
- `lib/client.js` 的形态是 DSH 客户端模块约定：整体包在 `window.__ModuleLoader__.load({ id, factory: (require) => { ... exports.apply / exports.inject } })` 里。**不要**改成 ESM、也不要引入打包器产物。

### 1.1 四处名字必须逐字一致（改名 checklist）

| 位置 | 现值 | 为什么必须一致 |
|---|---|---|
| `package.json.name` | `dsh-lan-tool` | 安装 spec 校验（全小写）；bundle 登记名 |
| `cordis.patch.yml` 的 `insert[].name` | `dsh-lan-tool` | loader 用它 `import()`；**insert 分支不校验 name**，写错只表现为 import 失败 |
| `lib/index.js` 的 `const name` | `dsh-lan-tool` | 行标识（客户端 bundle 的 id 来源） |
| `lib/client.js` 第 2 行的 `id:` | `dsh-lan-tool` | **`window.__ModuleLoader__.load({id})` 的 id 就是包名**：`ClientModuleSystem.arrive(row)` 要求 `factories.has(row.id)`，而 `row.id` 来自包名（`@deepseek-ai/dsh-client-modules/lib/client.js` 的 `arrive()` / `graphRow(packageName, …)`）。写错 ⇒ 该 bundle 永远"loaded without registering"⇒ 半边不加载 |

另需一致的两处（非硬约束，但必须各写各的对）：

- `lib/client.js` 里所有 `tag.dataset.plugin = "dsh-lan-tool"`：**这个属性会被读**。`removeOwnedStyles(id)`（`dsh-client-modules/lib/client.js` 的 entry-lifecycle 段）按 `style[data-plugin] === 包 id` 删除该插件拥有的样式；写成别的值只会让样式标签删不掉。（旧文档写的"只写不读"是错的，别照抄。）
- 插槽注册的 `registrant`（座位看护用它判断"自己是否在座"）。

`data-plugin-css` 的 id 前缀（`dsh-lan-tool/*.css`）只是去重句柄，前缀变了最多残留一个空 `<style>`。

---

## 2. 安装路径（只有一条：bundle 路径）

| 路径 | 命令 | 落地位置 | 生效方式 |
|---|---|---|---|
| **bundle 路径（唯一）** | 应用内 Plugins 页输入 `dsh-lan-tool`；或 `dsh plugin --profile desktop add <spec>` | `<DSH_HOME>/profiles/<profile>/node_modules/dsh-lan-tool` + 写回 profile `package.json` 的 `dsh.profile.bundles` | 官方装载管线；node 半边改动需重启 `dsh web`/桌面版 |

- `dsh-plugin-manager` 的 `reconcile()`（`@deepseek-ai/dsh-plugin-manager/lib/types/operations.js`）会把带 `dsh.bundle` 的新依赖自动追加进 `dsh.profile.bundles`。
- CLI 需要**先退出桌面版**（`requireDesktopProfile` 只检查 profile 有没有初始化过，"fully quit"只是文案；真正的风险是运行中改写 `node_modules` 在 Windows 上被占用）。
- **刚发布的版本会被 pnpm 的"发布年龄"策略挡住（2026-10-12 实测事故，排查"修了却没生效"先看这条）**：pnpm 默认不安装"太新"的包，而 `dsh-plugin-manager` 只会给**它实际装到的那个版本**在 profile 的 `pnpm-workspace.yaml` 里补一条 `minimumReleaseAgeExclude`。于是当天连着发布 1.4.0 → 1.4.1 → 1.4.2 之后，用户在 Plugins 页输入包名**每次都解析回 1.4.0**（日志现象：`+ dsh-lan-tool ^1.4.0`、`Progress: resolved … reused 1`；证据文件：`<DSH_HOME>/profiles/<profile>/pnpm-workspace.yaml`），看起来就是"新版本没修好"，实际是旧版本被反复装上、重启多少次都一样。
  - **判定**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里有没有目标版本 ＋ 安装日志里的 `^<版本>`。
  - **解法**：把目标版本加进该名单（如 `- dsh-lan-tool@1.4.2`），或在 Plugins 页/CLI 显式写 `包名@版本`。**发新版并希望用户立刻装到时，先补这一条**，否则对方拿到的还是上一次的版本。
  - **作者机 2026-10-14 的现状（重要）**：作者机的 `pnpm-workspace.yaml` 里那 5 条 `dsh-lan-tool@1.4.x` 豁免**已被有意清空**（当时在做彻底卸载）。**因此下次要在作者机装本插件，必须先手动补回 `- dsh-lan-tool@<目标版本>`**，否则 24 小时窗口会把刚发布的版本挡回去 —— 表现就是"明明发了新版，装上的还是旧版"。
  - **"卸载/安装失败：`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`"与"豁免没生效"是两个不同层次的闸（2026-10-14 实测）**：任何 `install / add / remove` 都会**先拿旧 lockfile 逐条重跑策略**（pnpm 的 lockfile 验证闸），这一步**不认** `minimumReleaseAgeExclude`——所以会出现"09:17 装得上（全新解析，认豁免）、09:48 卸不掉（复检旧 lockfile，不认豁免）"这种自相矛盾的现象，而**包其实在报错前就已经被删掉了**（`node_modules/<pkg>` 已不存在），非零退出码只是复检失败。**解法（实测 exit 0）**：先跑一次 `pnpm install --lockfile-only` 刷新 lockfile 与验证缓存，再重试原命令。日志在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`（`✓ Lockfile passes…` 与 `✗ Lockfile failed supply-chain policy check` 两行就是判据）。
- **旧的"补丁路径"（把包拷进 `profiles/node_modules` + 正则改 profile 补丁）已随 1.4.0 的安装脚本一起删除，不要恢复**：那套写法必须与 plugin-manager 抢写同一个 YAML 文件，而且在 0.2.0 里 `webServer.register()` 对重复路由直接抛异常。
- 装/卸载开关也可用 `writePluginEnabled` 的产物（`@deepseek-ai/dsh-plugin-manager/lib/types/patch.js`：按 **id + 可选 name** 匹配 profile 补丁里的覆盖行，匹配不到就**追加**一条 `{id, disabled}`）。所以覆盖行的 `id`/`name` 必须与新包名一致，改名时别只改一半。

### 2.1 本机（作者机）开发循环

本机状态：桌面版 **0.2.1-rc.2**，`DSH_HOME=C:\Users\MyBook\.dsh`，活动 profile = `desktop`（`profiles/` 下只有它）。**端口不再是 19387**：0.2.1 的桌面启动器传 `--port 0`（由 OS 分配），所以每次启动的端口都不同 —— 要连它请从窗口标题、日志或 `/dsh-lan/status` 的 `port` 取当前值（本文档里出现 `19387` 的地方都是离线自测的固定桩端口，不是线上值）。

**版本闸门（0.2.1 新增，先看这条再决定 `package.json` 怎么写）**：`dsh-app-boot` 的 `unmetRequirements()` 只校验**两处** —— 有 `engines.dsh` 时**只**看它（peer 全部忽略），否则逐个检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 `peerDependencies`；比较用 `semver.satisfies(..., { includePrerelease: true })`，所以 `"*"` 能满足预发布版。本插件没有 `engines.dsh`，唯一被计入的 peer 是 `@deepseek-ai/dsh-client-connection: "*"` ⇒ **永远通过**（`@deepseek-ai/cordis` 不匹配那两条前缀，直接跳过）。不满足时 plugin-manager 会以 `incompatible-version` 拒绝安装/启用，要用 `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <rt> --accept-risk` 授权。**⇒ 不要随手给 `peerDependencies` 加具体版本范围**：那等于给自己装一道闸。`package.json` 里 `dsh.compatibility.*` 是**纯元数据**（全 asar 无消费点，只是给人看的），别把它当成会被校验的东西。

```powershell
$src='D:\DeepSeek\dsh-LAN'; $dst='C:\Users\MyBook\.dsh\profiles\desktop\node_modules\dsh-lan-tool'
Copy-Item "$src\lib\client.js" "$dst\lib\client.js" -Force
Copy-Item "$src\lib\index.js"  "$dst\lib\index.js"  -Force
Get-FileHash "$src\lib\client.js","$dst\lib\client.js" | Format-Table   # 逐个比对 parity
```

- **只改 `lib/client.js`（浏览器半边）→ 不需要重启**：服务端对 bundle 是**启动时读一次并缓存**（`client-modules.initialBundleSnapshot`），只有 `client-hmr` 每 500ms 的 stat 轮询发现 `lib/client.js` 变化后调 `rebuilt(id)` 才会重读并重算 rev。用 `/plugins/events`（SSE）里图帧的 `"id":"dsh-lan-tool","rev":…` 核对服务端真正在广告的 rev；HTML 里的 `rev` 是启动时定型的，可能是旧值，别只信它。确认后在**新标签页/刷新**里验证（bundle 响应是 `immutable` 长缓存，旧文档内的 URL 不会自己换新字节）。
- **改了 `lib/index.js`（node 半边）→ 必须重启 `dsh web`/桌面版**：node 半边在进程内存里，热加载只重载补丁层。**本机 `dsh web` 进程可能正承载着你用的会话，不要随手杀**，先和用户确认。
- **"装了但没重启"是最容易踩的一脚（1.4.1 实测事故）**：插件**在同一个应用进程内被重装/升级时，node 半边不会换成新代码**（浏览器半边会跟着文件热更新）⇒ 出现"一半新一半旧"的混合版本。1.4.1 的客户端因此问不到服务端的 `local` 字段，只能退回按 hostname 猜，于是**桌面端又被口令页盖住**——用户看到的是"新版本没修好"，实际是旧服务端还在跑。1.4.2 起：`/dsh-lan/status` 带 `version`，客户端带 `x-dsh-lan-client` 头，两侧不一致时客户端在设置卡片与控制台明确写出"请完全退出并重启桌面版"，服务端也 log 一行；README 安装步骤已写死"装完完全退出重启"。**排查"修了却没生效"先确认这一条。**
- `package.json` 里 `dsh.client.inject` 的改动属于启动时组装的 manifest 元数据，下次启动才反映到 HTML 的 `inject` 列表；运行时等待哪些服务由 `lib/client.js` 的 `exports.inject` 决定。
- 版本号：**改任何行为都顺手升 `package.json.version`**（本项目按 1.x.y 走）。

---

## 3. 客户端半边必须知道的运行时事实（0.2.0-rc.2 实测）

### 3.1 服务名 ≠ 包名

`exports.inject` 里写的是**服务名**，不是包名。写包名（或不存在的服务名）会让 fiber 停在 `pending`；0.2.0 的前端启动审计会遍历全部 entry 并把 pending 的列进 `web boot: N entries did not activate`，外壳随即渲染整屏 **「Failed to load plugins」**——是**硬失败**，不是"半边静默不加载"。HTML manifest 里的 `inject: [...]` 才是包名列表（由 `dsh.client.inject` 生成）。

当前 `exports.inject`：

```js
["slots", "locale", "connection", "workspaces", "uiWorkspace", "layout"]
```

**不要**再往这里加 `settingsScope`（0.2.0 全树 0 处提供；加上就是整屏 Failed to load plugins）。

新增服务依赖时**同时**改两处：`exports.inject`（服务名，运行时真正等待）与 `package.json` 的 `dsh.client.inject`（包名，保证加载序）。`dsh.client.inject` 在 schema 层只被校验"是不是字符串数组"（`dsh-client-modules/lib/index.js` 的 `parseDshClient`），按包名查图时**查不到就静默跳过** ⇒ 写错不报错，只是加载序不再被保证。

### 3.2 目录能力在 `uiWorkspace`，不在 `workspaces`

这是本项目的**头号历史 bug**，务必记住：

| 服务名 | 提供者 | 能力 |
|---|---|---|
| `uiWorkspace` | `@deepseek-ai/dsh-client-ui-workspace` | `listDirectory(path?, signal?)` / `createDirectory(path,name)` / `pickDirectory()` / 会话与工作区导航 |
| `workspaces` | `@deepseek-ai/dsh-api-workspace-controller` | 只有 `create / rename / delete / insertBefore / archiveSession / insertSessionBefore` |
| `slots` | `@deepseek-ai/dsh-client-ui-renderer` 的 SlotRegistry | 插槽注册/查询/订阅 |
| `connection` | `@deepseek-ai/dsh-client-connection` | `connection.api.postJson(...)`、`connection/reset` 事件 |

官方 `dsh-client-ui-directory-picker-browse` 注入的就是 `uiWorkspace`。**目录枚举/新建目录调用必须走 `uiWorkspace`**，`workspaces` 只能作为旧版回退（`pickerBrowse()` 就是按这个顺序取的）。

**v1.5.8 的唯一例外（先读这条再改选择器）**：DSH 0.2.1 起 Host 必须绑回环，`dsh-host-directory-picker-auto` 因此**只组合 `native`**（`bindHost` 是回环 + win32/darwin ⇒ native；只有 `allowsRemoteAuthorities` 才 browse）。也就是说 `directoryPicker/list` 这条远端方法**根本不存在**，`uiWorkspace.listDirectory()` 永远答 `directory-picker/unavailable`——插件影子出来的 `directoryFlow` 对话框如果还调它，"新建工作区"就会报"无法打开文件夹 … directory browse failed"。所以对话框的**第一数据源是本插件自己的 `/dsh-lan/fs/list` 与 `/dsh-lan/fs/mkdir`**（node 半边用 `opendir`/`mkdirSync` 实现，返回与官方 `DirectoryListing` 相同的形状），拿不到（404 = 旧 node 半边）才回退 `uiWorkspace`。这两个路由和别的 LAN 端点同一道门：`lanFileAccess()` = 主机自己 / 口令持有者 / mint 出来的浏览器会话——代理对 `/dsh-lan/*` 是无条件放行的（落地页要用），所以门必须做在路由里。

### 3.3 插槽（slot）机制要点

- `single` 类插槽**同一 priority 只能有一个注册**，第二个注册会 **throw** 并让那个插件的 apply 失败；不同 priority 可共存，`priority` **升序取第一个未退位者渲染（lowest renders）**。
- 本插件用 `priority: -1000` + `registrant: "dsh-lan-tool"` 影子覆盖官方选择器（官方在 0），覆盖两个洞：`conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`。**v71 起本机 loopback 也覆盖**。
- entry 的注入面**按 entry 身份缓存**：同一次注册内 `props.listDirectory` / `props.t` 引用稳定，`useEffect` 依赖数组不会因父组件重渲染而抖动。真正的抖动来源只有「entry 被销毁重建」。
- 渲染期抛异常 → 错误边界 `reportEntryError(..., { abdicate: true })` → **该 entry 从 cell 退位**（不再渲染）→ 若看护守卫只看「弹窗在不在 DOM 里」，它会把 entry 重新注册 → 崩溃循环 ⇒ 用户看到「界面不断刷新」。**这是 1.3.1 修复的机制，写新代码时不要再制造同样形态。**
- `document.querySelector(".dshLanP_overlay") !== null` 只能证明「上一帧渲染成功」，不能证明「本次渲染不会崩」。看护必须另有崩溃退避（见 `pickerHealth` 与 `PICKER_SEAT_STABLE_MS`）。

### 3.4 `lib/client.js` 的结构性约束

- 所有 `props.listDirectory(...)` 调用**必须**走 `callListDirectory()`：它把「方法不存在」这类同步 TypeError 转成 rejected promise，避免在 render 阶段（children 是急切构造的）炸掉整个 slot entry。加新调用点时照抄。
- 移动端适配是**纯 DOM/CSS 注入**（`mobileAdapt`），只依赖官方 class 名的哈希后缀（`[class$="_frame"]` 这类选择器）。官方换 hash 前缀不影响它，但**改语义名会**；改动前先确认官方对应包的 class 名。
- **输入框是 shell 自己的 Lexical 富文本编辑器，不是 textarea**（官方文档原话：Plain Enter 用配置的投递模式、Ctrl/Cmd+Enter 用互补模式、**Shift+Enter 插入换行**，Alt/双修饰键留给应用快捷键）。所以"让 Enter 换行"**不能**靠 `document.execCommand` 或改 value —— 1.4.2 及以前正是用 `execCommand("insertText","\n")`，Lexical 完全不理会，而事件又被 `preventDefault` 吞了，结果按键**毫无反应**。正确做法（1.4.3）：**吞掉普通 Enter，再对同一目标补发一个 `shiftKey: true` 的 keydown**，让 App 自己那条换行绑定生效；兜底依次是 `beforeinput{inputType:"insertLineBreak"}` 与 `execCommand("insertLineBreak")`，每次尝试后用「`<br>` 数 ×1000 + 子元素数」判断是否真插入了（防重复插入）。另外合成事件的 `defaultPrevented` 会被 App 的 gesture 层读取，所以吞原始事件时 `preventDefault()` 与 `stopPropagation()` 都要做；IME 组词中的 Enter（`isComposing` 或 `keyCode === 229`）必须放行，否则选不了词。
- **"不要误弹输入法"必须和 Enter 用同一个判定**（1.4.4 的教训）：`isComposerField()` = 文本录入元素（contenteditable / TEXTAREA / INPUT）＋ 不在 `[class*="dshLan"]`（我们自己的 gate/picker 输入框）里 ＋ （是 contenteditable 或落在 `_composerSeat`/`_input`/`_composer` 包装内）。**≤1.4.3 的键盘守卫写的是 `TEXTAREA || INPUT` + `[class$="_composerSeat"]`，而输入框是 Lexical 的 contenteditable ⇒ 这个守卫从来没匹配过**，于是官方在挂载、切会话、以及"关掉一个吃键盘的浮层后把键盘交还 `SessionInput.focus()`"（官方文档原话）时反复把输入法弹出来——用户报的"点小鲸鱼 / 点会话行就弹键盘"就是这个。现在的规则：`pointerdown`/`keydown`/`input` 落在输入框上才把「3 秒内算正在输入」的窗口（`composerWarmAt`）刷新；窗口内允许聚焦（发送后光标回位、键盘不被抢走），窗口外一律拒绝——既拦 `HTMLElement.prototype.focus`（在 factory 顶层安装，早于 React 挂载），也用 `focusin` 兜底（覆盖"在我们 patch 之前就抓走了 `focus()` 引用"的代码、以及任何绕过 prototype 的聚焦）。另外**口令门在手机上不再自动聚焦**（`if (!mobilePortrait) input.focus();`，桌面保留），否则 gate 每次重挂都会弹一次键盘。
- `installLanFetchReroute()` 包了全局 `window.fetch`，`wrapApi()` 包了 `connection.api.postJson`；两者都有 `__dshLanWrapped` / `lanFetchWrapped` 幂等标记。新增网络调用不要绕过 `clientIsLocal()` 判断（主机自己必须走原生路径，见 §3.6）。
- 局域网浏览器上**官方设置栈不可用是有意为之**：`dsh-client-ui-settings` 的 `persistence` 在 `apply()` 里按 `ctx.remote.$host.isLoopback` 取一次性常量，多个对象在**构造期**就据此决定是否 `subscribe`/`derive`，而 `dsh-client-locale` / `dsh-client-ui-chat` 的 README 明说这是 deliberate。**不要**试图"翻开关"（1.3.x 的 `lanHostMode()` 就是这么干的，已删）；卡片文案已改为"设置项请在主机上修改"。

### 3.5 开关 / 绑定 / 补丁的硬约束（最容易写错的一节）

**补丁语义**：补丁对目标是 `target[key] = value`，`config` 是**整块替换**，不是深合并；`webserver` 的 schema 里 `host`/`port` 是 `.required()`、`compression*` 有默认值，而 **`DEFAULT_COMPRESSION = "none"`**（`@deepseek-ai/dsh-host-webserver/lib/index.js`）。0.2.1 起 schema 还多了可选的 **`tls`**（`{certFile,keyFile}`），官方那行写的是 `tls: !!js ctx.webStartup.tls`。

⇒ 如果哪天真要写一条 `- id: webserver / config:` 覆盖，**必须重述全部键**（`host`、`port`、`tls`、`compression`、`compressionLevel`、`compressionThresholdBytes`）：少写 `port` ⇒ 校验失败（fiber FAILED）；少写三键 ⇒ 静默丢 gzip。**但见下：本插件在任何情况下都不许写这条覆盖。**

**v1.5.0 的设计：局域网门是插件自己的反向代理，不是 DSH 的绑定**

- **硬规则一：永远不写 `webserver` 覆盖。** 0.2.1 的 `host` 是 `z.transform` —— 非 IP 字面量、以及任何通配地址（`0.0.0.0`/`::`）都被**拒绝**；而 `webserver` 是 **required** 行 ⇒ 校验失败 ⇒ 整个 Host 起不来。已在 2026-10-17 实测：用户升级到 0.2.1 后启动失败，只能点"禁用第三方插件"恢复按钮（那次崩溃报告就是 `webserver … wildcard … is not supported`）。因此 `lib/index.js` 里**没有任何**生成覆盖的代码：该文件唯一的写入者是 `clearLanBlock()`（只删不写）。
- **硬规则二：也不许把 host 改成具体局域网 IP。** 桌面启动器写死 `args: ["--no-open","--host","127.0.0.1","--port","0"]`，而桌面壳的认证 URL 是它自己拼的 `http://127.0.0.1:<port>/?token=…`。**隔离实测**：把 host 覆盖成具体的 `127.0.0.2` 后 Host 能起来，但壳的令牌交换直接 `ECONNREFUSED 127.0.0.1:<port>` ⇒ 桌面端同样起不来。⇒ **DSH 自己的监听器必须留在回环。**
- **所以局域网只能靠 `lib/lan-proxy.js`**：在本机**每个局域网接口地址**上另起监听（**复用 DSH 的端口号**——同端口不同具体地址可以并存，2026-10-17 在本机实测 `127.0.0.1:21999` + `192.168.192.103:21999` + `192.168.0.207:21999` 同时绑定成功），把 HTTP 与 WebSocket upgrade 反代到 `127.0.0.1:<port>`。
  - **绑定的是具体地址、不是通配**：上游刚以"暴露 RCE 面"为由禁掉通配，我们不该换个地方把它开回来；同时地址集每 `PROXY_REFRESH_MS`（10 秒）复查，Wi-Fi/VPN/DHCP 变化时自动增删监听。
  - **安全阀**：回环目标连不上时**绝不**开监听（不开一扇转发到空处的门）；监听器一律 `unref()`，不拖住进程退出。
  - **Host 头原样保留**：连接服务把浏览器会话 cookie 绑在请求 authority 上，改写成 `127.0.0.1:<port>` 会让每个转发请求都"未认证"。
- **权威状态不是补丁文件，也不再是 DSH 的绑定**：`dsh-lan.json` 的 `lanEnabled` 是**意愿**；`buildStatus().enabled = 代理在听 || DSH 自己绑在非回环地址`（后者覆盖 `dsh web --host <ip>` 这类部署）；`applying = 意愿 !== 代理在听`（刻意只比代理——操作者自己暴露的直连不是开关在等的东西）。
- `profile` 名字与补丁路径**必须**取 `profileContext`（`@deepseek-ai/dsh/lib/profile-boot-*.js` 在启动时 `provide("profileContext", { name, dir, patchPath, home, … })`）：写死 `"web"` 是 1.3.x 的头号静默 bug（开关读写 `profiles/web/cordis.patch.yml`，而桌面版读 `profiles/desktop/…`）。
- **切换开关不再重绑 socket**：v1.5.0 只是开/关我们自己的监听，所以"改补丁 → socket 重绑"那个窗口没有了；但客户端的 `fetchStatus()` 仍保留 `REBIND_GRACE_MS`（8 秒）机制：`markRebindWindow()` + `isTransientFetchError()`，因为开监听、地址集变化、防火墙首次放行都仍会产生短暂的网络类错误。**判据是"网络类错误 **且** 处于窗口内"，不是"任何错误都吞"**。
- **升级自愈的边界（重要）**：`migrateLegacy()` 会把遗留的受管块（含 1.4.x 的 `0.0.0.0` 块）在激活时剥掉——但**已经被它 brick 的 profile 里，插件根本加载不到**（webserver 先失败），所以那种情况只能靠恢复按钮或手删补丁里的块，README 已写步骤。这也意味着**发版后第一件事是检查老用户的补丁**。

### 3.5.1 卸载/停用后的清理（别删掉这段逻辑）

局域网门是插件自己的监听器，门禁（`admit`）是那个实例的闭包 ⇒ **dispose 必须立刻关掉它**（`proxy.stop()`），不能等定时器，否则一个已经卸载的插件还在对外提供入口。补丁文件与防火墙不属于包，所以要晚一点清理：

- **等 8 秒**再动手（`DISPOSE_CLEANUP_DELAY_MS`），并比对 `applyGeneration`：**热重载会立刻重新 apply 同一行**，从而取消清理；只有"真的没了"（Plugins 页停用 / 卸载 / 包被删）才会等到超时。⇒ 这个机制的**所有失败方向都是"局域网回到关"**，永远不会反向打开。
- 超时后：`clearLanBlock(patchPath)` 删掉任何遗留受管块 + 撤防火墙规则，并 log 一行。定时器 `unref()`，不会拖住进程退出；进程在 8 秒内退出（正常关应用）则清理不跑，README 已写手工兜底步骤。
- 改这段时注意：`clearLanBlock(patchPath)` 接收显式路径 —— 定时器回调可能在别的实例已经把 `active` 改掉之后才触发（离线自测里同一进程跑多个 harness 就会这样）。

### 3.6 认证 / 绑定相关（node 半边）

- **"谁是本机"由 TCP 对端决定，绝不由 Host 头决定**（1.4.1 的教训，改这块前先读）：`isLocalRequest(req)` = 对端地址 ∈ {`127.0.0.1`, `::1`} ∪ `localHostAddresses()`（`os.networkInterfaces()` 里本机全部地址，含 IPv6 与 `%zone`，10 秒 TTL 缓存）。**不能用 Host 白名单**：桌面端可能用 `[::1]`（浏览器把 IPv6 字面量报成**带方括号**的形式）、机器名、本机局域网地址，或经 webview/协议改写过的 host 访问自己的 GUI —— 任何白名单都会把主机自己挡在门外。1.4.0 就是这么锁死桌面端的：服务端按 Host 把头判成"非本机"→ 302 到落地页；客户端又按 `location.hostname` 猜（`[::1]` 不在它的名单里）→ 挂上全屏口令层，且因为没设口令把输入框禁用了，主机彻底进不去。**残留取舍**：本机浏览器经 DNS rebinding 域名访问时也算"本机"（与 DSH 官方 `isTrustedApiRequest` 对 loopback 的信任一致）；局域网设备不受影响（对端地址由 TCP 保证，伪造 `Host: 127.0.0.1` 无效）。
- `buildStatus().local` 是**客户端唯一该用的"我是不是主机"**；`loopback` 退化为"页面是不是用回环域名打开的"，只作展示。主机专属细节（`patchFile` / `profile` / `lanUrls` / 防火墙状态 / `platform` / `enforcement`）只发给 `local === true`。
- 客户端侧**不许再用 hostname 猜**：`lib/client.js` 的 `detectLocalClient()` 去问服务端（`/dsh-lan/status` 的 `local`），hostname 只用来初始化"已知本机"。**挂 gate 必须有证据**：只有服务端明确回答 `local === false`（`shouldGate()`）才允许盖住界面；"还没回答 / 探测失败 / 旧服务端没有这个字段"一律视为未知→**不挂**（1.4.1 的教训：拿不准时按 hostname 猜，主机就被自己的 gate 永久盖住）。安全边界始终在服务端，gate 只是体验层。服务端说"是本机"时还会 `removeGate()` 自愈；本机半边旧于 1.4.1 只报 Host 版 `loopback: true` 时也当作本机（桥接）。历史包袱：客户端那个 `isLoopback()` 已删除（IPv6 回环带方括号是它的头号坑），别再加回来。
- **桌面端不是 HTTP 页面**（v1.5.7 的事实，客户端半边必须读）：桌面壳把 SPA 从 **`dsh-app://app/`** 加载（`lib/main.js` 的 `applicationUrl`），再把每个请求带着自己的 host cookie 转到 `http://127.0.0.1:<port>`；页面在注入脚本**之前**已被 `dsh-web-frontend` 的 desktop boot 设上 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`。因此 `location.hostname === "app"`、`isLoopbackHostname()` 为 false，**唯一正确的"我是主机"信号是 `ownsHost`**。`clientIsLocal()` 必须把它当 local（`shellOwnsHost()`），否则桌面端会先按远程处理，并且**只要 `/dsh-lan/status` 探测失败一次就永久停在"非本机"**（`localClient` 保持 null），于是 `settings.*` 等 privileged 调用被改写到 `/lanapi`。
- **`/lanapi` 重入必须传 peer**（v1.5.7）：`connection.createSharedFetchHandler("/api").fetch(request)` 少一个参数时，通道分发读 `peer.signal` 直接抛 `gateway/internal: Cannot read properties of undefined (reading 'signal')` —— 表现为"设置页里所有依赖远端命名空间的东西都报不可用"（内置插件页就是一句 `插件暂时不可用。`）。正确写法是 `.fetch(request, connection.browserPeer)`。
- **版本握手**：`/dsh-lan/status` 报 `version`，客户端请求带 `x-dsh-lan-client`；不一致说明"装了没重启"（node 半边没换代码），客户端在设置卡片与控制台写明、服务端 log 一行。
- 口令门拒绝时会打一行去重日志 `password gate: … — peer=… is not an address of this machine (host=…)`：万一主机又被挡住，这行日志直接指出被判成"非本机"的 peer/host（1.4.0 时这种事故在日志里是完全静默的）。
- **唯一闸门**是 `connection.requestRejection(request)`（`@deepseek-ai/dsh-client-connection/lib/index.js`：Host/Origin 围栏 + 浏览器会话），`admit()` 调它，RPC 路由与 fetch/WS 处理器都走 `admit` ⇒ 直接替换实例方法即可覆盖全部入口。
- `browserAuth.authorizeIndex(req,res)` 只认 `GET /` 上的 token；兑换成功写 authority 绑定的 `HttpOnly; SameSite=Strict` cookie 并 303 到 `./`。`connection.authenticatedUrl(base)` 给 URL 挂进程 token（token 是**进程内存**随机值，磁盘上不存在）。
- **桌面壳的启动握手绝不能被 `patchedAuthorize` 短路（1.4.5 的教训，改 `patchedAuthorize` 前必读）**：桌面端启动时 `main.js` 的 `authenticateWebHost()` 会 `fetch(ready.url, { redirect:"manual" })` 并**要求 `status === 303 && set-cookie !== null`**，否则抛 `Error: Desktop Host authentication failed`，主进程弹出"DeepSeek Harness is unavailable"对话框（第三个按钮是"禁用第三方插件，备份 profile 补丁并重启"）。而 1.4.1–1.4.4 的 `patchedAuthorize` 写的是 `if (local) return true` —— **主机自己一律直接放行**，于是壳拿到的是 `200 + text/html`（走 `frontend-static` 的 `serveStatic()` 直接下发 SPA），启动必失败。触发条件是"**局域网开**的时候重启桌面端"：`boundToAllInterfaces(ctx)` 为真才装这道闸，而这个覆盖块**持久化在 profile 补丁里**，所以**每一次**启动都会失败，用户只能点那个"禁用第三方插件"按钮（它会把 LAN 块一起删掉）才能进应用 —— 进去后再开 LAN，下次启动又坏，表现为"反复发作"。**现行契约（1.4.5）**：本机分支里，`GET /` 且 `searchParams.has("token")` 时**必须委派** `origAuthorizeIndex.call(browserAuth, req, res)`，让它自己判 `303`/`401`；其余本机请求仍 `return true`。这个让渡是安全的：带进程 token **就等于**是主机（token 只在进程内存里），伪造 token 由官方 `tokenMatches()` 直接 401。**口令闸 `requestRejection` 一行都不用动**（它对本机从来都是 `return undefined`）。回归断言见 `test/loopback-gate.test.mjs` N 段。
- **`ensureFencePatched` 的重入护栏必须同时比 connection 与 browserAuth**（1.4.5）：只比 `wrap.connection === connection` 时，若将来出现"同一个 connection 换了一个已打补丁的 browserAuth"，`origAuthorizeIndex` 会捕获到 `patchedAuthorize` 自己，形成嵌套委派（先 303 再被 `serveStatic` 写 200）——正是上面那个崩溃以更难查的形态复现。当前 cordis 把二者成对重建，所以到不了，但护栏要挡住这个方向。
- 官方围栏 `isTrustedApiRequest` 只在 loopback 或命中 `trustedHosts` 时放行，而 `trustedHosts` 是**启动时采样一次**的 LAN 字面量（换 IP/后开开关都可能过期）；本插件用口令门在 `requestRejection` 层放行，因此不依赖它（这也是 `/lanapi` 至今保留的原因之一）。
- `/lanapi`（前缀路由 + 客户端 `/api`→`/lanapi` 改写）在 0.2.0 已**不是必需**（没有按方法的 loopback 专属层），属**可选简化项**；删它需要一次端到端局域网验证（把走它的官方界面都过一遍），**没做那次验证前保留**。
- HMR 让"改开关即时生效"成立，但有前提：`dsh-hmr` 要求进程带 `--expose-internals`、`profileContext` 已 provide、且 `appReady` 就绪（桌面启动器实测满足；其它启动路径未验证）。卡片保留"正在生效"提示，未生效时提示重启。

### 3.7 防火墙状态判定（1.4.3）

- **本插件建的规则只是三个来源之一**，`/dsh-lan/status` 报的应是"OS 到底放行没有"：`firewallSource = plugin`（我们建的 `dsh-lan-tool (auto)`）、`system`（**Windows 自己的「是否允许访问」弹窗建的规则**——程序级、`LocalPort=Any`，按名字查我们的规则是查不到它的）、`observed`（**已经有非本机设备成功连进来过**，最便宜也最硬的证据：`noteRequestHost` 里 `local !== true` 时记 `remotePeerSeenAt`）、`none`（没有受支持的防火墙工具）。
- **必须同时匹配程序**：Windows 上 `LocalPort=Any` 的入站允许规则里混着大量**别的程序**的规则（作者机实测 130 条允许规则，随手一个 `Any` 命中是 Wi-Fi Direct）。只按端口判会把"别的程序被放行"误读成"本端口已放行"。
- **一次完整枚举约 4 秒**（`Get-NetFirewallRule` + 逐条 `Get-NetFirewallPortFilter`；`Get-NetFirewallPortFilter` 全量枚举还需要管理员权限，实测"拒绝访问"）。所以：OS 查询**只在后台跑**，`/dsh-lan/status` 走 stale-while-revalidate（先返回上次结论，过期就丢一个后台刷新）；**冷缓存最多等 `FIREWALL_STATUS_WAIT_MS`（1200ms）**，超时直接答 `checking: true` 并在后台继续。判定不是"我们自己的规则且 ok"时按 **2s→4s→…→60s 封顶**退避重查（1.5.7 之前是 10s 起步，用户点完系统弹窗的「允许」后卡片要十几秒才变绿）；稳定的 `plugin` 判定缓存 10 分钟。`configure` 开关切换时会清空缓存并重置退避，且在回复前就 `ensureFirewallRule()`（v1.5.7）——否则那份"新鲜"探测必然先看到"没规则"。
- **`firewallChecking` 不是"未放行"（v1.5.7）**：开关打开后的头 `FIREWALL_SETTLE_MS`（15s）内，负判定只代表"还没验证完"，`buildStatus` 置 `firewallChecking: true`，卡片用绿色 `firewall.checking` 行展示，**不要**把它渲染成 `firewall.bad`——这正是用户报的"刚切换完显示未放行"。
- 判定失败/超时一律**不报"已放行"**（`firewallOk` 保持 false），失败方向与门禁一致：宁可显示保守；但"不知道"用 `firewallChecking` 表达，别混进"未放行"。
- **编码（1.4.4 实机乱码事故）**：Windows PowerShell 的 stdout 走**控制台代码页**（中文系统是 GBK），所以脚本第一行必须 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`；否则中文规则名会被当 UTF-8 解码成乱码——用户报的 `(������ѧУ�˻�)` 就是这个。实测对照：不加那行得到 `Զ��Э������վ��`，加了得到 `远程协助（入站）`。规则名进卡片前还要过 `sanitizeFirewallNote()`（去 U+FFFD 与控制字符、超 60 字符截断、空则回退 `Windows rule`），这样即使将来又出现编码问题，显示的也是最坏情况下的中性文案而不是乱码。

---

## 4. 修改后的验证方法（必做）

不要只靠读代码。三类手段，按成本从低到高：

### 4.1 离线自测（首选，不需要装插件）

**仓库里已有一份可直接跑的回归测试**：`test/loopback-gate.test.mjs`（`npm test`，约 1 秒，**195 项断言**）。它锁定三条硬规则：**①主机自己永不被口令门拦、局域网设备必被拦**（主机 4 种对端 × 6 种 Host 全放行、局域网对端伪造 `Host: 127.0.0.1` 仍 403、`configure` 只认主机、`/lanapi` 对无 key 设备 403；客户端侧从真实源码切出 `isLoopbackHostname`/`detectLocalClient`/`shouldGate` 动态跑，覆盖 `[::1]` 带方括号、旧服务端无 `local`、缺字段、探测失败、版本不一致——一律不许挂 gate）；**②防火墙状态不许撒谎**（打桩 `netsh` 与 PowerShell 输出，断言"我们自己的规则 / 系统弹窗建的规则（同程序）/ 别人的 Any 端口规则（不算）/ 端口列表与区间 / UDP 不算 / 有局域网设备连入过"六类判定，外加规则名乱码回退、超长截断）；**③移动端键盘**（用打桩 DOM 跑真实的捕获处理器：普通 Enter 被吞并补发 Shift+Enter、IME 组词与 keyCode 229 放行、Shift+Enter 与插件自己的输入框不动、合成事件不自我循环、两级兜底按序触发；以及"冷启动时的程序化聚焦被丢弃 / 点过输入框后放行 / 3 秒后重新变冷 / focusin 兜底会 blur / 我们自己的输入框永不被拦"）。另有版本一致性（两处 `PLUGIN_VERSION` = package.json）、中文文案转义解码、以及"重绑期的网络错误被当成预期"的静态断言。**改 `lib/index.js` 的门禁/防火墙判定、或 `lib/client.js` 的 gate/mobileAdapt 之前，先跑它**。

其余场景（迁移/开关/路由）按下法自测：

node 半边可以直接在 Node 里跑：`DSH_HOME` 指向**临时目录**，把 `node:child_process` 用 `module.registerHooks` 打桩（**保证不会真的动防火墙**），再用假的 `ctx.webServer` / `ctx.get("connection")` 驱动 `/dsh-lan/*` 路由。1.4.0 的验证脚本覆盖：

- **迁移**：预置旧 install/toggle 块 → `apply()` → 断言块被剥除、用户条目保留、YAML 仍可解析、`legacyCleanupDone` 落盘、二次 apply 不重写文件；
- **开关**：`configure({enabled:true})` → 断言补丁里**恰好一条** `- id: webserver` 且五键齐全；来回切三次后仍只有一条；关掉后该行消失且 YAML 合法；
- **门禁**：把 mock 的 `webServer.host` 切到 `0.0.0.0`，直接调 `connection.requestRejection(...)`，断言「无口令 403 / loopback 放行 / 伪造 `Host: 127.0.0.1` 被拒 / 正确口令（头或 cookie）放行」；
- **`[]` 占位符**：profile 补丁只有 `[]` 时开关仍要产出合法 YAML，关掉后回到 `[]`；
- **路由**：unlock（含限流）、mint（302 到 token URL）、landing、`/lanapi` 口令门、`configure` 仅 loopback。

YAML 用 asar 里自带的 `yaml`（`dsh/node_modules/yaml`）解析，别用肉眼：
`yaml.parse(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (v) => v }] })`。

### 4.2 静态一致性断言

"写错也不报错"的改动（改名、换 inject 列）必须配断言：四处包名一致；`exports.inject` 是服务名、`dsh.client.inject` 是包名且互不混杂；bundle 补丁里没有 `webserver` 行；`client.js` 里 `settingsScope` / `lanHostMode` 只剩注释。

### 4.3 真实 GUI（无头 Chrome + CDP，只读）

1. 起无头浏览器：`chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank`，用 `http://127.0.0.1:9222/json/new?<url>` + Node 内置 `WebSocket`（Node ≥22）走 CDP。
2. 必查项：
   - `Runtime.enable` 收 `Runtime.consoleAPICalled` / `exceptionThrown` → **控制台错误必须为 0**（尤其不能有 `Failed to load plugins`）；
   - 每 50ms 采样 `.dshLanP_overlay`，统计**挂载次数**：稳定应为 1（1.3.1 修复前是每秒 1 次）；
   - 采样弹窗内容：`.dshLanP_entry` 条目数、`.dshLanP_crumb` 面包屑数、盘符 `<select>` 选项（Windows 上应含 `C:\|D:\|…`）、`.dshLanP_err` 必须为空；
   - 点一个条目下钻，面包屑应 +1 级；Esc 取消 → 再点「添加工作区」→ 应能再次正常打开，且仍只挂载 1 次；
   - 设置卡片：`GET /dsh-lan/status` 的 `enabled / desiredEnabled / applying / bindHost / warning` 要与 `netstat -ano | findstr <port>` 的**实际绑定**一致；
   - `Network.enable` 观察 `POST /api/directoryPicker/list` 正常返回（LAN 设备上可能经 `/lanapi` 代理）。
3. 收尾：停掉无头 Chrome 进程、删临时 profile 与探针脚本，别留在工作区里。

**禁止**：为了让弹窗「看起来正常」而让探针点击「打开」按钮（会落盘创建真实工作区）；在用户的真实浏览器里做写操作。

### 4.4 隔离端到端（真 Host + 真代理，v1.5.0 起）

`node test/lan-proxy-e2e.mjs` —— **可选、不随 `npm test` 跑**（它会真的在局域网接口上监听，Windows 可能弹一次防火墙询问）。它自己搭隔离环境：

- 在 `%TEMP%` 建一个一次性 `DSH_HOME`，profile 文本文件从线上 profile **复制**，`node_modules/dsh-lan-tool` 用 **junction 指向仓库工作树**（所以测的就是当前代码，不需要安装/发布），并把 `dsh-lan-tool` 追加进 `dsh.profile.bundles`；
- 写 `dsh-lan.json` 时**删掉真实口令**（`passwordHash`/`salt`），只置 `lanEnabled: true`，口令由测试自己在启动后从**主机侧**调 `/dsh-lan/configure` 设一个新值 —— 所以这个测试不需要、也拿不到用户的口令；
- 用 §7 1.4.5 那条"假 main 进程"手法启动真 Host（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals` + asar 内的 `dsh-desktop-host`），收到 `ready` 后按顺序验证 16 项：代理起来且 DSH 仍在回环 / 无凭据的 `/` 302 到落地页、`/api` 403 / 落地页可达 / 错口令拒、对口令过 / mint 302 到**局域网 authority** 的令牌 URL / 令牌兑换 303 + 绑定该 authority 的 cookie / 带 cookie 能拿到 SPA / **补丁里始终没有 `webserver` 覆盖**；
- 收尾会**优雅关闭**子进程（IPC `shutdown` → 5 秒后 SIGKILL 兜底）：直接 `kill()` 在 Windows 上会留下孤儿 Host，而它还占着局域网监听端口，下一次运行就会撞车（踩过一次）。

**改 `lib/lan-proxy.js`、`makeLanAdmit()`、或任何与代理装配相关的代码后，跑它**（`npm test` 只覆盖代理的传输与门禁语义，跑在 `127.0.0.2` 上，不进真 Host）。

---

## 5. 常见反模式（出现即回退）

- 用 `ctx.workspaces.listDirectory` / `createDirectory`（1.3.1 的根因）。
- 把 `exports.inject` 写成包名；或把 `dsh.client.inject` 写成服务名（两个方向都错，而且都不报错）。
- 改包名时漏掉 `lib/client.js` 的 `id:` 或 `data-plugin`（半边不加载 / 样式删不掉）。
- 在 `single` 插槽的同一 priority 上注册第二个 entry。
- 没有退避的座位看护（裸跑 `setInterval(seatIfNeeded, 1000)`）。
- 直接 `props.listDirectory(...)` 而不加 `callListDirectory()` 兜底。
- **写任何 `webserver` 覆盖**（0.2.1 起这是硬红线：通配被 schema 拒绝而 `webserver` 是 required ⇒ 整个应用起不来；具体非回环地址又会打断桌面壳的 127.0.0.1 握手。见 §3.5）。
- **按 `ctx.webServer.host === "0.0.0.0"` 判断开关状态**（0.2.1 起不可能成立；开关的意愿在 `dsh-lan.json` 的 `lanEnabled`，实况是"代理在听"）。
- **把 `admit` 之外的门禁塞进代理**（路径策略只该在 `makeLanAdmit()` 一处；代理模块自身不做任何策略判断，这样它才能被单测驱动）。
- **忘了令牌兑换的豁免**：mint 流程的最后一跳是 `GET /?token=…` 打到代理上，若门禁只认 cookie，局域网登录就永远完不成（`test/lan-proxy-e2e.mjs` 就是这么抓到的）。
- 用 `config.profile ?? "web"` 去找 profile 补丁（必须用 `profileContext`）。
- 手工编辑 profile 补丁里的受管块，或手工恢复安装脚本那套"正则改 YAML"（补丁里现在**不该**有任何本插件的块；`clearLanBlock()` 只负责清理历史遗留）。
- 试图在局域网页面上"解锁"官方设置栈（`settingsScope` 已不存在，见 §3.4）。
- **擅自改作者机已安装的插件或替他安装/升级**：作者只授权改仓库代码与 profile 的 `minimumReleaseAgeExclude`；升级由他自己做。要在真机验证就用 §4.4 的隔离方式（junction 到仓库的临时 profile）。
- 在 README 里堆更新记录或维护须知（约定：README 只作为用户文档；变更与踩坑写进本文件第 7 节或 commit）。

---

## 5.1 发布（tag / GitHub Release / npm）

`.github/workflows/release.yml` 一个文件管两件事，都由 **push `v*` tag** 触发：

| job | 做什么 | 凭据 |
|---|---|---|
| `release` | 建 GitHub Release，notes 由 tag 区间内的 conventional commit 前缀分节生成 | 仓库内置 `GITHUB_TOKEN`（`contents: write`），不需要 PAT |
| `publish-npm` | 把该 tag 指向的那次 commit 发到 npm（`needs: release`，即 Release 建成功才发） | **OIDC trusted publishing**（`id-token: write`），**仓库里没有任何 npm secret** |

- **硬约束（GitHub）**：GitHub 只把 tag 事件派发给「**已存在于默认分支**」的工作流文件。因此该文件落到 `main` 之前推的 tag 永远不会触发——这正是 `v1.0.0` / `v1.2.0` / `v1.3.1` 只有 tag、没有 release 的原因。补历史的 tag：Actions → release → Run workflow，填 tag 名。**这种补历史的手工运行不会发 npm**（`publish-npm` 上是 `if: github.event_name == 'push'`）：那批老版本不该被推到 registry 上，而 `workflow_dispatch` 恰好就是给它们用的。
- **别改成 `on: release: [published]`**：Release 是 `GITHUB_TOKEN` 建的，而 GitHub 明确不派发由 `GITHUB_TOKEN` 产生的事件 ⇒ 那条路永远不触发（除非改用 PAT，而本机没有 PAT）。npm 发布必须挂在 tag push 上。
- **硬约束（npm：首发必须先手工发一次）——2026-10-12 已走完**：trust 只能配在**已存在的包页面**上。`npm trust github` 会**先要 2FA、然后**才报 `404 Package not found`（实测包不存在时 `POST /-/package/<name>/trust` 就是 404），所以"给还没发布的包预配 trust"并不存在。正确顺序：本机发一个占位版把包建出来 → 配 trust → 之后全交给 CI。本仓库已完成：占位 `0.0.1`（`--tag bootstrap`，不占 `latest`）→ trust `73246fc8-0cca-46ac-9bab-b83cf202e458`（`repository=MrMu666/dsh-lan-tool`、`workflow_ref.file=release.yml`、`environment=null`、`permissions=[createPackage, createStagedPackage]`，registry 会自动补上 staged 权限）→ 推 `v1.4.0` 由 CI 首发正式版。当前 `dist-tags = {bootstrap: 0.0.1, latest: 1.4.0}`；占位版想清掉就 `npm unpublish dsh-lan-tool@0.0.1`（要 2FA；不清也无害，它不在 `latest` 上）。
- **首发新包名时会先看到 `0.0.0-stage`**：registry 在包刚建立时先落一个 `0.0.0-stage` 占位版本并把 `latest` 指它，真实版本约 1–2 分钟后才出现在 `versions` 里并接管 `latest`（本次 06:35:12 建页、06:36:5x 见到 0.0.1）。**别据此判断发布失败**，轮询 `npm view dsh-lan-tool` 的 `dist-tags` 才是判据。
- **npm 侧 2FA 只能人工点，但可以从未必是 TTY 的 shell 驱动**：`npm/lib/utils/auth.js` 第 10 行——web-2FA 只在 stdin **和** stdout 都是 TTY 时才启动，所以非 TTY 下直接跑 `npm publish` / `npm trust` 只会拿到 EOTP。实测可行的四步（脚本是临时的，已随 `.tmp-npm` 删除）：
  1. 用脚本对任一 2FA 接口发请求，**必须带 `npm-auth-type: web`**（`npm-registry-fetch` 第 219 行按 `opts.authType` 写这个头；不带它 EOTP 的 body 只有一句 `Unauthorized`，**没有** `authUrl`/`doneUrl`）。
  2. 从 EOTP body 取 `authUrl`/`doneUrl`，调 npm 自己的 `npm-profile` 的 `webAuthOpener(opener, authUrl, doneUrl, opts)`（`opener` 用 `cmd /c start` 打开浏览器即可）拿到一次性 token。
  3. 该 token **可以跨操作使用**：把它当 `--otp` 交给 CLI（`npm publish … --otp=<token>`）实测能过 publish——npm 内部 `otplease()` 就是这么重试的，`npm-registry-fetch` 第 243 行按 `npm-otp` 头发出。
  4. 链接要转给用户去点；**会话只活约 5 分钟**，没人点就作废（`doneUrl` 轮询转 404）。所以先说一声、用户就绪后再发起。
- `npm trust list` 本身也要 2FA（同样是 EOTP），**不能**当无凭据的只读复核用；trust 是否生效以上线结果为准（本次以 CI 首发成功为准）。
- **死路一条（省得再试）**：想借 Git for Windows 的 mintty 给 npm 一个 TTY 走官方流程不行——mintty 的 `-l/--log` 记录会让子进程 stdout 变成管道（实测 `stdout=no`），TTY 条件照样不成立；直接 `Start-Process mintty` 时 PATH 里也没有 `/usr/bin`，`bash`/`npm` 的 shebang 会找不到 bash。
- `publish-npm` 的三道守卫（都做成「失败或跳过」，绝不静默发错东西）：包名必须是 `dsh-lan-tool`；`v<package.json version>` 必须等于 tag（不一致直接红灯）；registry 上已有同版本则**跳过**（所以重跑、补跑、给已发布版本重推 tag 都是幂等的）。预发布 tag（含 `-`，如 `v1.5.0-rc.1`）走 `--tag next`，**不动 `latest`**——DSH 装插件解析的是 `latest`，别让它落到 rc 上。
- **发布后的收尾：把作者机的 `minimumReleaseAgeExclude` 换成新版本（2026-10-14 起为约定）**：每次发完新版，把 `<DSH_HOME>/profiles/<profile>/pnpm-workspace.yaml` 里那条 `- dsh-lan-tool@<旧版本>` **替换**为 `<新版本>`（只留最新一条，删旧），否则 pnpm 的 24 小时窗口会让作者机装不上刚发布的版本（就是 §2 那个坑）。**只改豁免、不要代劳升级**：作者明确要求自己执行安装/升级；改完用 `pnpm config get minimumReleaseAgeExclude --dir <该 profile>` 在**临时副本**里确认 pnpm 真读到了（别为了让 pnpm 读到而在线上 profile 里跑命令）。注意：**分发出去的豁免改不了**（它在别人的 profile 里，不在仓库里），这条只针对作者机。
- **顺便确认 `npm` 侧真的上线了**：`publish-npm` 成功之后轮询 `https://registry.npmjs.org/dsh-lan-tool` 的 `dist-tags`，`latest` 变成新版本、且新版本 `dist.attestations.provenance.predicateType` 存在，才算发完（别只看 workflow 绿灯）。GitHub 的 Actions/Releases REST API 未认证时**很容易撞 403 限流**，那时以 npm 的 `latest` 为准即可 —— `publish-npm` 是 `needs: release`，它成功就蕴含 Release 已建。
- **排障要看 verbose**：npm 的 OIDC 失败是**被吞掉的**（`oidc()` 里 `catch` 只写 verbose 日志，然后照常发 → 表现出来的往往是 401/404 而不是"OIDC 失败"）。所以要 `npm publish --loglevel=verbose`，真正的行是 `Failed token exchange request with body message: …`。最常见就是 trusted publisher 没配或 workflow 文件名/owner/repo 对不上。token 兑换靠 `id-token: write` 提供的 `ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN`；缺权限时 npm 直接跳过 OIDC（`Skipped because incorrect permissions for id-token`）。
- **provenance 只对公开仓库自动开**：`oidc()` 里要求 OIDC token 的 `repository_visibility === 'public'` 且包是 public 才会 `opts.provenance = true`；仓库私有时照常发布、只是没有溯源徽章。另外 OIDC 只在 CI 里生效（`ciInfo.GITHUB_ACTIONS` 等），**本机 `npm publish` 永远走普通登录+OTP 路径**，两者不冲突。
- **回退方案（只在 OIDC 用不了时）**：仓库 secret `NPM_TOKEN` + `env: NODE_AUTH_TOKEN`。注意 npm 已于 2025-12-09 永久吊销 classic token，只能建 granular access token（最长 90 天，需勾 "bypass 2FA"），每季度轮换；能配 OIDC 就别走这条。
- **SSH 密钥只做 git 传输**；Release 对象是 REST API 资源，SSH 创建不了，别在这上面绕。本机也没装 `gh`，没有 PAT/env token。
- 本机 22 端口被封，`~/.ssh/config` 里用 `Host github.com → HostName ssh.github.com / Port 443` 映射；直接连 `git@github.com:443` 会因 443 是 HTTPS 端口而在 `kex_exchange_identification` 被拒。
- **npm 占名**：`dsh-lan-tool` 在 2026-10-12 实测 `registry.npmjs.org` 仍返回 404（未占用），但"未发布"不等于"被保留"。**首次发布（占位或正式）越早越好**；发布前 README 的"按包名一键安装"只在本地路径安装下成立，发布后该说法才真正成立。

---

## 6. 与 dsh-app 的边界：口令页只认「顶层文档」

**这是第二个踩过的坑。它不是本插件代码的缺陷，但每次排查都会撞上，必须记住。**

### 6.1 机制

- 局域网模式下，**没有凭据的非 loopback 客户端**请求 `GET /` → **302 `/dsh-lan/`**（`lib/index.js` 的 `patchedAuthorize`）；要真正拿到 SPA，请求必须带上 **DSH 自己的会话 cookie**。
- 那个 cookie 是 **`HttpOnly; SameSite=Strict`**，由一次**隐藏 fetch 的重定向链**种下（`/dsh-lan/mint` 302 → token URL → `/`；`lib/landing.html` 有注释说明必须跟随跳转，`redirect:"manual"` 会走不通）。
- 因此：**只要承载页面的环境把 GUI 当作「跨站第三方内容」，这个 cookie 就会被现代 WebView / 浏览器的跟踪防护丢弃或分区**，链路永远走不完。
- 1.3.x 的落地页"有 key 就跳"会把这个放大成**无限重定向**（口令页不断闪烁、无法输入）。**1.4.0 已修**：`lib/landing.html` 用 `sessionStorage` 的 `dsh-lan-mint-hops` 计数，超过 `MAX_HOPS=2` 就停止自动跳转、停在表单并提示"浏览器没有保存登录凭据"。所以环境问题现在最多是"每次都要输口令"，不会再变成"页面无法操作"。

### 6.2 判定口径与责任划分

| 现象 | 结论 |
|---|---|
| 移动端/桌面浏览器正常，**dsh-app（Tauri + iframe）闪烁** | **环境问题（dsh-app 侧）**：同一份插件、同一个服务端，差异只在承载上下文——iframe 里 GUI 是跨站第三方，登录 Cookie 落不下去。 |
| 顶层浏览器直接开 `http://<IP>:<端口>` | 正常：顶层文档 = 第一方，`SameSite=Strict` 无障碍。 |
| 地址填 `127.0.0.1` / `localhost` / `[::1]` / 机器名 / 本机局域网地址 | **根本不走口令链路**：主机自己的请求一律放行（判定看 TCP 对端，见 §3.6），客户端也不再按 hostname 猜。此时任何异常都与口令页无关，别往这条线查。（1.4.0 之前只有 `location.hostname` 恰好等于 `127.0.0.1`/`localhost`/`::1` 才享受这个豁免——`[::1]` 这种带方括号的写法会被漏掉，那正是桌面端被锁死的原因。） |

- **dsh-app 侧解法（已在其仓库实施）**：不要用 iframe 承载 GUI，改为**每个地址一个独立顶层窗口**（Tauri `WebviewWindow`），顶层文档 = 第一方，口令只需输入一次。

### 6.3 复现 / 排查手法（只读，勿在用户实例上做写操作）

- 无头 Chrome + CDP：父页面从 `http://localhost:3099`（与目标不同 host）内嵌 `http://<LAN-IP>:<端口>`，即构造出「跨站 iframe」形态；用 `Target.attachToTarget` 挂到 iframe 的 target 上执行表达式，逐秒采样其 `location.href`、是否存在 `input[type=password]`、`document.cookie`，以及 `sessionStorage["dsh-lan-mint-hops"]` 是否已到上限。
- **不要**为了「跑通」而猜或试口令：错误口令下 `POST /dsh-lan/mint` 只会 403（足够确认链路形态）；`dsh-lan-key` 也无法用 JS 伪造成功路径（校验在服务端）。
- 收尾：停掉无头 Chrome、删临时 profile 与探针脚本。

---

## 7. 历史修复（防回归）

### 1.5.8 — "新建工作区"不再报"无法打开文件夹"：影子选择器改用自己的文件系统原语

- **现象**（用户实机，1.5.7）：点「添加工作区 / 新建工作区」→ 红字 `无法打开文件夹： directory browse failed: … directoryPicker/list failed: transport failure for /api/directoryPicker/list: HTTP 400`。
- **根因**：插件从 v71 起用 `priority:-1000` 影子覆盖官方两个 `directoryFlow` 洞，而影子的数据源是 `uiWorkspace.listDirectory()`。**DSH 0.2.1 起 Host 必须绑回环**（见 §3.5），`dsh-host-directory-picker-auto` 于是永远组合 **`native`**（`bindHost` 回环 + win32/darwin ⇒ native；只有 `allowsRemoteAuthorities` 才 browse）⇒ `directoryPicker/list` 这条远端方法**根本不存在**。1.5.0 之后（绑定方式从 `0.0.0.0` 改成回环）这个洞就出现了，只是直到 1.5.7 才有人点到。
  - 隔离复现（真 Host + 无头 Chrome，点「添加工作区」）：请求体 `{"type":"client-request",…,"method":"directoryPicker/list","payload":{"args":{}}}` 得到 **200** + `directory-picker/unavailable: … the composed picker serves "native"`；用户桌面端看到的是 400（桌面壳把 `dsh-app://` 的 POST 转发到 Host 的另一条链路），两者指向同一个"这条路本来就不该走"。
- **修复**：对话框的第一数据源改为**本插件自己的原语**——node 半边新增 `GET /dsh-lan/fs/list?path=…` 与 `POST /dsh-lan/fs/mkdir`（`opendir`/`stat`/`mkdirSync`），返回与官方 `DirectoryListing` **完全同形**的 `{path, home, crumbs:[{name,path}], entries:[{name,path,hidden}], truncated}`（含符号链接判定、1000 条截断、`EEXIST`→`directory-exists`）。客户端 `lanFsCall()` 先打自己的路由，**404（旧 node 半边）才回退 `uiWorkspace`**——半边可以各自升级，不会互相打死。
- **门（必须记住）**：代理对 `/dsh-lan/*` 是**无条件放行**的（落地页要用），所以门做在路由里：`lanFileAccess()` = 主机自己（`isHostOnlyRequest`，即本地且未被反代盖章）**或**口令持有者（`x-dsh-lan-key` 头/`dsh-lan-key` cookie）**或** mint 出来的浏览器会话（`browserAuth.isAuthenticated`）。对没有凭据的局域网设备必须 403。
- **验证**：`npm test` **293 项全绿**（275 → 293；K3 段锁住 listing 形状/只列文件夹/面包屑/无参列 home/单段 mkdir/EEXIST/多段名拒绝/相对路径拒绝/无凭据 403/口令持有者 200，H 段锁住两条路由与"先自己、404 回退"）。真机（隔离 harness + 真 Host + 无头 Chrome）：点「添加工作区」后 `err` 为空、`crumbs=["C:\\","Users","主目录"]`、列出 home 下 12 个目录、盘符下拉识别出 C:/D:/E:/F:，且**不再有任何** `/api/directoryPicker` 流量。

### 1.5.7 — 切换开关不再先显示"未放行"；桌面端永远按"主机"处理；`/lanapi` 补上 peer

两个用户报的问题，根因分别是"未验证被当成失败"和"桌面页不是 HTTP origin"：

- **①切换开关后几秒内显示"防火墙未放行"**：`configure` 以前先清缓存、再回 `buildStatus`，而**创建防火墙规则**的 `ensureFirewallRule()` 在 `lanProxy.refresh().then(syncEnforcement)` 里、也就是**回复之后**才跑 ⇒ 那份"新鲜"探测必然先看到"没规则"；负判定又按 `10s→60s` 退避缓存，卡片要等十几秒才变绿。四项改动：
  1. `configure` 在回复前就 `ensureFirewallRule(防火墙端口)`（`netsh` 同步、亚秒级）；规则能建时探测直接命中 `plugin`，响应就是绿的。
  2. `FIREWALL_RECHECK_MIN_MS` 10s → **2s**（仍是 2/4/8/16/32/60 倍增）。
  3. 新增 `FIREWALL_SETTLE_MS = 15s` 与 status 字段 **`firewallChecking`**：开着的头 15 秒（或探测明确回答"还没问完"）里，负判定只是"未知"，卡片渲染**绿色** `firewall.checking`（`c.pending`），不再打印"未放行"。
  4. `firewallSummary` 冷路径最多等 `FIREWALL_STATUS_WAIT_MS = 1200ms`，超时就返回 `checking: true` 并在后台继续；`/dsh-lan/status` 不再被 PowerShell（实测数秒）拖住 —— 这也顺带缩短了下面②的窗口。
- **②开启局域网后，本机桌面端"敏感设置不可用"（设置里"内置插件"显示红字"插件暂时不可用。"）**：`lib/index.js` 的 `/lanapi` 重入调用 `createSharedFetchHandler("/api").fetch(request)` **少传了 peer**，而该通道的分发要读 `peer.signal` / `peer.principal` ⇒ 每一条经 `/lanapi` 的 RPC 都变成 `gateway/internal: Cannot read properties of undefined (reading 'signal')`。
  - **谁会被这条路打到**：`clientIsLocal()` 为 false 时，`installLanFetchReroute`/`wrapApi` 把 `settings.*`、`credentials.*` 等 privileged 方法改写到 `/lanapi`。
  - **桌面端为什么也会 false**：桌面窗口不是 HTTP 页面，它从 **`dsh-app://app/`** 加载（`main.js` 的 `applicationUrl`），`location.hostname` 是 `"app"` ⇒ `isLoopbackHostname()` 为 false ⇒ `localClient` 初始为 **null**，而 `clientIsLocal()` 只认 `localClient === true` 或回环 hostname。桌面壳在注入脚本前已经设了 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`（`dsh-web-frontend` 的 desktop boot），**这才是"这个页面就是主机"的权威声明**，旧代码没读它 ⇒ 启动早期（以及探测失败时一直）按"远程"处理。现在 `shellOwnsHost()` 参与 `localClient` 初值与 `clientIsLocal()`，桌面端**从第一毫秒起就是主机**：不挂 gate、不打 `dsh-lan-nonlocal`、不把 privileged 调用改写到 `/lanapi`。
  - `/lanapi` 现在传入 `connection.browserPeer`（能走到这里的请求已经过 `isLocalRequest || hasLanCredential`，与 `admit()` 给浏览器会话的 principal 一致）；没有 `browserPeer` 时才退回旧调用。
- **踩过的坑**：`ctx.remote.pluginInventory.list()` 失败时，设置里"内置插件"只显示一句"插件暂时不可用。"，真正的错误在 `result.error.message` 里 —— 直接向活着的 Host `POST /lanapi/<method>`（循环对端即可）就能读到它，这是定位这条 bug 的最快路径。
- **验证**：`npm test` **275 项全绿**（250 → 275；新增：`firewallChecking` 的两种结局、规则先于回复创建、2s 退避、1200ms 冷等待、卡片绿色 `checking`、`ownsHost` 真源跑真实客户端切片、`/lanapi` 必须带 peer 与 `/api` 前缀改写）。真机（隔离 harness + 真 Host）：`/lanapi/pluginInventory/list`、`/lanapi/settings/describe` 从 `gateway/internal` 变为 `ok:true`；开开关的响应 520ms 且 `{ok:false, checking:true}`。

### 1.4.7 — 移动端小鲸鱼嵌入顶栏：靠左、标题居中，与右侧边栏按钮同尺寸

- **需求**：移动端（竖屏）左上角那个**浮动**小鲸鱼按钮改成**嵌进顶栏**，与顶栏右侧的「展开右侧边栏」按钮**同样大小、左右对称**；标题在中间。
- **改动**：`seatWhale()` 把小鲸鱼插成 `_titleRow` 的**第一个 flex 子项**（官方右侧按钮在 `_headerCorner`，即该行的最后一个子项），浮动、拖拽与位置持久化（`dsh-lan-whale-pos`）**整体删除**；`_titleRow` 上打 `data-dsh-lan-whale="1"` 作为这些规则的唯一作用域。
- **样式契约（三条，缺一不可）**：
  1. `#dshLanWhale` 做成官方那颗 ghost 按钮的等价物：`width/height:28px`、`background:0 0`、`border:none`、`box-shadow:none`、`color:var(--dsw-alias-label-secondary)`（= 官方按钮的实测色 `rgb(97,102,107)`），配 `margin-left:-12px` 让**图标**（而非按钮盒）落在官方那 4px gutter 上。
  2. `[data-dsh-lan-whale="1"] > :has(> [class$="_titleCluster"]){flex:1 1 auto}` —— **标题簇不是该行的 flex 子项**，官方把它包在一个无类名的 div 里，`._titleCluster{flex:1}` 只在这个包装里生长。不把**包装**撑起来，行内就永远没有富余空间，`margin-left:auto` 会解析成 0（表现为"标题不居中、右侧控件也不贴边"）。
  3. `[data-dsh-lan-whale="1"] [class$="_titleCluster"]{justify-content:center}` —— 撑开之后簇的内容仍从左边缘排，标题还是贴着鲸鱼；居中要显式声明。
- **两个踩过的坑（都别再犯）**：
  - **`[class$="_titleRow"]` 会匹配到小鲸鱼自己**：它的 id 是 `dshLanWhale`，也以 `Whale` 结尾 —— 用它当作用域时，按钮被当成"标题行"，继承了给簇写的 `margin-left:auto`，直接飘到行中间。**所有规则只准用 marker 属性作用域。**
  - **`\\\"` 是双重转义**：在双引号 JS 字符串里要写 `\"`，写成 `\\\"` 会让选择器编译成 `[data-dsh-lan-whale="\"1\""]` 而**匹配不到任何东西**（静默失效）。回归断言里两条都锁住了（`H no whale rule is scoped by the title row class`、`H the marker rules are not double-escaped`）。
- **验证**：`npm test` **209 项全绿**（206 → 209）。真机几何用"最小 harness"量（把官方相关 CSS + 本仓库 `ADAPT_CSS` 注入一个空白页，按官方结构搭出 title row/cluster/corner）：390px 视口下 鲸鱼 `x=8`、标题簇中心 `189`（视口中心 195）、右侧按钮右缘距边 `12` —— 左/中/右成立，两个按钮同为 28×28、同色、无底色/边框/投影。

### 1.4.6 — 设置卡片里"正在生效…"改用绿色

- **需求**：切换「局域网访问」开关时，卡片里那行"正在生效：正在重新绑定监听，约 2 秒后自动刷新…"要用**绿色**。
- **改动**：新增 `.dshLan_pending{color:var(--dsw-alias-state-success-primary,#2ea043)}`（`--dsw-alias-state-success-primary` 是官方设计令牌里语义正确的绿，与 `.dshLan_badge` 已在用的 `--dsw-alias-success-fg` 属同一套色系；`#2ea043` 只是与 badge 一致的兜底），并给 `status.applying` 那行挂上 `c.pending`。
- **为什么不只是"顺眼"**：这行原来与其它状态行一样是 `--dsw-alias-label-secondary`（灰），而它描述的是**正常推进中的过程**；1.4.4 那次"切换时闪红字 `Failed to fetch`"正是同一个 2 秒窗口被读成错误。用绿色把"正在生效"与"出错/警告"（红）在视觉上分开，是那条修复的延续。
- **验证**：`npm test` **198 项全绿**（195 → 198：新增 3 项静态断言 —— `status.applying` 必须挂 `c.pending`、`.dshLan_pending` 必须用官方 success 令牌、且**不许**用 `state-error`）。

### 1.4.5 — 局域网开着时桌面端起不来（口令闸短路了桌面壳的启动握手）

- **现象**（用户实机）：早上启动桌面版直接失败，弹出"DeepSeek Harness is unavailable"，`logs\crash-*-host.log` 里是 `phase: startup` + `Error: Desktop Host authentication failed`（`main.js` 的 `authenticateWebHost`）；点对话框第三个按钮"禁用第三方插件，备份 profile 补丁并重启"之后就能进。⇒ 看起来像第三方插件的锅，实际是**本插件 1.4.1 起就有的 bug**：那个恢复按钮顺手把 profile 补丁里的 LAN 受管块一起删了，等于替用户把"局域网访问"关掉。
- **机制**（详见 §3.6 那条契约）：`authenticateWebHost()` 要求 `status === 303 && set-cookie !== null`，而 `patchedAuthorize` 的 `if (local) return true` 让壳拿到 `200 + text/html`。**只有 `boundToAllInterfaces(ctx)` 为真（=局域网开）时才装这道闸**，所以触发条件正是"局域网开着的时候重启桌面端"；而受管块持久化在 profile 补丁里 ⇒ **每次**启动都失败，用户只能靠那个恢复按钮进应用，进去后再开 LAN 又坏（表现为反复发作、像插件坏了）。
- **复现与定位手法（值得复用）**：`app.asar` 里 `lib/main.js` 是压缩过的，但**栈行号是准的**（`%20` 是路径里的空格，不是线索缺失）。用 asar 头（`pickle`：16 字节 + JSON 头长度在偏移 12）写出一个只读抽取器即可逐行读官方源码；判定关键在 `main.js:7422 authenticateWebHost` / `7551`（`EADDRINUSE` 会走另一套按钮 ⇒ 崩溃现场就能排除"端口被占"）。真机复现靠"假 main 进程"：直接 `spawn(DeepSeek Harness.exe, ["--expose-internals", <app.asar 内 dsh-desktop-host 入口>, <runtimeDir>, <profileDir>, <primary-runtime>, <pnpm.mjs>, <runtime/bin>])` 并带 `ELECTRON_RUN_AS_NODE=1` + `DSH_HOME=<临时目录>`，从 IPC 收 `{type:"ready",url}` 后对它做 `fetch(url,{redirect:"manual"})`，就能在**不碰用户 profile** 的前提下看到那个 303/200（端口用 19387 之外的值，否则与在跑的实例 EADDRINUSE）。
- **修复**：本机分支里，`GET /` 且 `requestUrl.searchParams.has("token")` 时委派 `origAuthorizeIndex.call(browserAuth, req, res)`；其余本机请求照旧 `return true`。顺带把 `ensureFencePatched` 的重入护栏改成同时比 `connection` 与 `browserAuth`（见 §3.6 末尾）。**口令闸 `requestRejection` 未改一行。**
- **验证**：`npm test` **195 项全绿**（164 → 195，新增 N 段 31 项：主机 4 种对端 × 6 种 Host 的令牌交换都必须委派、无令牌/非根路径/非 GET 不委派、空与重复 `?token=` 委派、局域网对端带 token 仍 403、重复 apply 不叠加委派）+ 真机复现（局域网开、`host: 0.0.0.0`）令牌交换 303 + `set-cookie`，且同一进程内 `GET /` 200、伪造 token 401、落地页 200 全部符合预期。

### 1.4.4 — 不再误弹输入法；防火墙规则名不再乱码；切换开关不再闪红字

三个用户报的问题，其中两个是**同一个"输入框其实是 contenteditable"的认知错误**的余波：

- **①点小鲸鱼 / 点会话行会弹出输入法**：键盘守卫要求 `TEXTAREA || INPUT` 且落在 `[class$="_composerSeat"]` 里，而输入框是 Lexical 的 **contenteditable** ⇒ 守卫**从未生效**，官方在挂载、切会话、以及浮层关闭后"把键盘交还 `SessionInput.focus()`"时就把输入法弹出来了。修复见 §3.4：与 Enter 共用 `isComposerField()`，用「3 秒内算正在输入」的窗口决定是否允许聚焦（`pointerdown`/`keydown`/`input` 续期），同时 patch `HTMLElement.prototype.focus` 并用 `focusin` 兜底；顺手修掉两个连带问题——**口令门在手机上不再自动聚焦**（每次 gate 重挂都会弹键盘），**插件自己的输入框不再被 Enter 处理器拦截**（`dshLan_input` 也以 `_input` 结尾，旧选择器会把它当输入框，导致口令框里按 Enter 无效）。
- **②设置卡片乱码 `(������ѧУ�˻�)`**：PowerShell 的 stdout 走控制台代码页（中文系统 GBK），却按 UTF-8 解码。脚本加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，并给规则名加 `sanitizeFirewallNote()` 兜底；`statusParts` 现在只拼非空片段（不会再出现孤零零的 `· `）。
- **③切换开关时 2 秒红字 `Failed to fetch`**：端口重绑期间的正常失败被当成错误渲染。`fetchStatus()` 在 `REBIND_GRACE_MS` 窗口内（`configure` 成功后打标、`applying: true` 续期）静默重试并保留上一份数据，只有超窗失败才报错。
- **验证**：`npm test` **164 项全绿**（140 → 164）。真机手感（iOS/Android 的 return 键、中文输入法候选）仍需用户在手机上确认。

### 1.4.3 — 移动端 Enter 真的换行；防火墙状态不再"明明放行了还说没放行"

两个用户报的问题，根因都不在"判定逻辑写反"，而在**换了个对象**：

- **①移动端 Enter 毫无反应**：DSH 的输入框是 **Lexical 富文本编辑器**（不是 textarea），官方按键表是"Plain Enter 发送 / Shift+Enter 换行"。插件从 v51 起用 `document.execCommand("insertText","\n")` 插换行 —— Lexical 完全不理会这种命令，而事件同时被 `preventDefault()` 吞掉，于是按键**什么也不做**（比"误发送"更难查，因为控制台一声不响）。
  - 修复：吞掉普通 Enter 后，**对同一目标补发一个 `shiftKey: true` 的 keydown**，让 App 自己那条换行绑定干活；再用「`<br>` 数 ×1000 + 子元素数」在 60ms 后确认是否真的插入了，否则依次退回 `beforeinput{inputType:"insertLineBreak"}` 与 `execCommand("insertLineBreak")`。合成事件打 `__dshLanLineBreak` 标记防止自我循环；IME 组词（`isComposing` / `keyCode 229`）一律放行，否则选不了词。
  - 断言（打桩 DOM 跑真实 `onKeydownCapture`）：普通 Enter 被吞且补发 Shift+Enter、组词与 229 放行、Shift+Enter 不动、外来区域不动、合成事件不循环、两级兜底按序触发。
- **②防火墙"明明放行了仍显示未放行（需管理员权限）"**：非管理员运行时 netsh 建不了 `dsh-lan-tool (auto)`，Windows 会弹一次「是否允许访问」并由**系统自己**建一条**程序级**规则（`LocalPort=Any`）——按名字查我们那条规则永远查不到它，而旧代码只查自己的规则，于是卡片一直报"未放行"。旧实现还把结论**缓存 600 秒**，即便再查也要等 10 分钟。
  - 修复：判定来源扩成四种（见 §3.7）——自己的规则 / **系统弹窗建的规则**（PowerShell 结构化查询 + **程序路径必须匹配**）/ **已有非本机设备成功连入过**（`remotePeerSeenAt`，最便宜也最硬）/ 无防火墙工具。OS 查询放后台、stale-while-revalidate，未放行时按 10s→60s 退避重查 ⇒ 用户点完系统弹窗的「允许」，卡片几秒到几十秒**自己变绿**，不需要管理员权限、不需要重启。`configure` 切开关会清缓存重查。
  - 顺带：开关打开而 netsh 失败时**打一行日志**说明"系统会弹一次窗、卡片会自己认领"，不再静默。
  - 断言（打桩 netsh + PowerShell 输出）：自己的规则 → `plugin`；同程序的系统规则 → `system`；**别的程序的 Any 端口规则不算**；端口列表/区间命中；UDP 不命中；已有局域网设备连入 → `observed`。
- **验证**：`npm test` **140 项全绿**（116 → 140）。移动端那条只做到"按键语义正确"，**真机手感（iOS/Android 键盘的 return 键、中文输入法）仍需用户在手机上确认**——本地没有触屏设备，无头 Chrome 也进不到有会话的输入框。

### 1.4.2 — "装了没重启"的混合版本不再变成口令页 + 拿不准就不挂 gate

- **现象**（用户实机，同样是桌面端）：装好 1.4.1、**没有重启应用**就直接启用，口令页**又**盖在 DSH 界面之上。
- **机制**（这一条比修 bug 本身更重要）：**同一个应用进程内重装/升级插件，node 半边不会换成新代码**（客户端半边会跟着文件热更新）⇒ 1.4.1 的客户端去问服务端"我是不是本机"，而旧服务端**根本不返回 `local` 字段**；1.4.1 的客户端在这种情况下退回按 `location.hostname` 猜 → 桌面窗口的 hostname 不是它认识的回环名 → 挂 gate。**是"一半新一半旧"，不是新版本没修好。**
- **修复**：
  - 客户端**拿不准就不挂 gate**：新增 `shouldGate()`，只有服务端**明确**回答 `local === false` 才允许挂；"没回答 / 探测失败 / 旧服务端没有该字段"一律视为未知→不挂（`mountGate()` 自身也要求 `shouldGate()`，3 处 403 兜底路径与启动路径全部改用它）。gate 只是体验层，安全边界始终在服务端。
  - **桥接旧服务端**：`local` 缺失但 Host 版 `loopback === true` 时按本机处理（旧服务端的 Host 判定对 `[::1]` 是能过的，因为它会剥方括号）。
  - **版本握手**：node 半边新增 `PLUGIN_VERSION`（与 package.json 同步）并在 `/dsh-lan/status` 返回 `version`；客户端请求带 `x-dsh-lan-client` 头。不一致时：客户端设置卡片显示"插件已更新到 X，但服务端仍在运行 Y，请完全退出并重启桌面版"、控制台 warn、gate 若已挂出则直接把这句话作为提示；服务端也 log 一行。
  - **诊断留痕**：`/dsh-lan/status`（仅本机可见）新增 `seenHosts`——最近 12 组 `host · peer → 是否判为本机`，下次"为什么这台机器被挡"直接读出来，不用再猜桌面窗口用的是哪个名字。
  - **README（中/英）**：安装步骤写明"装完/更新后**完全退出并重启**桌面版"。
- **验证**：`npm test` **116 项全绿**（新增：旧服务端无 `local`、无任何 locality 字段、探测失败三种"未知"情形均不挂 gate；`loopback: true` 桥接；版本不一致会被点名；status 带 `version`/`seenHosts` 且局域网设备拿不到 `seenHosts`；两个 `PLUGIN_VERSION` 与 package.json 一致）。

### 1.4.1 — 桌面端被自己的口令门挡住（"本机永远不需要口令"）

- **现象**（用户实机，装的是 npm 上的 1.4.0）：桌面端装好插件并启用后**直接弹出口令页**，且因为还没设口令，输入框被禁用 ⇒ 桌面端完全不可用，只能卸载插件。
- **两个半边同时判错，而它们的判定依据都不是"对端"**：
  - **服务端**：`isLocalRequest = isLoopback(Host 头) && isLoopbackSocket(对端)` —— 要求 Host 头是 `127.0.0.1`/`localhost`/`::1` **之一**。桌面端用 `[::1]`（浏览器把 IPv6 字面量报成**带方括号**的形式）、机器名或本机局域网地址访问自己的 GUI 时，Host 白名单不命中 ⇒ 被当成局域网设备 ⇒ `GET /` 302 到落地页。
  - **客户端**：`isLoopback()` 只看 `window.location.hostname`，而且名单里同样没有 `[::1]`（带方括号）⇒ 挂了全屏口令层 `#dshLanGate`，又因为 `/dsh-lan/status` 报 `passwordSet !== true` 把输入框与按钮 `disabled` —— 这正好解释了用户看到的"弹出且不可输入"（落地页 `landing.html` 从不永久禁用输入框，所以**看到的一定是客户端那层 gate**）。
- **修复**：
  - 服务端 `isLocalRequest(req)` 改为**只看 TCP 对端**：回环地址，或 `localHostAddresses()`（`os.networkInterfaces()` 里本机所有地址，含 IPv6 与 `%zone`，10 秒 TTL 缓存）。Host 头不再参与放行判定（`isLoopback()` 退化为 `/dsh-lan/status.loopback` 的展示字段）。
  - 客户端删掉 `isLoopback()`，改为 `detectLocalClient()` 问服务端（`/dsh-lan/status` 的 `local`，缓存答案；hostname 只作首帧兜底，且服务端说"本机"时会 `removeGate()` 自愈）；gate/posture/卡片/锁定按钮/`/lanapi` 改写全部改用它。
  - `/dsh-lan/status` 新增 `local`；主机专属细节（`patchFile`/`profile`/`lanUrls`/防火墙状态/`platform`/`enforcement`）改为只发给 `local === true`，局域网设备仍能看到 `passwordSet`/`warning`。
  - 落地页新增：服务端说 `local === true` 时直接 `land()` 进 GUI（本机不该看口令页）；`passwordSet !== true` 时明说"主机尚未设置访问口令，暂时无法从局域网进入"并禁用表单，而不是给一个永远填不对的框。
  - 口令门拒绝时打一行去重日志（`password gate: … peer=… host=…`），下次这类事故不再静默。
- **取舍（写在明处）**：本机浏览器经 DNS rebinding 域名访问时也会被判为"本机"（与 DSH 官方 `isTrustedApiRequest` 对 loopback 的信任一致）。要更严就会回到"主机名白名单"，而那正是这次的病根——**主机可用性优先**。局域网设备不受影响：对端地址由 TCP 保证，伪造 `Host: 127.0.0.1` 依旧 403。
- **验证**（离线，`lib/index.js` 直接跑 + 打桩 `node:child_process`）：**105 项全绿**。矩阵覆盖：本机 4 种对端（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`/本机局域网地址）× 6 种 Host（`127.0.0.1`/`localhost`/`[::1]`/机器名/局域网地址/`evil.example.com`）**一律放行**，无 Host 头也放行；局域网对端（`203.0.113.7`）伪造 `Host: 127.0.0.1` 仍 403、裸 `/` 仍 302 到落地页；未设口令时乱造 key/cookie 也进不来；设口令后正确 key/cookie 才放行、错口令 `ok:false`；`configure` 只有本机可写（写出的补丁含受管块）；`/lanapi` 对无 key 的局域网设备 403；客户端侧用真实源码动态跑（`[::1]`/`0.0.0.0`/`::ffff:127.0.0.1` 算回环、局域网地址与机器名不算；服务端说本机则 gate 自愈，探测失败不缓存且回环页面照样不放 gate）。

### 1.4.0 — 按《重构需求与重构方案》重构：改名、去安装脚本、开关进设置、五键覆盖、升级迁移

对应需求 R1–R4 与坑 K1–K5（方案文档：`重构需求与重构方案.md`）：

- **R1 改名**：`dsh-LAN` → **`dsh-lan-tool`**（包名、仓库名、`insert.name`/`insert.id`、`const name`、客户端 bundle 的 `id:` 与 `data-plugin`、防火墙规则名 `dsh-lan-tool (auto)`）。旧名含大写字母，被 `dsh-plugin-manager` 的 `PACKAGE_NAME` 正则与 npm 双重拒绝；`dsh-lan` / `dsh-lan-access` 已被他人在 npm 占用，故取 `dsh-lan-tool`。
  - **本轮新增的改名点（原方案漏了）**：`lib/client.js` 第 2 行 `window.__ModuleLoader__.load({ id })` 的 id **必须等于包名**（`arrive()` 要求 `factories.has(row.id)`），漏改 ⇒ 半边不加载；`tag.dataset.plugin` 也必须等于包名（`removeOwnedStyles` 按它删样式）。
  - 行 `id` 从 `dsh-lan` 改成 `dsh-lan-tool` 是**故意不复用旧 id**：同名 id 的旧行会与 bundle 新行**合并成一个 entry 槽位**且 profile 层后写获胜，那样旧行里的 `name: 'dsh-LAN'`（包已不存在）会让插件的行整个 import 失败 ⇒ 迁移都跑不起来。用新 id 则旧行是独立（会失败）的条目，插件照常加载并在 apply 时把它剥掉。
- **R2 必须保留的东西**：口令门（`patchedRejection` + `patchedAuthorize`）、`/dsh-lan/mint` 的 token→cookie 静默兑换、`x-dsh-lan-key`、`lib/landing.html`、`unlockAttempts` 限流 —— 这些是"凭 ip+端口、凭密码、无需带 token"的实现本体。
- **R3 去安装脚本**：`install.ps1` / `install.sh` / `uninstall.ps1` / `uninstall.sh` 全删；`cordis.patch.yml` 只留一条 insert 行并**去掉 `webserver` 覆盖**（选项 A：不写 = 官方 `127.0.0.1` + gzip = 关）。开关写/删活动 profile 补丁里的受管块，热重载即刻重新 bind。
- **R4 不问口令**：安装过程零密码交互；口令只在设置卡片里设置。
- **K1**：profile 与补丁路径改从 `profileContext`（`name` + `patchPath`）解析，`config.profile` 退化为兜底。
- **K2**：唯一写入者 `setLanBlock()` 固定五键，三键取值抄当前 `ctx.webServer.config`；开关来回切三次后补丁里始终只有一条 `- id: webserver` 且 `compression: gzip` 在。
- **K3**：`exports.inject` 删掉 `settingsScope`，`lanHostMode()` 整体删除（0.2.0 无该服务，且 `persistence` 是构造期一次性常量；DSH 对非 loopback 页面刻意不给设置作用域）。卡片文案改为"局域网可聊天/切换模型与模式；设置项请在主机上修改"。
- **K5**：卡片在无口令时**拒绝打开开关**并把焦点移到口令框；`buildStatus().warning = "no-password"` 让"已开但无口令"这一状态显式标红（服务端仍允许这种组合，因为它是"先开开关再设口令"的中间态，且此时局域网本来也进不来）。
- **§4.8 一次性迁移**：剥除旧 install/toggle 块（profile 层永远压过 bundle 层，留着就是"显示关、实际开"）、删除旧防火墙规则名（改名后没有任何代码能碰到它们，会永久放行端口）、`dsh-lan.json` 里落 `legacyCleanupDone` 标记；**口令文件名保持不变**以免丢口令；迁移后一律是"关"，不翻转语义。
- **`/lanapi` 暂留**：0.2.0 已无按方法的 loopback 专属层，它与客户端 `/api`→`/lanapi` 改写属可选简化项，删除需要一次端到端验证，本轮未做（用户要求不在本机安装），已在上文登记。
- **卸载安全（本轮新增，方案没提）**：受管块留在 profile 补丁里而包被删掉 = 端口照样绑 `0.0.0.0`、口令门消失、防火墙规则还在。故加了 `scheduleDisposalCleanup()`：dispose 后 8 秒内若本行没有重新 apply（即不是热重载），就删掉受管块并撤防火墙规则；失败方向只会是"回到关"（详见 §3.5.1）。
- **验证**（离线，未在本机安装）：node 半边自测 72 项（迁移/开关五键/门禁/`[]` 占位/路由/释放/停用清理与热重载取消清理）+ 静态一致性 43 项（名字四处一致、inject 双向、补丁无 `webserver` 行、脚本已删）全绿；`node --check lib/client.js` 通过。
- **发布自动化（本轮新增）**：`release.yml` 多了 `publish-npm`——push `v*` tag 就自动发一次 npm，走 OIDC trusted publishing、**仓库里没有任何 npm secret**；三道守卫（包名必须是 `dsh-lan-tool` / `v<version>` 必须等于 tag / registry 上已有同版本则跳过）保证不会静默发错或重复发。**已在 `v1.4.0` 实测跑通**（run #9：`release` 与 `publish-npm` 两个 job 全绿，npm 侧 `latest=1.4.0`、tarball 恰为 `files` 里那 7 个文件、自动带 provenance 签名）。首次发布必须先本机手工 bootstrap 一次、非 TTY 下怎么过 2FA、以及"npm 会把 OIDC 失败吞进 verbose 日志"这些排障要点，都在 §5.1。

### 1.3.8 — 移动端「标准模式」等头部动作改为靠左紧跟「轨迹」，间距=官方 tabs gap

- 现象：移动端标题栏下「对话 / 轨迹」那一行里，「标准模式」被推到最右、**超出屏幕边缘**。
- 机制：v67 起把标题行里的 `_headerActions`（agent-preset 模式名 + 后台任务徽标）搬进 `_tabs` 当子项，但给的规则是 `margin-left:auto` —— 那是明确的「贴右边缘」指令，于是超出屏幕。
- 修复（v84）：
  - **去掉 `margin-left:auto`**。`_headerActions` 现在是 `_tabs` 这个 flex 容器的子项，而官方 `.wSkVaW_tabs{gap:36px}` 的 36px **正是 对话/轨迹 之间的间距**，所以它自然紧随「轨迹」且间距天然一致 —— 不需要自己塞一个左边距（塞 36px 也能对，但会与未来官方 gap 变更脱钩）。
  - `gap:6px → gap:36px`：让「标准模式」与「子代理」徽标之间的间距也等于 对话/轨迹 的间距（需求里的"一致"）。
  - 补 `min-width:0`，让过长的预设名走省略号而不是把整行撑出屏幕。
  - `_tabs` 的 `margin-right:-58px` 一并撤销：那是 v67 为了让「贴右边缘」的动作正好压在边缘而加的（官方 header 右内边距 28px），**改为靠左锚定后它只会造成溢出**。现改回 0，保留官方 28px 内边距。
- 实测（在页面里按官方真实类名/结构搭出 header，390/360/320 三宽度）：
  - `gap(对话,轨迹) = 36px`，`gap(轨迹,标准模式) = 36px` —— **完全一致**；
  - `overflowRight` 全为负值或 0（不再超出屏幕）；`_tabs` 计算值 `gap:36px / padding-left:8px / margin-right:0`；控制台 0 错误。
- 备注：无头新会话停在工作区选择页，拿不到真实会话头部（DSH 不提供会话深链），所以这是按官方真实类名与结构做的定向断言。

### 1.3.7 — 三点「更多操作」（下载 session 日志）改为按「非本机」隐藏

- 用户反馈：1.3.6 之后移动端**仍能看到**右上角那个三点按钮，点开是「下载 session 日志」。
- 它是 `@deepseek-ai/dsh-session-log-export` 的 `SessionLogDownloadHeaderAction`：`Menu` 的 anchor 是 `nL4_yW_moreButton`（`aria-haspopup="menu"`、`aria-label` 取自 `header.more`「更多操作」、图标 `IconEllipsisOutline16`）。源码第 274 行确认它注册进 `conversation.session.header.utilities` —— **正是 `_headerUtilities` 内部**。
- 所以 1.3.6 之前那条 `[class$="_headerUtilities"]{display:none}` 本来就能藏它（该规则自 v47–v62 的 `819ecdd` 起一直在，且实测确认已随 bundle 下发）。用户仍能看到 ⇒ **实机当时没进入移动端适配状态**：`isMobilePortrait()` 要求竖屏 + 粗指针 + 宽 <1100，横屏/平板/更宽视口都不生效。
- 修复：把这条也做进「非本机」样式表（`dsh-lan-tool/nonlocal-header.css`），**不再依赖移动端适配状态**：
  - `body.dsh-lan-nonlocal [class$="_headerUtilities"] [class$="_moreButton"]`（主判据，实测全局只匹配这 1 个元素）；
  - 再加一条按**角色**兜底的 `... [class$="_trigger"]:has(svg):where([aria-haspopup="menu"])`，防模块哈希前缀变化。
  - 理由：局域网浏览器把 session 日志下到「错误的机器磁盘」上本来就没意义。
- 实测（构造官方真实类名与结构）：非本机下移动 390 **与桌面 1280** 均 `display:none`，启动器同时隐藏，无关控件不受影响，控制台 0 错误。
- 教训：**"父容器被 display:none" 不等于"子元素一定看不见"要分开断言**；更要紧的是——依赖 `mobileAdapt` 的规则只在那一整套状态成立时生效，凡是"移动端看不到 X"的需求，先确认实机是否真的进入了该状态，必要时改挂到与视口无关的判定上。

### 1.3.6 — 非本机隐藏主机应用启动器；移动端隐藏 session 日志；底部统计居中

- **需求 1（非本机隐藏右上角「文件资源管理器 / VS Code / Git Bash」下拉框）**：
  - 那个下拉框是 `@deepseek-ai/dsh-client-ui-open-in-app`，类名 `CAgGvG_split`，注册在**与 session 日志同一个插槽** `conversation.session.header.utilities`（即 `_headerUtilities` 容器）。
  - 判定来源：`/dsh-lan/status` 的 `loopback` 字段（服务端 `isLoopback(req)`，按 **Host 头**算，正好等价于「这个页面是不是从 127.0.0.1 打开的」）。`syncNonLocalPosture()` 拿到后给 `<body>` 加 `dsh-lan-nonlocal`。
  - **坑（本次踩到）**：这条规则**不能**放进 `mobileAdapt` 的 CSS —— 那段样式表只在竖屏手机模式下注入（`isMobilePortrait()` 为真），而需求恰恰是桌面局域网场景。实测 1280px 下 `mobile-adapt.css` 根本不存在（`tagPresent:false`），规则写了也永远不生效。改为在 `markNonLocalPosture()` 里注入独立样式表 `dsh-lan-tool/nonlocal-header.css`。
  - 选择器用 `body.dsh-lan-nonlocal [class$="_headerUtilities"] [class$="_split"]`：官方是 `.CAgGvG_split{display:inline-flex}`，靠多一个 `body.` 类提高特异性压过它（在 `mobileAdapt` 之后注入、但顺序不可靠，别只靠顺序）。
- **需求 2（移动端隐藏 session 日志下载）**：本来就已满足——`web shell` 的 `_headerUtilities{display:none}` 规则在竖屏下隐藏整个 utilities 簇，实测该容器宽为 0，里面的 session 日志按钮（`nL4_yW_moreButton`）一并消失。**桌面端不受影响，仍保留**。
- **需求 3（移动端底部「N 轮 M 步」居中）**：官方 `StatsPills` 的根类 `bOPqQW_root` 本来就是 `justify-content:center`（flex 行），是我们在 v56 把它覆盖成 `text-align:left` 才变左对齐。v82 改回 `text-align:center`。实测移动端计算值 `text-align:center`、`justify-content:center`、字号 10px、内边距 0，且内容盒居中；桌面端不受影响（仍是官方 13px / 32px 内边距）。
- **类名方向提醒（重要）**：官方插件 bundle 的 CSS Module 类名是**哈希在前**（`CAgGvG_split`、`nL4_yW_moreButton`、`uV2eYG_headerUtilities`），所以 `[class$="_split"]` 这类后缀选择器能匹配；而 **web shell 自己**的 Vite 构建是 `_split_17p4l_17`（哈希在后），**后缀选择器匹配不到它**。写探针时要用官方 bundle 的类名，否则会测到 shell 自己的同名元素而得出错误结论（本次先踩了一次）。

### 1.3.5 — 移动端 composer：模型按钮与上下文圆环之间留出真实间隙

- 现象：1.3.4 后模型名仍然「过长」，与上下文圆环挤在一起。
- 关键纠正：**最左的障碍物是上下文圆环，不是发送键**。圆环是官方 28px 的 `ContextMeter`（`JObwrW_root`），绝对定位 `right:52px; translateY(-50%)`，因此它在发送键**左侧 12px**（360px 下：圆环左缘 280、发送键左缘 292）。1.3.4 按发送键对齐（预约 140px），结果模型按钮反而压过圆环 —— 这就是用户看到的「过长」。
- 另一坑：模型触发器的右缘还含图标与箭头（约 30px），所以「`gapModelToRing`」这种按触发器右缘算的间隙会高估真实视觉间隙。**必须量「箭头右缘 → 圆环左缘」**。
- 修复（v81）：预约值由 140px 改为 `calc(100cqw - 175px)`。标定实测（箭头→圆环）：160px → 0（即用户报的重叠）、172px → 12、**175px → 15**、185px → 25。
- 取舍：圆环间隙与完整模型名在手机宽度下**不可兼得**（实测任何能给圆环正间隙的预约值都会截断真实模型名）。按用户要求以圆环间隙优先，390px 下模型名显示约 107/137px（"DeepSeek V4.1 Flash (C…"）。
- 复现注意：无头会话里 `ContextMeter` 常因没有上下文占用数据而**不渲染**（`[class$="_root"]:has([class$="_track"])` 取不到）。可注入一个同规格探针元素（28px、`absolute right:52px`、`box-sizing:border-box`）来量间隙——但注意后注入的 `<style>` 若与外层规则同特异性会被外层覆盖，别用它去「改」样式，只用它**看**几何。

### 1.3.4 — 移动端 composer：长模型名不再压住上下文圆环/发送按钮

- 现象：模型名较长时，模型按钮（及底部圆环、发送键）互相重叠。
- 成因链：v79 为了「同排」把行改成 `flex-wrap:nowrap` + `justify-content:flex-start` 后，行内**不再换行**；官方原布局靠换行给模型那行腾出整行宽度，同排后模型按钮只能与发送键争同一行空间，于是被推到发送键底下（实测 360px：模型右缘 326、发送左缘 292，重叠 34px）。`_trailing` 上的 `overflow:hidden` 只能裁内容，裁不掉容器自身压过去的框。
- 修复（v80）：给模型触发器加硬上限 `max-width:calc(100cqw - 140px)`。
  - 必须用 **`cqw` 而不是百分比**：`_row` 是 `container-type:inline-size`，此处百分比 `max-width` 实测**完全不生效**（360px 下容器仍是 239px、照旧压住发送键），`cqw` 才是可靠句柄。
  - **140px 是扫描出来的**，不是猜的。390px 下到发送键的间隙：160px→34（裁真实名字 137→122）、150px→24（也裁）、**140px→19 真实 / 14 长名（真实名不裁）**、130px→4、120px→−6（重叠）。窄屏（360/320）下长名字必然省略——这是取舍，发送键优先。
- 实测：390/360/320 三宽度下长名与真实名均**不再重叠**（间隙稳定 14px）；390px 下真实模型名完全不裁；控制台 0 错误。

### 1.3.3 — 移动端 composer：权限/模型按钮与附件按钮同排（原为上下两行）

- 现象：竖屏手机上权限按钮与模型选择按钮上下两行，模型那行被推到右侧。
- 官方原始布局（`@deepseek-ai/dsh-client-ui-conversation` 的 `InputBar.module.css`）：`.uV2eYG_row{flex-wrap:wrap;justify-content:space-between}`、`.uV2eYG_trailing{flex:none;gap:12px;margin-left:auto}` —— 本来就是「一行放不下的流式换行」，**官方不是固定两行**。
- 根因（全部在本插件 v52 的移动端 CSS）：`_trailing{flex-basis:100%}` 强制它独占一行造成「堆叠」；它还被 `padding-left:38px` 缩进；`_row` 保持官方 `space-between`，而发送按钮已被绝对定位移出流，行内只剩 `_tools`/`_trailing` 两项，空间全被推到两者之间 → 模型按钮贴右侧。
- 修复（v79）：`_trailing` 去掉 `flex-basis`/左侧 38px 缩进（行 `column-gap:10px` 自然让它对齐到权限按钮的 38px 处）、`margin-left:0` 抵消官方 `margin-left:auto`、`min-width:0`+`overflow:hidden` 让长标签省略；`_row` 改 `justify-content:flex-start` + `flex-wrap:nowrap`（实测 320px 会换行，故用 nowrap 保证单行）；模型触发器与权限触发器统一 12px/24px。
- 实测（390/360/320 三种竖屏）：附件 x=24、权限 x=62、模型 x=116，三者垂直居中同排，模型标签不截断（137px 标签）、不压发送按钮（右缘 303 < 320 处发送左缘），控制台 0 错误。
- 教训：**bundle 改了不等于浏览器拿到了**。服务端缓存 bundle，需等 `client-hmr` stat 轮询重哈希；期间用 `/plugins/events` 的图帧核对 rev，且在**新文档**里验证——否则会拿着旧 CSS 的几何得出错误结论（本次就先踩了一次）。

### 1.3.1 — 「新工作区目录选择界面不断刷新，无法选目录」

- 现象：点「添加工作区」后弹窗每秒闪一次、内容为空、无法选择。
- 根因：`pickerInjected` 从 `ctx.workspaces` 取目录能力 → `TypeError: ctx.workspaces.listDirectory is not a function` → slot entry 被错误边界判退位 → 看护每秒重新注册 → 每秒重挂载。
- 修复：改为注入 `uiWorkspace`（保留 `workspaces` 旧版回退）；`exports.inject` 与 `dsh.client.inject` 双补声明；`callListDirectory()` 兜底；看护加崩溃退避（5s 内掉座 → 1s/2s/4s… 上限 60s，`connection/reset` 重置）。
- 实测：修复前 6 秒内挂载 6 次、控制台反复报错；修复后挂载 1 次、61 条目 + 3 盘符、可下钻、Esc 后可重开、控制台 0 错误。

