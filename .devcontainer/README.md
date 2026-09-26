# Ubuntu 开发容器

在 macOS 上用 Ubuntu 24.04 开发、调试 HiCode，或运行独立测试项目。已验证 Apple Silicon + Colima；这是可选的开发环境，日常使用 HiCode 不需要安装容器。

## 首次启动

需要 Colima、Docker CLI、Compose 和 Buildx。使用 Homebrew 安装：

```sh
brew install colima docker docker-compose docker-buildx
```

按 `brew info docker-compose docker-buildx` 的提示配置 Docker 插件，确认 `docker compose version` 和 `docker buildx version` 可用。

在 HiCode 仓库根目录创建专用虚拟机，然后启动容器：

```sh
colima start hicode --vm-type vz --cpu 4 --memory 6 --disk 40 \
  --mount "$(pwd):w" --mount-type virtiofs --ssh-agent=false --ssh-config=false
bash .devcontainer/linux.sh start
bash .devcontainer/linux.sh
```

首次启动会构建镜像并安装项目依赖；之后复用镜像、依赖和数据卷。`start` 只确保环境运行，不会重建已有容器；已停止的容器直接恢复运行。输入 `exit` 返回 Mac，容器继续运行。

需要短命令时执行：

```sh
bash .devcontainer/linux.sh install-command
```

它安装到 `~/.local/bin/hicode-linux`。若该目录不在 PATH，在 Shell 配置中添加 `export PATH="$HOME/.local/bin:$PATH"`，重新打开终端后即可从任意目录运行 `hicode-linux`。移动仓库后需重新安装此入口。

## 在 VSCode 中打开

安装 Microsoft 的 **Dev Containers** 扩展，先完成上面的首次启动。

1. 运行 `docker context use colima-hicode`，让 VSCode 使用这台开发虚拟机。
2. 打开 HiCode 仓库，按 `⌘⇧P`，选择 **Dev Containers: Reopen in Container**。
3. 新窗口默认打开 `/workspaces/lab`。也可以通过 **Attach to Running Container…** 选择 `hicode-linux-dev-1`，再打开该目录。

首次连接需要下载匹配本地 VSCode 版本的 Server，后续复用。关闭 VSCode 不会停止容器。

## 文件放在哪里

| 容器路径 | 用途 |
| --- | --- |
| `/workspaces/lab` | 独立测试项目，保存在 `lab` 数据卷，不写入 HiCode 仓库 |
| `/workspaces/hicode` | 映射本机 HiCode 源码，编辑会同步到 Mac |
| `/workspaces/hicode/node_modules` | Linux 依赖卷，与 Mac 依赖分开 |
| `/home/node` | Linux 用户目录，保存模型配置、日志及 VSCode Server |

在 `/workspaces/lab` 创建项目后运行 `hicode`。首次配置模型，Mac 的 API Key 不会自动复制进来。容器中的 `hicode` 运行映射的源码，下次启动即可使用代码修改。

开发 HiCode 时运行 `cd /workspaces/hicode && bun run verify`。源码依赖更新后，在该目录运行 `bun install --frozen-lockfile`。

容器共享 **Colima 虚拟机** 的网络，Colima 将监听端口转发到 Mac。例如服务监听 `127.0.0.1:5173` 后，可在 Mac 打开同一地址。端口需在两边均可用；监听 `0.0.0.0` 可能对局域网开放。HiCode restricted 网络中的服务不按此方式对外发布。

## 可选代理

**默认直连，不需要创建 `.env`。** 只有构建或容器联网需要代理时，才复制模板：

```sh
cp .devcontainer/.env.example .devcontainer/.env
```

填写 `HICODE_CONTAINER_PROXY`，使用容器和构建过程能访问的代理地址。不要照抄别人的 IP 或端口；容器里的 `127.0.0.1` 属于虚拟机，不是 Mac。代理不是 HiCode 的必需依赖。

- `.env.example` 只包含空值，可以提交；实际 `.env` 已被 Git 忽略，不应提交。
- Compose 统一读取该配置，构建和运行使用相同的值；启动脚本不会将文件当作 Shell 执行。
- Mac 工具需要代理时，按工具自身方式配置标准 HTTP(S) 代理；Docker 拉取镜像还取决于 Docker 引擎的网络设置。
- 修改代理后，已有容器不会热更新。保存工作并退出运行中的任务，再执行 `hicode-linux rebuild` 应用。

如果报 `EAI_AGAIN`，检查虚拟机及容器的 `/etc/resolv.conf`。无 DNS 地址或失效的符号链接是环境故障，需按该虚拟机的网络配置修复；HiCode 不会自动改系统 DNS。

## 更新与停止

```sh
hicode-linux                 # 启动（如有需要）并进入
hicode-linux start           # 只启动，不进入
hicode-linux status          # 查看容器状态
hicode-linux stop            # 停止容器，保留数据
hicode-linux rebuild         # 重建镜像并更新容器，会中断容器内进程
colima stop hicode           # 停止整个开发虚拟机
```

永久系统依赖放入 `Dockerfile`；交互式安装的软件在重建后可能丢失。不要用 `docker compose down -v` 或删除虚拟机来普通更新，这会删除数据卷。

## 配置与隔离边界

`Dockerfile` 定义 Ubuntu、Bun、Node 和系统依赖；`compose.yaml` 定义构建、挂载和服务；`devcontainer.json` 配置 VSCode；`linux.sh` 管理本地入口。

为在容器内验证 HiCode 的 Bubblewrap 沙箱，开发容器使用专用 AppArmor profile，以及 `seccomp=unconfined`、`systempaths=unconfined`。启动脚本只向 `hicode` 虚拟机加载该 profile，不关闭虚拟机全局防护，不使用 privileged 或挂载 Docker socket。这是可信代码开发环境，不适合作为不可信任务的隔离模板。

本目录默认针对 Colima。使用其他 Docker 引擎时，可指定 `HICODE_DOCKER_CONTEXT`，但必须自行准备适用的 AppArmor 与嵌套 namespace 策略；不是更改 context 就保证兼容。

可选的 `mcp-test` profile 提供本地 HTTP MCP 示例，日常启动不会开启它。测试时单独运行：

```sh
docker --context colima-hicode compose -f .devcontainer/compose.yaml --profile mcp-test up -d mcp-http-demo
```

服务地址为 `http://127.0.0.1:8787/mcp`，示例源码见 `tooling/examples/mcp/http-demo.ts`。Skill、浏览器依赖及实际 MCP 配置由使用者按需安装，不预装个人测试数据。
