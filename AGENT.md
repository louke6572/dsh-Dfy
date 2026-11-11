# AGENT.md — 给 AI Agent 的傻瓜安装手册

> 目标：装好 dsh-Dfy，**用户只需要做三件事：准备 SnowLuma 安装包、重启 DSH、扫码登录 QQ**。
> 其他（下载、依赖、写 profile、启动桥接）由 Agent 完成；AstrBot / SnowLuma 本体不归 Agent 装。

## 复制给 Agent

```text
帮我安装 https://github.com/louke6572/dsh-Dfy ，按仓库里的 AGENT.md 执行，不要跳步；
先问我那 3 个问题；不要安装 AstrBot / SnowLuma / Python 依赖，也不要改 DSH profile 的依赖；
装完告诉我结果，需要我做的事直接说。
```

## 先问 3 个问题，再动手

不要一上来就 clone / install。先问清楚：

1. **你要接 QQ 吗？** 不接 → 只装 dsh-Dfy，跳过 SnowLuma / AstrBot。
2. **你要 AstrBot 的插件吗？** 不要 → 内置版；要 → 让用户自己把 AstrBot 装到独立目录，你只配置。
3. **你有 SnowLuma 安装包吗？** 没有 → 不要下载、不要镜像、不要找第三方源；建议先只用挂件 / 桌宠，或切直连用自备 OneBot。

任何一步不确定就停下来问用户，不要猜。

动手前还要在电脑上确认（不要猜）：

- DSH 是**桌面版**（有窗口和托盘）还是 `dsh web`（命令行启动、浏览器打开）；
- profile 名：看 `~/.dsh/profiles/` 下有哪些文件夹，通常是 `desktop` 或 `web`；
- DSH **现在是否在运行**：在跑就绝不能动它的 `node_modules` / `package.json`，安装前先让用户完全退出。

## 用户说「装完 DSH 打不开」时，按这个顺序救

**先别做**：不要重装 DSH、不要删整个 `~/.dsh`、不要在打不开的情况下再装一遍。

1. 让用户**完全退出** DSH（托盘也退），任务管理器里确认没有 DSH 进程。
2. 读 `~/.dsh/profiles/<profile>/package.json`，从 `dependencies` 和 `dsh.profile.bundles` 里删掉
   `dsh-dfy` 这一项，保存；或直接 `dsh plugin --profile <profile> remove dsh-dfy`。
3. 让用户重开 DSH。能起来 → 只是插件装坏了，按「方式一」重装一次。
4. 还起不来 → 把 `~/.dsh/profiles/<profile>` 整个改名备份（如 `desktop-bak`），让 DSH 重建干净 profile；
   提醒用户：该 profile 里的其它插件要重新启用，但 `~/.dsh/surfcore` 里的配置 / 记忆 / 聊天记录一条没丢。
5. 恢复后只重装 dsh-Dfy，不要再顺手装别的。

常见起因就是有人（或之前的 Agent）在 `~/.dsh/profiles`、`~/.dsh/plugins`、`~/.dsh/surfcore`
里跑过 `npm` / `pnpm` / `pip`。救的时候把这些目录当只读。

## 必须停下来交给用户的事

下面这些不要让 Agent 自己干：

- 在 `~/.dsh/profiles`、`~/.dsh/plugins`、`~/.dsh/surfcore` 里跑 `npm` / `pnpm` / `pip`；
- 改 DSH profile 的 `package.json` / `node_modules`；
- 下载 SnowLuma、安装 AstrBot / Python 依赖；
- 重启或杀掉 DSH；
- 扫码登录 QQ。

## 必须遵守

1. **推荐标准安装**：`dsh plugin --profile <profile> add github:louke6572/dsh-Dfy`。运行期数据写在
   `$DSH_HOME/surfcore/qq/`，不写插件包目录；也可以 clone 后跑 `node scripts/setup-dsh.mjs`（两种方式共用同一个数据目录）。
2. **不要自己重启/关闭 DSH**：你可能就跑在 DSH 里，重启会中断当前任务；只让用户手动退出再打开。
3. **不要替用户扫码**：二维码必须用户本人在 SnowLuma 窗口扫。
4. SnowLuma 仓库已转私有（2026-11 起不再有公开 Releases，也无法自动下载）。
   **不要尝试下载、镜像或改用第三方源**；安装包由用户自行准备（zip 或已解压目录），
   装好后用设置页「安装与维护 → 手动选择」指定目录。下载后仍要用户本人扫码，不要替用户扫。
5. 不要提交/外发 `config.json`、`~/.dsh/surfcore/`、`state/`、QQ/B站凭据。
6. **不要安装 AstrBot、不要跑 `pip` / `npm` / `pnpm` 去改 DSH 自己的 profile**。
   AstrBot 是独立 Python 服务，由用户装到独立目录（如 `%USERPROFILE%\astrbot`）；
   在 `~/.dsh/profiles`、`~/.dsh/plugins`、`~/.dsh/surfcore` 里装东西会锁住/改坏
   正在运行的 DSH，典型后果就是「装完 DSH 起不来」。详见下面「AstrBot（可选）」。

## 零、最省事：让 DSH 自己装

```powershell
dsh plugin --profile <profile> add github:louke6572/dsh-Dfy
```

装完只要让用户**完全退出 DSH 再打开**。首次启动自动建数据目录、生成初始配置；
旧 clone 安装留在仓库根的数据会被**复制**（不删除）到 `$DSH_HOME/surfcore/qq/`。
QQ 仍需要 SnowLuma，但仓库已转私有、不再能自动下载：让用户自己准备安装包，
解压后在设置页「维护 → SnowLuma → 手动选择」指定目录（或切直连模式用自备 OneBot）。

> 这里的「自己装」只指 **dsh-Dfy 插件本身**。不要顺手把 AstrBot、Python 依赖、
> 其它系统级软件也装进 DSH profile。

## 零·B、AstrBot（可选）：不要让 Agent 在 DSH 目录里装

AstrBot 不是 DSH 插件、不是 npm 包，是独立 Python 服务。只有用户明确要「AstrBot 版」
（需要它的插件生态，如表情包）才处理；否则直接建议用默认内置版。

必须按这个顺序，且由用户/在独立目录完成：

1. 用户按 [astrbot.app](https://astrbot.app/) 官方说明，把 AstrBot 装到**独立目录**
   （如 `%USERPROFILE%\astrbot`）+ 独立 Python 环境，跑一次 `astrbot init` 并启动。
2. 你只在 dsh-Dfy 设置页「维护 → AstrBot」里填目录 / exe / WebUI 端口（默认 6185），
   点启动；不要自己去 `pip install`。
3. 让 dsh-Dfy 自动装 `dsh_bridge`（或让用户在 AstrBot 面板安装并启用），provider 指向 DSH。
4. 让用户切到 AstrBot 版、重启 SnowLuma，再跑「诊断体检」。

绝对不要：

- 在 `~/.dsh/profiles`、`~/.dsh/plugins`、`~/.dsh/surfcore` 里 clone / `pip install` / `npm install`；
- 改 DSH profile 的 `package.json` 或 `node_modules` 来「顺便装 AstrBot」；
- 为了生效自己去重启/杀 DSH；
- 把 AstrBot 目录配到上面这些 DSH 目录里（插件会拒绝拉起并提示换独立目录）。

如果用户说「你帮我装 AstrBot」，正确回答是：**需要用户本人用官方安装器装到独立目录**，
你可以在装完后帮他填设置、装 `dsh_bridge`、跑体检。

## 一、首选：一条命令装完

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/louke6572/dsh-Dfy/main/scripts/bootstrap.ps1 | iex"
```

脚本会依次完成：

1. 检查 Node ≥ 22.13 与 DSH 是否就绪
2. 下载/更新仓库到 `%USERPROFILE%\dsh-Dfy`
3. `npm install`（失败自动换国内镜像）
4. `node scripts/setup-dsh.mjs`（自动识别 profile，写 bundle / 预设 / MCP / 生成 config.json）
5. `node scripts/install-snowluma.mjs --no-launch`（只检测；仓库已转私有，不会下载）

**验收**：必需步骤（下载/依赖/写 profile）失败会打印 `[!!]` 并以**非 0** 退出码结束；
SnowLuma 检测不到只打黄字提示、**不阻塞**（仓库已转私有，安装包要用户自己准备）。

只要挂件不接 QQ：命令前加 `$env:DSHDFY_SKIP_SNOWLUMA='1'`。
只体检不安装：命令前加 `$env:DSHDFY_CHECK='1'`。
自定义目录：命令前加 `$env:DSHDFY_DIR='D:\dsh-Dfy'`。

## 二、失败时分步执行

在 `%USERPROFILE%\dsh-Dfy` 下逐条跑，哪一步失败就停下修哪一步：

```powershell
# 1) 代码
if (Test-Path "$env:USERPROFILE\dsh-Dfy\.git") { git -C "$env:USERPROFILE\dsh-Dfy" pull --ff-only }
else { git clone --depth 1 https://github.com/louke6572/dsh-Dfy.git "$env:USERPROFILE\dsh-Dfy" }

# 2) 依赖
cd "$env:USERPROFILE\dsh-Dfy"; npm install

# 3) 写进 DSH（自动识别 profile）
node scripts/setup-dsh.mjs

# 4) SnowLuma（接 QQ 才需要；只检测，不下载；没有就让用户自己准备）
node scripts/install-snowluma.mjs --no-launch

# 5) 配置骨架（第 3 步一般已生成，缺了才跑）
if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json }
```

## 三、让用户做的两件事

装完后对用户说（不要自己动手）：

```text
1) 请完全退出 DSH（托盘图标也要退出）再打开，好了告诉我。
2) 打开 设置 → dsh-Dfy → 一键开始；第一次用 QQ 时在 SnowLuma 窗口扫码登录。
```

用户重启后，你继续验证：

```powershell
curl -s -o NUL -w "%{http_code}" http://127.0.0.1:3080/dsh-whale/widget.js
```

- `200` / `401`：插件已加载（401 是路由要求会话凭据，正常）
- 连不上：DSH 没起来或插件没挂上，按下面的排错表查

## 四、汇报模板

```text
dsh-Dfy 已安装。
- 路线：<只挂件/桌宠 / 内置版 QQ / AstrBot 版>
- 安装目录：<目录>
- 版本：0.7.7
- DSH profile：<profile>
- SnowLuma：<已检测到 / 未安装（需你自备安装包） / 不接 QQ>
- AstrBot：<未使用 / 由你自行安装到独立目录，已帮你配置>
- QQ：<已登录（昵称/QQ号） / 等待扫码 / 不接 QQ>
还需要你做：<例如准备 SnowLuma 包 / 扫码 / 配 DEEPSEEK_API_KEY / 无>
```

## 五、排错表

| 现象 | 处理 |
|---|---|
| `Cannot find module ...` | 回第 2 步 `npm install` |
| `EPERM` / `EBUSY` / `resource busy or locked` | DSH 还开着锁住了目录：让用户完全退出后重试 |
| `EADDRINUSE` / `:3080` 被占用 | 有多个 DSH 实例或别的程序占了 3080，关掉多余的 |
| `'git' 不是内部或外部命令` | 用户没装 Git：装 Git for Windows 后重开 DSH |
| `cannot resolve profile bundle` | 重启桌面端；或 `dsh plugin --profile <p> install` |
| profile 被 Electron 独占 | 正常：`setup-dsh` 会提示跳过，重启桌面端即可 |
| 未检测到 SnowLuma | 仓库已转私有、无法自动下载；让用户自行准备安装包，用设置页「手动选择」指定目录；或切直连模式用自备 OneBot |
| 设置页 `icon exceeds 256 KiB` | 装的是旧包，更新到最新 main |
| 装完 DSH 打不开 | 按上面「用户说装完 DSH 打不开」5 步救，不要重装 DSH |
| QQ 信封不出现 | 桥接未运行或未扫码：设置页「诊断 → 重新检测」 |
| 余额显示 `--` / 未配置 | 配 `DEEPSEEK_API_KEY`，或在 DSH「账号与余额」登录 |

## 六、完成标准

- [ ] `node scripts/setup-dsh.mjs` 退出码 0
- [ ] `~/.dsh/profiles/<profile>/package.json` 的 bundles 只有 `dsh-dfy`
- [ ] 重启后 `widget.js` 返回 200/401
- [ ] SnowLuma 已安装；QQ 已扫码登录（或已明确告诉用户去扫）
- [ ] **用户亲口确认右下角有小鲸鱼**——没确认之前不要说「装好了」
