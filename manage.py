"""Deployment initialization, consistent backups, and local password recovery."""
import argparse
import getpass
import ipaddress
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description='一起，轻一点 · 管理工具')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init-env', help='生成部署配置，不覆盖已有配置')
    address = init.add_mutually_exclusive_group()
    address.add_argument('--domain', default='', help='例如 weight.example.com，不含 https://')
    address.add_argument('--ip', default='', help='使用服务器公网 IPv4，通过 Caddy 自动申请 IP HTTPS 证书')
    address.add_argument('--http-ip', default='', help='仅供试用：使用公网 IPv4 通过未加密 HTTP 直连')
    init.add_argument('--port', type=int, default=40039, help='HTTP 试用的访问端口，默认 40039')
    commands.add_parser('setup-token', help='在自己的服务器终端查看一次性初始化密钥')
    backup = commands.add_parser('backup', help='创建一致的 SQLite 备份')
    backup.add_argument('--output', help='输出路径，默认放入数据库旁的 backups 目录')
    recovery = commands.add_parser('reset-password', help='在服务器终端交互式重置密码')
    recovery.add_argument('username')
    args = parser.parse_args()
    if args.command == 'init-env':
        if not 1024 <= args.port <= 65535:
            parser.error('--port 需要在 1024～65535 之间')
        selected_ip = args.ip or args.http_ip
        if selected_ip:
            try:
                public_ip = ipaddress.ip_address(selected_ip)
            except ValueError:
                parser.error('需要填写服务器公网 IPv4，例如服务商控制台显示的公网 IP')
            if public_ip.version != 4 or not public_ip.is_global or public_ip.is_multicast:
                parser.error('只支持公网 IPv4；不能使用内网、回环、保留地址或 IPv6')
        if args.domain and (not all(c.isalnum() or c in '.-' for c in args.domain) or '.' not in args.domain):
            parser.error('域名只能包含字母、数字、点和横线，例如 weight.example.com')
        path = ROOT / '.env'
        if path.exists():
            raise SystemExit('.env 已存在，未覆盖。请直接编辑自己的配置。')
        public_origin = ('http://' + args.http_ip + ':' + str(args.port)) if args.http_ip else ('https://' + (args.domain or args.ip) if args.domain or args.ip else '')
        config = f'''# 本文件包含秘密，不要提交到 Git 或发送给他人。
SETUP_TOKEN={secrets.token_urlsafe(32)}
DOMAIN={args.domain}
SERVER_IP={args.ip}
PUBLIC_ORIGIN={public_origin}
COOKIE_SECURE={'false' if args.http_ip else 'true'}
BIND_ADDRESS={'0.0.0.0' if args.http_ip else '127.0.0.1'}
APP_PORT={args.port if args.http_ip else 18765}
PORT=8080
HOST=127.0.0.1
DB_PATH={ROOT / 'data/journal.db'}
'''
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(config)
        print('已生成 .env（仅本机当前用户可读写）。')
        print('使用 python3 manage.py setup-token 在自己的终端查看初始化密钥。')
        if args.http_ip:
            print('HTTP 试用模式：登录和记录的传输未加密，请勿复用重要密码。正式使用请配置 HTTPS。')
            print(f'试用地址：http://{args.http_ip}:{args.port}')
            print(f'请确认服务器安全组/防火墙允许 TCP {args.port}，然后执行 docker compose up -d --build。')
        elif args.ip:
            print('已配置公网 IP HTTPS。请确保 80/443 端口可访问且未被占用，然后执行：')
            print('docker compose -f compose.yaml -f compose.ip.yaml up -d --build')
        elif not args.domain:
            print('尚未配置公网访问地址。可通过已有 HTTPS 代理接入，或使用 --domain / --ip 创建配置。')
        return
    import server
    if args.command == 'setup-token':
        if not server.SETUP_TOKEN:
            raise SystemExit('尚未配置密钥，请先执行 python3 manage.py init-env')
        print(server.SETUP_TOKEN)
    elif args.command == 'backup':
        if not server.DB_PATH.exists():
            raise SystemExit('数据库不存在，请先启动并初始化应用。')
        print(f'备份已创建：{server.make_backup(args.output)}')
    elif args.command == 'reset-password':
        if not server.DB_PATH.exists():
            raise SystemExit('数据库不存在。')
        password = getpass.getpass('新密码（至少10个字符，输入不显示）：')
        if password != getpass.getpass('再次输入新密码：'):
            raise SystemExit('两次输入不一致，未修改。')
        try:
            server.valid_password(password)
        except server.APIError as error:
            raise SystemExit(error.message)
        with server.connect() as db:
            user = db.execute('SELECT id FROM users WHERE username=?', (args.username,)).fetchone()
            if not user:
                raise SystemExit('账号不存在，未修改。')
            db.execute('UPDATE users SET password=? WHERE id=?', (server.hash_password(password), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
        print('密码已重置，该账号所有设备已退出登录。')


if __name__ == '__main__':
    main()
