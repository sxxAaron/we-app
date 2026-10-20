# we.app · 体重记录

两个人使用的 100 天体重记录网站。手机填写体重和备注，对方登录后查看趋势、留言鼓励。数据存进自己的服务器，不依赖第三方应用账号、外部字体、CDN 或统计服务。

## 已实现

- 记录者账号：按天填写、补记、修改或删除体重，调整计划开始日期和可选目标体重。
- 陪伴者账号：查看体重、曲线和记录；不能修改体重或计划。双方都可以留言和修改自己的密码。
- 三个主导航：首页、留言、设置。历史记录从首页“全部记录”进入，保留 100 天日历、月份筛选与 CSV 导出。
- 体重、目标、曲线和导出统一使用斤。之前已按斤填写的数字保持不变，不做倍数换算；计划及 JSON 备份明确标记 `weight_unit: "jin"`。
- 独立留言页使用左右聊天气泡。前台每 4 秒检查更新，输入中的消息不会被同步覆盖；支持查看更早的留言。
- 设置分为计划设置、目标体重、账号设置、数据导出四个卡片。
- 默认计划：2026-10-19 至 2027-01-26，共 100 天，沿用原 Excel。初始体重为空，没有导入或编造任何实际体重。
- 首页每 15 秒、留言页每 4 秒检查更新；重新切回页面时同步。编辑体重或设置时暂停自动刷新，聊天同步保留未发送内容。并发修改同一天的记录时检测冲突。
- SQLite 持久化；每小时生成/更新当天一致性备份，保留最近 14 个备份日；记录者可下载包括留言的 JSON 数据备份。
- 登录密码使用随机盐和 PBKDF2-SHA256（600,000 次）；会话使用 HttpOnly、SameSite Cookie；写操作带 CSRF 验证；登录限速；双账号访问控制。
- `/?demo=1` 是独立的示例界面，示例体重和留言不会写入数据库，也不会访问实际记录。

## 数据会不会过期

体重记录、目标和留言没有到期自动删除机制。100 天只是当前计划的日期范围；计划结束后数据仍可查看和导出，原版限制在计划日期内记录体重。登录会话 7 天后到期，需要重新登录，不会删除数据。每日自动备份保留最近 14 个备份日，轮换的只是备份副本。留言默认加载最近 100 条，可继续向前翻页；数据库与完整 JSON 导出保留全部留言。

## 已部署实例更新

在原来的项目目录内更新，使用现有数据库卷：

```bash
/usr/bin/git pull --ff-only
docker compose exec app python manage.py backup
docker compose up -d --build
```

使用指定 SSH 密钥的服务器应保留仓库内的 `core.sshCommand` 配置。更新不需要重新初始化、不需要导入旧的账号文件，也不要使用 `docker compose down -v`。旧数字已按斤输入，只修正单位，不修改历史数值。

## Linux + Docker 部署

需要 Docker Engine、Docker Compose 插件。以下所有命令都在项目根目录执行。初始配置工具需要 Python 3.11+；如果服务器没有 Python，可用后面的 Docker 替代命令。

已有其他网站占用 80/443、只想先在新端口试用时，可直接看“方案 D”。HTTPS 方案与 HTTP 试用方案不要混用。

### 方案 A：已有 Nginx / 宝塔 / 1Panel 等 HTTPS 反向代理

1. 将代码克隆到服务器，进入项目目录：

```bash
git clone https://github.com/sxxAaron/we-app.git
cd we-app
```
2. 生成配置，把示例域名换成你自己的域名：

```bash
python3 manage.py init-env --domain weight.example.com
docker compose up -d --build
```

此默认 HTTPS 代理方案中，应用只监听服务器本机 `127.0.0.1:18765`。在已有 HTTPS 站点中，将请求反向代理到 `http://127.0.0.1:18765`，并保留原始 Host 头。可参考 `nginx.example.conf`。如果代理自身运行在容器中，应通过共享 Docker 网络连接 app，而不是在代理容器中访问 127.0.0.1。

### 方案 B：服务器没有占用 80/443，使用 Caddy 自动 HTTPS

先把域名的 A / AAAA 解析正确指向服务器，开放 TCP 80/443。已有站点正在占用这些端口时请使用方案 A。

```bash
python3 manage.py init-env --domain weight.example.com
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

访问 `https://weight.example.com`。Caddy 的证书签发与续期需要服务器可正常访问证书服务，域名解析正确，端口可从公网访问。

### 没有宿主机 Python 时

用官方 Python 容器生成配置，然后再执行对应方案的启动命令：

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/project" -w /project python:3.13-slim python manage.py init-env --domain weight.example.com
```

### 首次打开与两个账号

在你自己的服务器终端查看初始化密钥：

```bash
docker compose exec app python manage.py setup-token
```

在网站初始化页面输入该密钥，设置两个账号、昵称和密码：记录者能修改体重，陪伴者能查看与留言。账号使用 3～32 位字母、数字、点、横线、下划线；密码至少 10 个字符。初始化密钥不是登录密码；初始化完成后无法通过它重复创建账号或查看数据。

使用 Caddy 方案时，对运行中容器执行管理命令仍可用 `docker compose exec app ...`。查看整个部署或停止时则要带上两个 `-f` 参数。

**不要提交 `.env`、数据库和备份到 Git 仓库。** 账号密码由你初始化时自行设置，源码没有默认登录密码。

### 方案 C：没有域名，用公网 IPv4 + HTTPS

不需要先买域名。此方案通过 Caddy 2.11.7 和 Let’s Encrypt 的 `shortlived` 证书配置，为公网 IPv4 申请受浏览器信任的 HTTPS 证书；Caddy 自动续期，保留加密登录和 Secure Cookie。IP 必须是你控制的服务器公网 IPv4，不能填内网、回环或文档示例地址。当前配置只覆盖 IPv4。

前提：服务器 TCP 80/443 可从公网访问，而且这两个端口没有被其他站点占用。这里指公网对应的标准端口；如果服务商做了端口映射，需要把公网的 80/443 映射到此部署。应用自身的 18765 端口保持只监听本机，不需要开放。

第一次部署，在服务器执行（将“你的公网IPv4”替换为实际 IP）：

```bash
git clone https://github.com/sxxAaron/we-app.git
cd we-app
python3 manage.py init-env --ip 你的公网IPv4
docker compose -f compose.yaml -f compose.ip.yaml up -d --build
```

如果已经克隆仓库，先在仓库目录执行 `git pull`，跳过 `git clone` 和 `cd`。没有 Python 3.11+ 时，用以下命令代替生成配置的那一行：

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/project" -w /project python:3.13-slim python manage.py init-env --ip 你的公网IPv4
```

若 `.env` 已存在，初始化工具不会覆盖它。保留原来的 `SETUP_TOKEN` 和数据库配置，手动设置以下三项即可：

```dotenv
SERVER_IP=你的公网IPv4
PUBLIC_ORIGIN=https://你的公网IPv4
COOKIE_SECURE=true
```

查看启动状态和证书签发进度：

```bash
docker compose -f compose.yaml -f compose.ip.yaml ps
docker compose -f compose.yaml -f compose.ip.yaml logs --tail=100 caddy
```

等证书签发成功，再用手机打开 `https://你的公网IPv4`，然后查看初始化密钥，创建两个账号：

```bash
docker compose exec app python manage.py setup-token
```

签发必须通过证书机构从公网进行验证；如果失败，先检查 IP、端口、防火墙和现有服务占用。不要通过浏览器忽略证书错误来使用登录功能。签发与自动续期依赖证书机构网络可达、80/443 验证链路和 Caddy 数据卷正常保留。IP 变化后需要同步更新 `SERVER_IP` 和 `PUBLIC_ORIGIN`，重新创建容器。

IP 证书目前有效期约六天，Caddy 会自动续期。请保留 Caddy 数据卷，并确保服务持续运行。此配置已通过本地 Caddy 适配检查，尚未在你的公网 IP 上实际签发证书，也未在此电脑运行 Docker 容器；这些步骤需要在服务器上验证。

参考：[Let’s Encrypt 的 IP 证书公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy ACME profile 配置](https://caddyserver.com/docs/caddyfile/directives/tls#issuers)。IP 访问是否受服务商的接入与备案要求限制，仍取决于服务器实际所在地和服务商规则，IP 不能用来绕过这些要求。

只做本机测试时，也可使用 SSH 隧道。临时将本地/测试环境的 `.env` 设置为 `COOKIE_SECURE=false`、清空 `PUBLIC_ORIGIN`，在服务器启动基础 `compose.yaml`；自己的电脑执行 `ssh -L 18765:127.0.0.1:18765 your-user@your-server`，浏览器访问 `http://127.0.0.1:18765`。这条路径仅供本机验证，不能作为双方异地使用的入口。

### 方案 D：指定新端口的 HTTP 试用，不调整原来的 Nginx

适合已有网站占用 80/443、暂时没有域名、希望先看效果的情况。此方案独立使用指定的新端口，不停止 Nginx，也不修改现有站点。**HTTP 下账号密码、体重和留言的传输没有加密，只用于试用，请勿复用重要密码；正式使用应接入 HTTPS。**

在服务器终端执行，将“你的公网IPv4”替换为真实地址，默认端口为 40039：

```bash
git clone https://github.com/sxxAaron/we-app.git
cd we-app
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/project" -w /project python:3.13-slim python manage.py init-env --http-ip 你的公网IPv4 --port 40039
docker compose up -d --build
docker compose exec app python manage.py setup-token
```

如果已克隆代码，先在仓库目录执行 `git pull`，跳过前两行。生成配置时若已有 `.env`，工具会拒绝覆盖；请保留原来的 `SETUP_TOKEN`，手动设置以下四项后再运行 `docker compose up -d --build`：

```dotenv
PUBLIC_ORIGIN=http://你的公网IPv4:40039
COOKIE_SECURE=false
BIND_ADDRESS=0.0.0.0
APP_PORT=40039
```

在服务器安全组和防火墙中允许 **TCP 40039**。浏览器打开 `http://你的公网IPv4:40039`，填入上一条管理命令显示的初始化密钥，设置两个账号。密钥只在你自己的终端查看，不要发到聊天或提交到仓库。

已经初始化过的数据库会继续保留，修改端口不会清除体重记录。后续长期使用时，在现有 Nginx 配置 HTTPS 反代：将 `BIND_ADDRESS` 改回 `127.0.0.1`、`APP_PORT` 改回 `18765`、`COOKIE_SECURE` 改为 `true`、`PUBLIC_ORIGIN` 改成最终 HTTPS 地址，然后重新创建 app 容器。IP HTTPS 的证书验证仍需接入公网 80 或 443；40039 本身不能替代标准证书验证端口。

## 更新和运维

```bash
git pull
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

有域名的 Caddy 部署请始终带上 `-f compose.yaml -f compose.https.yaml`；无域名的 IP HTTPS 部署请始终带上 `-f compose.yaml -f compose.ip.yaml`。不要把两个 Caddy 方案同时启动。数据使用 Docker 命名卷保存，更新镜像不会清空数据。HTTP 试用配置也使用同一数据卷。**不要运行 `docker compose down -v`，它会删除数据卷。**

### 手动备份与恢复

```bash
docker compose exec app python manage.py backup
docker compose cp app:/data/backups ./backups
```

自动备份与数据库在同一服务器，服务器或磁盘故障会一起丢失，因此请定期把 `backups` 复制到其他设备。SQLite 备份包括密码哈希和会话信息，应像账号资料一样保管。网页中的 JSON 备份不含密码或会话，适合保留记录和留言，但没有提供网页导入恢复功能。

恢复 SQLite 备份时，先停止整个部署，把备份上传为项目目录下的 `restore.sqlite3`。以下命令会覆盖数据库，请先另存当前数据库；确认所选备份正确后再执行：

```bash
docker compose stop
docker compose run --rm --no-deps -v "$PWD/restore.sqlite3:/restore.sqlite3:ro" app python -c 'import sqlite3; source=sqlite3.connect("/restore.sqlite3"); dest=sqlite3.connect("/data/journal.db"); source.backup(dest); dest.execute("DELETE FROM sessions"); dest.commit(); source.close(); dest.close()'
docker compose up -d
```

Caddy 方案的 stop/up 命令同样需要带对应的两个 `-f` 参数（域名用 `compose.https.yaml`，IP 用 `compose.ip.yaml`）。备份文件需要容器 UID 10001 可读。恢复后双方重新登录。数据目录和备份文件不要放在可公开访问的站点目录。

### 忘记密码

在自己的服务器终端执行（新密码通过隐藏输入提示录入，不出现在命令参数中）：

```bash
docker compose exec app python manage.py reset-password your-username
```

### 不使用 Docker 的本地运行

Python 3.11+，无需 pip 安装依赖：

```bash
python3 manage.py init-env
```

把本地 `.env` 的 `COOKIE_SECURE` 改成 `false`，保留 `HOST=127.0.0.1` 和空的 `PUBLIC_ORIGIN`，然后：

```bash
python3 server.py
```

浏览器访问 `http://127.0.0.1:8080`。生产环境使用 Docker 与 HTTPS 反向代理，不要把调试端口直接公开。

## 验证

```bash
python3 -m unittest discover -s tests -v
node --test tests/test_ui.cjs
```

测试使用隔离临时数据库，覆盖初始化、登录、跨账号权限、留言共享、持久化、并发冲突、日期和空值校验、CSRF、CSV 注入防护、密码修改和 SQLite 备份；另有部署配置测试覆盖公网 IP 校验、安全默认值和配置防覆盖。

## 结构

`server.py`：HTTP API、身份与权限、SQLite、备份。`static/`：无构建依赖的响应式界面。`manage.py`：部署配置、备份和密码恢复。整个应用运行时仅需 Python 标准库。Docker 基础镜像与 Caddy 镜像首次部署时需要从镜像仓库拉取。

参考：[Docker Compose 安装](https://docs.docker.com/compose/install/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Python SQLite 备份 API](https://docs.python.org/3.13/library/sqlite3.html#sqlite3.Connection.backup)。
