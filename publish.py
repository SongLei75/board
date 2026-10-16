#!/usr/bin/env python3
"""jfrog 发布工具.

npm 子命令 —— @carizon/board-session 发布: 打包当前工程 -> 推送到 jfrog vscode.
  用法: python3 publish.py npm [--version X] [--registry URL] [--tag carizon] [--dry-run]
  流程: 读取 package.json (name/files/version) -> 按 files 清单打包 (版本号只打进
        包内 package.json, 不动仓库文件) -> 打印打包来源/推送目标 -> 账号密码认证 ->
        删冲突版本 -> 推送.
  推送直接走 npm registry HTTP 协议 (Python 标准库 urllib, 无 subprocess 无 npm CLI),
  请求语义与 npm 12 libnpmpublish 一致:
    GET    <pkg>?write=true   读 packument (404 = 不存在, 取 _rev)
    冲突时 PUT <pkg>/-rev/<_rev> 摘除该版本 + DELETE 对应 tarball
           (npm unpublish 单版本路径; 无冲突不删任何东西, 其余版本/dist-tag 不动)
    PUT    <pkg>              推送 metadata + _attachments (base64 tarball)

scope 注意 (foundry-local-sdk 是无 scope 包, 这里不同):
  packument 路径      {base}@carizon%2Fboard-session
  tarball 文件名      carizon-board-session-{version}.tgz (scope 前缀去 @, 斜杠换 -)
  dist.tarball        {base}@carizon/board-session/-/carizon-board-session-{version}.tgz

认证: 交互输入账号密码 (密码不回显), Basic 头随每个请求发送, 不落盘。
"""

import argparse
import base64
import getpass
import gzip
import hashlib
import json
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

DEFAULT_REGISTRY = 'https://jfrog.carizon.work/artifactory/api/npm/vscode/'
DEFAULT_TAG = 'carizon'
PKG_NAME = '@carizon/board-session'
REPO_ROOT = Path(__file__).resolve().parent
# files 缺失时的兜底清单 (正常应始终能从 package.json 读到)
FALLBACK_FILES = ('dist', 'prebuilds', 'README.md')


def fail(msg):
    """统一失败出口: 直接非零退出, 不做任何降级。"""
    print(f'error: {msg}', file=sys.stderr)
    sys.exit(1)


def login():
    """交互式账号密码登录; 非 TTY 直接失败。"""
    if not sys.stdin.isatty():
        fail('非交互式终端, 发布需要账号密码登录, 请在终端里运行')
    username = input('jfrog 账号: ').strip()
    password = getpass.getpass('jfrog 密码: ')
    if not username or not password:
        fail('账号或密码为空')
    return username, password


def request(method, url, token=None, body=None, content_type='application/json', timeout=300):
    """带 Basic 认证的 HTTP 请求; 返回 (status, body_bytes)。
    token=None 时不带认证头 (匿名探测/下载); 4xx/5xx 不抛异常,
    由调用方按状态码决策 (404 = 不存在, 其余放行判定)。"""
    headers = {
        'Accept': 'application/json',
        'Content-Type': content_type,
        'User-Agent': 'npm/12.0.2 node/v22.23.2 linux x64 (publish.py)',
        'Accept-Encoding': 'identity',
    }
    if token is not None:
        headers['Authorization'] = f'Basic {token}'
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = res.read()
            if res.headers.get('Content-Encoding') == 'gzip':
                data = gzip.decompress(data)
            return res.status, data
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def error_detail(data):
    """解析 registry 错误体 (Artifactory {errors:[...]} / npm {error:...})。"""
    try:
        parsed = json.loads(data)
        if 'errors' in parsed:
            return '; '.join(e.get('message', str(e)) for e in parsed['errors'])
        if 'error' in parsed:
            return str(parsed['error'])
    except (ValueError, TypeError):
        pass
    return data.decode('utf-8', 'replace').strip()[:300] or '无错误体'


def expect(status, ok, step, data):
    if status not in ok:
        fail(f'{step} 失败 (HTTP {status}): {error_detail(data)}')


def tarball_basename(version):
    """scope 包在 registry 上的 tarball 文件名: @scope/name -> scope-name-version.tgz。"""
    return f'{PKG_NAME.lstrip("@").replace("/", "-")}-{version}.tgz'


def collect_files(pkg_dir, manifest):
    """按 package.json 的 files 展开实际要打包的路径 (相对仓库根), 检查存在性。
    files 为唯一真源; 读不到时回退 FALLBACK_FILES, 保证不静默漏打内容。"""
    entries = manifest.get('files') or list(FALLBACK_FILES)
    rels = []
    for rel in entries:
        path = pkg_dir / rel
        if not path.exists():
            fail(f'files 清单中的 {rel} 不存在 (包内容不完整)')
        rels.append(rel.rstrip('/'))
    # npm 始终强制包含 package.json, 但它在打包时单独写入 (见 stage_npm_tarball)
    return rels


def stage_npm_tarball(args):
    """把当前工程打包成 npm 包 (package.json 版本号替换为发布版本)。
    返回 (version, manifest, tarball bytes); 临时文件用完即清。"""
    pkg_dir = REPO_ROOT
    manifest = json.loads((pkg_dir / 'package.json').read_text())
    if manifest.get('private'):
        fail('package.json 标记 private, 不允许发布')
    if manifest.get('name') != PKG_NAME:
        fail(f'包名 {manifest.get("name")} 与 {PKG_NAME} 不符')
    # foundry-local 用 -carizon 后缀 (如 2.0.1-carizon); 这里沿用同一约定
    version = args.version or f'{manifest["version"]}-carizon'

    rels = collect_files(pkg_dir, manifest)

    with tempfile.TemporaryDirectory(prefix='publish-npm-') as tmp:
        workdir = Path(tmp)
        manifest['version'] = version
        (workdir / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
        repacked = workdir / tarball_basename(version)
        with tarfile.open(repacked, 'w:gz') as tar:
            tar.add(workdir / 'package.json', arcname='package/package.json')
            for rel in rels:
                tar.add(pkg_dir / rel, arcname=f'package/{rel}')
        return version, manifest, rels, repacked.read_bytes()


def publish_npm(args):
    version, manifest, rels, raw = stage_npm_tarball(args)
    tarball_name = tarball_basename(version)

    base = args.registry if args.registry.endswith('/') else args.registry + '/'
    pkg_url = base + quote(PKG_NAME, safe='')

    # 认证交互前打印打包清单: 打包来源 + 推送目标 (dry-run 到此为止)
    print('推送计划:')
    print(f'  {PKG_NAME} {version} ({len(raw) / 1e6:.1f} MB)')
    print(f'    打包来源: 当前工程 (package.json files: {", ".join(rels)})')
    print(f'    推送目标: {pkg_url} (dist-tag: {args.tag})')
    if args.dry_run:
        print(f'  [dry-run] 仅打包, 不推送。tarball: {tarball_name}')
        return

    username, password = login()
    token = base64.b64encode(f'{username}:{password}'.encode('utf-8')).decode('ascii')

    # 查整包: 404 = 不存在; 401/其余错误直接失败, 不当成"不存在"往下走。
    # 只处理与目标版本冲突的: packument 在但目标版本不在 → 不删任何东西直接发;
    # 目标版本存在 → 摘除该版本并删其 tarball (npm unpublish 单版本路径),
    # 其余版本与 dist-tag 原样保留。
    status, data = request('GET', f'{pkg_url}?write=true', token)
    old_tarball = None
    if status == 200:
        packument = json.loads(data)
        rev = packument.get('_rev')
        entry = packument.get('versions', {}).get(version)
        if entry:
            if not rev:
                fail('packument 缺 _rev, 无法删除该版本')
            old_tarball = entry.get('dist', {}).get('tarball')
            print(f'jfrog 已存在 {PKG_NAME}@{version}, 摘除该版本后重推 (其余版本保留)')
            del packument['versions'][version]
            for tag, tv in list(packument.get('dist-tags', {}).items()):
                if tv == version:
                    del packument['dist-tags'][tag]
            packument.pop('_revisions', None)
            packument.pop('_attachments', None)
            s2, d2 = request('PUT', f'{pkg_url}/-rev/{rev}', token,
                             body=json.dumps(packument, separators=(',', ':')).encode('utf-8'))
            expect(s2, (200, 201), '从 packument 摘除旧版本', d2)
            # 第二步: 删旧 tarball 本体 (libnpmpublish 单版本 unpublish 同款)
            s3, d3 = request('GET', f'{pkg_url}?write=true', token)
            expect(s3, (200,), '刷新 packument', d3)
            rev2 = json.loads(d3).get('_rev')
            if not rev2:
                fail('刷新 packument 后缺 _rev, 无法删除旧 tarball')
            rel = urlparse(old_tarball).path
            reg_path = urlparse(base).path
            if rel.startswith(reg_path):
                rel = rel[len(reg_path):]
            s4, d4 = request('DELETE', f'{base}{rel}/-rev/{rev2}', token)
            expect(s4, (200, 202, 204), '删除旧 tarball', d4)
            print('已删除旧版本 tarball')
        else:
            print(f'jfrog 无 {PKG_NAME}@{version}, 直接推送')
    elif status != 404:
        expect(status, (200,), 'GET packument', data)

    # 构建 publish metadata, 字段与 libnpmpublish buildMetadata 同构。
    manifest['_id'] = f'{PKG_NAME}@{version}'
    manifest['dist'] = {
        'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode('ascii'),
        'shasum': hashlib.sha1(raw).hexdigest(),
        # npm 同款处理: registry 为 https 时 npm 实际总走 https 拉 tarball
        'tarball': f'{base}{PKG_NAME}/-/{tarball_name}'.replace('https://', 'http://'),
    }
    root = {
        '_id': PKG_NAME,
        'name': PKG_NAME,
        'description': manifest.get('description'),
        'dist-tags': {args.tag: version},
        'versions': {version: manifest},
        'access': None,
        '_attachments': {
            tarball_name: {
                'content_type': 'application/octet-stream',
                'data': base64.b64encode(raw).decode('ascii'),
                'length': len(raw),
            },
        },
    }
    status, data = request('PUT', pkg_url, token,
                           body=json.dumps(root, separators=(',', ':')).encode('utf-8'))
    expect(status, (200, 201), 'publish', data)
    print(f'已推送 {PKG_NAME}@{version} (dist-tag: {args.tag})')


def main():
    parser = argparse.ArgumentParser(description='jfrog 发布工具 (npm 包发布)')
    sub = parser.add_subparsers(dest='command', required=True)

    p_npm = sub.add_parser('npm', help='打包当前工程并推送到 jfrog vscode')
    p_npm.add_argument('--version', default=None, help='推送版本, 缺省 <package.json 版本>-carizon')
    p_npm.add_argument('--registry', default=DEFAULT_REGISTRY)
    p_npm.add_argument('--tag', default=DEFAULT_TAG, help='npm dist-tag')
    p_npm.add_argument('--dry-run', action='store_true', help='只打包并打印清单, 不推送')

    args = parser.parse_args()
    if args.command == 'npm':
        publish_npm(args)
    else:
        fail(f'未知子命令: {args.command}')


if __name__ == '__main__':
    main()
