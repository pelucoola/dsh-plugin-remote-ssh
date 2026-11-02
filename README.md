# dsh-plugin-ssh

DSH（DeepSeek Harness）插件：让 DSH 通过 SSH 控制远程主机，并在 **设置 → SSH 主机** 里管理这些主机。

- **智能体工具**
  - `ssh`：在已保存的主机上执行命令（支持 `cwd`、`stdin`、超时；返回 exitCode / stdout / stderr）。
  - `ssh_hosts`：List / Get / Add / Update / Remove / Test 已保存主机。
- **设置界面**：`设置 → SSH 主机`，新增 / 编辑 / 删除 / 测试连接，支持用户、端口、私钥文件、ProxyJump、备注。
- **同一份实现**：设置页通过 `/api` RPC 网关调用 Host 半边的 `sshHosts` 服务，Agent 工具调用同一批方法。
- **零依赖**：Host 半与浏览器半都不 import 任何 `@deepseek-ai/dsh-*` 包，只骑运行时 Cordis Context。

## 目录

```
dsh-plugin-ssh/
├─ index.js              # Host 半：sshHosts 服务 + typert RPC + 两个工具
├─ client.js             # 浏览器半：设置页里的「SSH 主机」section
├─ lib/
│  ├─ config.js          # bundle 行 Config（Standard Schema，手写校验）
│  ├─ hosts.js           # $DSH_HOME/ssh-hosts.json 持久化（原子写 + 0600）
│  └─ ssh.js             # ssh argv 构造 + 子进程执行 + 输出截断
├─ cordis.patch.yml      # bundle patch：插入 id 为 ssh-hosts 的插件行
├─ locale/{zh,en}.json   # 插件管理 / 设置里显示的标题与描述
├─ icon.svg              # 插件图标
├─ test/                 # node:test 单元测试（不联网）
└─ scripts/smoke.mjs     # 手工 smoke（假 ssh，可执行文件）
```

## 安装

在 DSH 里用插件管理器安装本地目录（推荐，自动写 profile 依赖与 bundles 列表）：

```
plugin_manager / install_bundle → target = <本仓库绝对路径>
```

或者用 CLI：

```sh
dsh plugin --profile desktop add /绝对路径/dsh-plugin-ssh
```

本地目录安装会以 `link:` 依赖写进 profile，bundles 列表里追加 `dsh-plugin-ssh`；安装后立即生效。
之后改了 Host/Client 代码，需要重新执行一次 `install_bundle`（或重启 DSH）才会加载新的 JS 模块。

卸载：

```
plugin_manager / remove_bundle → target = dsh-plugin-ssh
```

主机清单 `$DSH_HOME/ssh-hosts.json` 不会被删除，需要时手动删。

## 配置（bundle 行的 `config`）

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: ssh-hosts
  name: dsh-plugin-ssh
  config:
    sshBinary: ssh            # 默认 ssh，走 PATH
    connectTimeoutSec: 10     # 1-120
    defaultTimeoutMs: 60000   # 1000-600000
    maxOutputBytes: 200000    # 每个流截断阈值，4096-8MiB
```

未知键会直接挂载失败（fail-loud），不会静默忽略拼写错误。

## 使用

### 设置页

`设置 → SSH 主机`：

1. 「添加主机」填名称、主机地址（必填），用户 / 端口 / 私钥 / 跳板机 / 备注可选。
2. 「测试连接」会执行 `printf 'ok'; uname -srm` 并显示延迟与系统信息。
3. 「删除」需要点两次（第二次为「确认删除」）。

### 智能体

```
ssh(host: "prod-web", command: "systemctl status nginx", cwd: "/srv")
ssh()                                   # 列出已保存主机
ssh_hosts(action: "add", name: "prod-web", host: "10.0.0.5", user: "root")
ssh_hosts(action: "test", id: "prod-web")
```

调用 `ssh` 时 `host` 可以填主机 **id** 或**名称**；`host` 与 `command` 都省略时返回主机清单。

## 存储与安全

- 主机清单：`$DSH_HOME/ssh-hosts.json`（0600；原子写：临时文件 + rename；进程内串行写）。
- **不保存任何密码 / 私钥内容**，只保存私钥路径。认证完全交给本机 SSH 客户端：
  `ssh-agent`、`~/.ssh/config`、或你在主机条目里指定的 `IdentityFile`。
- 所有 ssh 调用固定 `-o BatchMode=yes`：不会弹出交互式密码提示；需要密码登录的主机请先配置公钥
  （`ssh-copy-id user@host`）。首次连接新主机时，请先在终端里手动 ssh 一次，或自行管理 `known_hosts`。
- 主机地址 / 用户 / 端口 / 跳板机都会校验（禁止空白、禁止以 `-` 开头），避免被 SSH 参数解析器误读为选项；
  本地不经过 shell（`spawn` 直接传 argv）。
- 远程命令字符串会交给远端登录 shell 执行——这是"SSH 控制远程主机"的定义。命令能力等同于该 SSH 账号
  在远端拥有的权限；插件不会扩大这个权限，也不会绕过远端权限系统。
- Agent 能看到并调用 `ssh_hosts` 修改主机清单（与设置页同一份实现）。如果你不希望模型自行添加主机，
  可以在 profile patch 里停用整个插件或另行收紧工具权限。

## 开发

要求 Node.js ≥ 22.19。

```sh
npm test        # node:test：hosts 持久化 / 校验 / ssh argv / 子进程包装（假 ssh，不联网）
npm run smoke   # 手工 smoke：临时目录 + 假 ssh 可执行文件
```

源码即产物（无构建步骤）：`index.js`、`client.js`、`lib/*.js` 都是最终加载的文件。

### 机制要点

- **Host → Client 暴露**：`ctx.typert.register()` 注册 strict invocations，服务对象带
  `typertRemote = { service, serviceKey, namespace }` 绑定；浏览器半用
  `ctx.connection.rpc.call('/api', 'sshHosts/<method>', { args })` 调用。
- **设置页**：客户端插件向 `settings.section` 槽注册 `id: 'ssh-hosts'` 的 section；
  文案走 `ctx.locale.register` + `bind`，中英文即时切换。
- **工具**：`ctx.tools.register()` 注册普通对象（`output.schema` / `output.render` / `execute`），
  没有可用的 `defineTool` 依赖，故直接给注册表需要的最终 schema 形状。

## 远端 Git

本仓库是普通 git 仓库，`git init` 后已提交。需要推到远端时：

```sh
git remote add origin git@github.com:<you>/dsh-plugin-ssh.git
git push -u origin main
```

## License

MIT
