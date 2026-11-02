# 让 AI 直接接管你的服务器：dsh-plugin-remote-ssh 上手指南

> 一句话：给 DeepSeek Harness（DSH）装上「SSH 手脚」——智能体能连上你的远程主机执行命令，你可以在设置页里管理这些主机。连接可复用、超时能自适应、凭据不落地。

---

## 为什么需要它

用 AI 干活的人大概都遇到过这个断点：AI 帮你写好了部署脚本、排查了 nginx 配置、生成了清理命令，然后——卡在「你自己去服务器上执行一下」这一步。

复制粘贴能解决大部分问题，但有几个场景特别别扭：

- 排查问题要来回好几轮：`df -h` → 看结果 → 再 `du -sh *` → 再进下一层。每一轮都要人工搬运。
- 服务器多的时候，要记哪台是生产、哪台是测试、端口和密钥分别是什么。
- 临时想确认一个服务状态，还得先打开终端、ssh、敲命令。

**dsh-plugin-remote-ssh** 做的就是把这层「手」接上：DSH 的智能体获得 `ssh` / `ssh_hosts` 两个工具，可以在你配置好的主机上执行命令；你则在 **设置 → SSH 主机** 里像管理书签一样新增、编辑、测试、删除主机。

---

## 三分钟安装

不需要 npm 账号，直接用 Git 安装（推荐）：

```sh
dsh plugin --profile desktop add git+https://github.com/pelucoola/dsh-plugin-remote-ssh.git
```

其他方式：

```sh
# 锁定到某个 release 的 commit
dsh plugin --profile desktop add git+https://github.com/pelucoola/dsh-plugin-remote-ssh.git#<40位commit>

# 或者用 Release 压缩包
dsh plugin --profile desktop add https://github.com/pelucoola/dsh-plugin-remote-ssh/releases/download/v0.2.0/dsh-plugin-remote-ssh-0.2.0.tgz
```

也可以在 DSH 的「插件 → 添加插件」里直接粘贴上面任意一个地址。

如果你用的 DSH 构建带 Discover（市场）页签，可以添加这个索引源，搜索 **SSH Remote Hosts** 安装：

```
https://raw.githubusercontent.com/pelucoola/dsh-plugin-remote-ssh/main/market/index.json
```

**环境要求**：DSH `^0.2.0-rc.5`（在 Desktop 0.2.1-rc.5 上验证），本机有 OpenSSH 客户端。连接复用依赖 OpenSSH 的 ControlMaster，macOS / Linux 原生支持，Windows OpenSSH 会自动退回单次连接。

安装完打开 **设置 → SSH 主机**，能看到页面就说明装好了。

---

## 上手：把主机交给 AI

### 1. 在设置页添加主机

填名称和地址（必填），用户、端口、私钥文件、跳板机（ProxyJump）、备注可选：

```
名称：prod-web
地址：10.0.0.10
用户：root
私钥：~/.ssh/id_ed25519
```

「测试连接」会真实发起一次 SSH，返回延迟和远端 `uname`；确认网络、密钥、known_hosts 都没问题，再开始用。

### 2. 在对话里直接说

不需要记工具名，用自然语言点名主机即可：

- 「连上 prod-web，看看磁盘和内存占用」
- 「在 prod-web 上执行 `systemctl status nginx`」
- 「先列出我配置的 SSH 主机」
- 「把 1.2.3.4 加成一个叫 test 的主机，用户 root」

智能体会调用 `ssh` / `ssh_hosts` 工具，结果（exitCode、stdout、stderr）直接回到对话里；非 0 退出码不是错误，而是可读的数据，AI 会自己根据日志继续排查。

---

## 真实案例：一次把 `/var` 从 26G 清到 5.1G

这是插件上线后做的第一次「实战」。一台跑了 8 个多月业务的腾讯云 Ubuntu 服务器，`/` 分区 50G 用了 35G（75%），告警空间不足。

在对话里只说了一句：「检查在腾讯云1 /var 为什么占了那么大的空间」。接下来几轮全部由智能体通过 `ssh` 工具完成：

### 诊断

```sh
df -h / /var
du -xh --max-depth=1 /var | sort -rh | head
find /var -xdev -type f -size +200M -printf '%s\t%p\n' | sort -rn | head
```

发现的问题非常集中：

| 占用点 | 大小 | 原因 |
|---|---|---|
| Docker 镜像（5 个不再使用的应用版本） | ~19 GB | 多版本镜像堆积，`docker system df` 显示 85% 可回收 |
| 单个容器 json 日志 | 806 MB | 没配日志轮转，容器跑了 6 周 |
| systemd journal | 3.1 GB | 没有大小上限 |
| apt 索引 / snap | ~1.1 GB | 正常占用，未动 |

### 执行清理

确认后，智能体依次执行：

1. 删除 5 个未使用的应用镜像（保留所有运行中容器的镜像）；
2. `truncate` 清空 806MB 的容器日志（不需要重启容器）；
3. `journalctl --vacuum-size=200M`，并写入 `SystemMaxUse=200M` 限制；
4. 配置 Docker 日志轮转（`max-size=100m, max-file=3`），重启 docker，4 个 `restart=always` 的容器自动恢复；
5. 顺手清理了 1Panel 里一个已损坏的残留应用目录和安装记录（含删除前的数据备份）。

### 结果

| 指标 | 清理前 | 清理后 |
|---|---|---|
| `/var` | 26 GB | **5.1 GB** |
| Docker 镜像 | 20.13 GB（9 个） | 3.52 GB（4 个，全部在用） |
| journal | 3.1 GB | 152 MB |
| 根分区 | 35G 已用 / 13G 可用（75%） | **15G 已用 / 33G 可用（31%）** |
| 业务容器 | 4 个运行中 | 4 个运行中，全程只中断数秒 |

整个过程没有人工登录服务器，也没有把服务器地址、日志、配置贴进对话之外的任何地方——所有命令都来自 AI 对 `ssh` 工具的调用，每一步结果都可以在会话记录里审计。

---

## 安全设计：不替你保管秘密

给 AI 开 SSH 权限，安全是必须回答的问题。这个插件的边界很明确：

- **不存密码、不存私钥内容**。主机清单在 `$DSH_HOME/ssh-hosts.json`（0600、原子写），只保存私钥**路径**；认证交给本机 OpenSSH（ssh-agent / `~/.ssh/config` / IdentityFile）。
- **不经过本地 shell**。所有 SSH 调用都是 `spawn(argv)` 直接执行，主机地址、用户、端口、跳板机都做了校验（禁止空白、禁止以 `-` 开头），不会被拼进 shell 或误读成 ssh 选项。
- **固定 `BatchMode=yes`**。不会弹交互式密码提示，避免卡死或凭据被代理；需要密码登录的机器请先用 `ssh-copy-id` 配好公钥。
- **复用的连接有生命周期**。ControlMaster socket 放在 `$DSH_HOME/ssh-masters`（目录 0700），连接身份由 host/port/user/key/jump 哈希决定；插件卸载时会主动 `ssh -O exit` 关闭所有 master。
- **能力边界就是 SSH 账号的权限**。远程命令以该账号身份执行，插件不扩大、也不绕过远端权限系统。建议给自动化单独建一个低权限账号，只在需要的机器上开需要的权限。

> 注意：Agent 可以通过 `ssh_hosts` 工具添加/修改主机（和设置页同一套实现）。如果你不希望模型自行加主机，可以停用插件，或用 DSH 的工具权限策略收紧。

---

## 连接与超时优化：让连续操作真的「连续」

AI 排查问题往往是连续十几条命令。如果每条都重新握手，体验会很割裂。插件做了两件事：

### 1. 一条连接，多次复用

基于 OpenSSH 的 `ControlMaster` / `ControlPersist`，同一主机在 DSH 进程内的多次调用复用一条后台连接，命令返回里会带 `sessionReused`。实测同一台服务器：

| 调用 | 耗时 |
|---|---|
| 首次（建连 + 握手） | 871 ms |
| 第二次（复用） | **29 ms** |
| `ssh_hosts disconnect` 后 | 重新建连 |

连接空闲 `sessionPersistSeconds`（默认 300 秒）后自动回收；`ssh_hosts` 里的 `disconnect` 可以手动断开。

### 2. 动态超时：有输出就续命

固定 60 秒超时是 AI 远程操作的重灾区：`npm run build`、`docker pull`、大文件打包动辄几分钟。插件把 `timeoutMs` 改成**静默超时**：

- 命令只要还有 stdout/stderr 输出，计时就重置，可以一直跑；
- 完全没有输出超过 `timeoutMs`（默认 120 秒）才终止，避免挂死；
- 另有 `maxTimeoutMs`（默认 1 小时）作为单次调用的硬上限。

实测：给 `timeoutMs: 1500` 跑一个每 1 秒输出一行的 4 秒命令，**正常跑完**；而 `sleep 5` 这种静默命令会在 1.5 秒准时被终止，并明确返回 `idle timeout`。结果里还有 `timeoutKind`（`none` / `idle` / `total`）和 `sessionReused`，方便 AI 判断该重试还是该换策略。

### 可调配置

在 profile 的 `cordis.patch.yml` 里覆盖（bundle 行 id `ssh-hosts`）：

```yaml
- id: ssh-hosts
  name: dsh-plugin-remote-ssh
  config:
    defaultTimeoutMs: 120000    # 静默多久没输出才终止
    maxTimeoutMs: 3600000       # 单次硬上限
    reuseSession: true          # 连接复用开关
    sessionPersistSeconds: 300  # 空闲回收时间
```

---

## 适合谁 / 不适合谁

**适合**：

- 用 DSH 做运维、排查、部署，希望 AI 直接执行而不是「给我命令我自己敲」；
- 有多台服务器需要统一管理（生产 / 测试 / 跳板机）；
- 已经用 ssh-agent 或密钥登录，不想把密码交给任何工具。

**暂不支持 / 限制**：

- 不支持密码认证（用公钥；`BatchMode` 刻意不弹密码框）；
- 复用的是连接，不是交互式 shell：`cd`、`export` 不跨调用保留，目录用 `cwd` 参数；
- Windows OpenSSH 不支持连接复用，会退回单次连接；
- v0.2 暂不含 SFTP 文件传输，复杂文件操作可以 `scp` / `rsync` 写进命令。

---

## 结语

DSH 本身是个很能干的 Agent 运行时，但它的能力边界默认在本地。**dsh-plugin-remote-ssh 把这条边界安全地扩到了你的服务器上**：主机你来管，凭据不落地，命令可审计，连接可复用。

如果你也在用 DSH 管理服务器，欢迎试用，也欢迎 issue / PR：

- 仓库：<https://github.com/pelucoola/dsh-plugin-remote-ssh>
- 安装：`dsh plugin --profile desktop add git+https://github.com/pelucoola/dsh-plugin-remote-ssh.git`
- License：MIT
