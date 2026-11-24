#!/usr/bin/env python3
"""Install and operate an independent Orca server on a managed Hermes Linux host."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

DATA = Path('/opt/data')
ROOT = DATA / 'orcahermes'
SCAN = Path('/run/hermes-service')
HOOK = DATA / 'hooks/orcahermes-onboard'
CONTROL = ROOT / 'orcahermes.py'
S6 = Path('/command')
ORCA = ROOT / 'bin/orca-ide'
CODEX = ROOT / 'bin/codex'
TAILSCALE = ROOT / 'bin/tailscale'
SOCKET = ROOT / 'tailscale.sock'
PORT = 16768
TAG = 'tag:orcahermes'
OWNER = 'orcahermes-onboard-v1'
SERVICES = ('orcahermes-tailscale', 'orcahermes')
HTTP_BACKEND = f'http://127.0.0.1:{PORT}'
SERVE_ARGS = ['serve', '--bind', '127.0.0.1', '--port', str(PORT), '--refuse-public']

# Official release digests. Pin the set so reruns can complete without performing upgrades.
ORCA_VERSION = '1.4.273'
CODEX_VERSION = '0.172.0'
TAILSCALE_VERSION = '1.104.7'
ARCHIVES = {
    'x86_64': ('x64', 'amd64',
               'be4e205696d0387677a17629f9c20ae1f432206eb1c4e2864d216e9cc3331d35',
               'a2342a8f7f68f088be30620ccfe9cb84162c93a6b56177855961cda3ed6be392',
               'e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c'),
    'aarch64': ('arm64', 'arm64',
                '5b2b10da6851db7f815422b2147eb369754567b336273edc7971643458a31a58',
                '0b99526c185a4425fe96a2214fb7b6a6a7f7c1471883b7afbebe97e15e83e79e',
                'd6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484'),
}


def run(command, **options):
    return subprocess.run(command, check=True, **options)


def s6(command, *args):
    return run([S6 / command, *args], timeout=40)


@contextlib.contextmanager
def lock(path):
    with path.open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        yield


def has_owner(directory):
    marker = directory / '.owner'
    return not directory.is_symlink() and marker.is_file() and marker.read_text().strip() == OWNER


def check_slot(directory):
    if (directory.exists() or directory.is_symlink()) and not has_owner(directory):
        raise RuntimeError(f'{directory} is already in use by another installation.')


def write(path, contents, mode=0o600):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as pending:
        candidate = Path(pending.name)
        pending.write(contents.encode())
    try:
        candidate.chmod(mode)
        candidate.replace(path)
    finally:
        candidate.unlink(missing_ok=True)


def download_release(url, digest, expected, destination):
    if destination.is_dir():
        return
    with tempfile.TemporaryDirectory(dir=ROOT / 'releases') as pending:
        stage = Path(pending)
        archive = stage / 'release.tar.gz'
        run(['curl', '--proto', '=https', '-fsSL', '--retry', '2', '--max-time', '180',
             '--output', archive, url])
        with archive.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                raise RuntimeError(f'SHA-256 check failed for {url}')
        contents = stage / 'contents'
        contents.mkdir()
        with tarfile.open(archive, 'r:gz') as bundle:
            bundle.extractall(contents, filter='data')
        (contents / expected if expected else contents).rename(destination)


def install_releases():
    orca_arch, tail_arch, orca_hash, codex_hash, tail_hash = ARCHIVES[platform.machine()]
    orca_release = f'orca-server-{ORCA_VERSION}-linux-{orca_arch}'
    tail_release = f'tailscale_{TAILSCALE_VERSION}_{tail_arch}'
    codex_release = f'codex-{CODEX_VERSION}'
    codex_binary = f'codex-{platform.machine()}-unknown-linux-musl'
    releases = ROOT / 'releases'
    download_release(f'https://github.com/stablyai/orca/releases/download/v{ORCA_VERSION}/'
                     f'orca-server-linux-{orca_arch}.tar.gz', orca_hash, orca_release,
                     releases / orca_release)
    download_release(f'https://pkgs.tailscale.com/stable/{tail_release}.tgz', tail_hash,
                     tail_release, releases / tail_release)
    download_release(f'https://github.com/openai/codex/releases/download/rust-v{CODEX_VERSION}/'
                     f'{codex_binary}.tar.gz', codex_hash, None, releases / codex_release)
    for name, target in {
        'orca-ide': releases / orca_release / 'bin/orca-ide',
        'tailscale': releases / tail_release / 'tailscale',
        'tailscaled': releases / tail_release / 'tailscaled',
        'codex': releases / codex_release / codex_binary,
    }.items():
        link = ROOT / 'bin' / name
        if not os.access(target, os.X_OK):
            raise RuntimeError(f'Verified archive did not provide executable {target.name}.')
        if not link.is_symlink():
            link.symlink_to(target)


def isolated_env():
    return {'HOME': str(ROOT / 'home'), 'PATH': f'{ROOT}/bin:/usr/local/bin:/usr/bin:/bin',
            'SHELL': '/bin/bash', 'USER': ROOT.owner(), 'LOGNAME': ROOT.owner()}


def configure():
    python = shlex.quote(sys.executable)
    ctl = shlex.quote(str(CONTROL))
    write(CONTROL, Path(__file__).read_text())
    profile = ROOT / 'home'
    for file, contents in {
        '.bashrc': 'export PATH="/opt/data/orcahermes/bin:$PATH"\n',
        '.bash_profile': '. "$HOME/.bashrc"\n',
    }.items():
        if not (profile / file).exists():
            write(profile / file, contents)
    for name, role in zip(SERVICES, ('_tailscaled', '_serve')):
        service = ROOT / 'services' / name
        service.mkdir(exist_ok=True)
        write(service / 'run', f'#!/bin/sh\nexec 2>&1\nexec {python} {ctl} {role}\n', 0o700)
        logs = ROOT / 'logs' / name
        logs.mkdir(exist_ok=True)
        write(service / 'log-run', f'#!/bin/sh\nexec /command/s6-log t s65536 n5 {logs}\n', 0o700)
    service = ROOT / 'services/orcahermes'
    write(service / 'timeout-finish', '6500\n')
    write(service / 'finish', '''#!/bin/sh
if read -r group < supervise/orca-group; then
  rm -f supervise/orca-group
  case "$group" in ''|*[!0-9]*|0|1) exit 125 ;; esac
  /bin/kill -TERM -- "-$group" 2>/dev/null || true
  for delay in 1 2 3; do
    /bin/kill -0 -- "-$group" 2>/dev/null || break
    sleep 1
  done
  /bin/kill -KILL -- "-$group" 2>/dev/null || true
fi
case "$1" in
  256) sleep 2 ;;
  *) exit 125 ;;
esac
''', 0o700)
    hook = DATA / 'hooks'
    hook.mkdir(exist_ok=True)
    if not HOOK.exists():
        with tempfile.TemporaryDirectory(prefix='.orcahermes-', dir=hook) as pending:
            staged = Path(pending) / 'hook'
            staged.mkdir()
            write(staged / '.owner', OWNER + '\n')
            write(staged / 'HOOK.yaml', 'name: orcahermes-onboard\n'
                  'description: Start the OrcaHermes services\nevents:\n  - gateway:startup\n')
            write(staged / 'handler.py', f'''import subprocess

def handle(event_type, context):
    if event_type == 'gateway:startup':
        subprocess.run([{sys.executable!r}, {str(CONTROL)!r}, '_register'], check=True, timeout=40)
''')
            staged.rename(HOOK)


def register():
    with lock(ROOT / '.registration.lock'):
        for name in SERVICES:
            check_slot(SCAN / name)
        for name in SERVICES:
            slot = SCAN / name
            if slot.exists():
                continue
            scripts = ROOT / 'services' / name
            with tempfile.TemporaryDirectory(prefix='.orcahermes-', dir=SCAN) as pending:
                staged = Path(pending) / name
                (staged / 'log').mkdir(parents=True)
                for file in ('run', 'finish', 'timeout-finish'):
                    if (scripts / file).is_file():
                        (staged / file).symlink_to(scripts / file)
                (staged / 'log/run').symlink_to(scripts / 'log-run')
                write(staged / '.owner', OWNER + '\n')
                staged.rename(slot)
        s6('s6-svscanctl', '-a', SCAN)


def install():
    if not DATA.is_mount() or not os.access(DATA, os.W_OK):
        raise RuntimeError('Run this on a Hermes host with a writable persistent /opt/data mount.')
    if not SCAN.is_dir() or not os.access(SCAN, os.W_OK):
        raise RuntimeError('This installer needs the writable Hermes s6 service tree at /run/hermes-service.')
    if not shutil.which('curl') or not Path('/bin/bash').is_file():
        raise RuntimeError('Install curl and Bash on the host first.')
    for name in ('s6-svscanctl', 's6-svstat', 's6-svc', 's6-log'):
        if not os.access(S6 / name, os.X_OK):
            raise RuntimeError(f'This host does not have {S6 / name}.')
    with lock(DATA / '.orcahermes-install.lock'):
        for slot in (ROOT, HOOK, *(SCAN / name for name in SERVICES)):
            check_slot(slot)
        s6('s6-svscanctl', '-a', SCAN)
        if not ROOT.exists():
            with tempfile.TemporaryDirectory(prefix='.orcahermes-', dir=DATA) as pending:
                staged = Path(pending) / 'install'
                staged.mkdir()
                write(staged / '.owner', OWNER + '\n')
                staged.rename(ROOT)
        for folder in ('bin', 'home', 'logs', 'releases', 'services', 'workspaces', 'tailscale'):
            (ROOT / folder).mkdir(exist_ok=True)
        install_releases()
        configure()
        register()
    print(f'Installed Orca {ORCA_VERSION}, Tailscale {TAILSCALE_VERSION}, and Codex {CODEX_VERSION}.')
    print(f'Next, run: python3 {CONTROL} network YOUR-TAILNET-NAME')


def run_service(role):
    if role == '_serve':
        (Path.cwd() / 'supervise/orca-group').write_text(f'{os.getpid()}\n')
        os.chdir(ROOT / 'workspaces')
        os.execve(ORCA, [ORCA, *SERVE_ARGS, '--supervise', '--no-pairing'], isolated_env())
    binary = ROOT / 'bin/tailscaled'
    os.execv(binary, [binary, '--tun=userspace-networking', f'--statedir={ROOT}/tailscale',
                      f'--socket={SOCKET}', '--port=0'])


def tailscale(*args, **options):
    return run([TAILSCALE, '--socket', SOCKET, *args], **options)


def endpoint():
    status = json.loads(tailscale('status', '--json', capture_output=True, timeout=10).stdout)
    node = status.get('Self') or {}
    hostname = node.get('DNSName', '').rstrip('.')
    if status.get('BackendState') != 'Running' or not hostname.endswith('.ts.net'):
        raise RuntimeError('Join a tailnet with MagicDNS before pairing.')
    if node.get('Tags') != [TAG]:
        raise RuntimeError(f'Assign this device only {TAG} in your Tailscale admin console.')
    return f'wss://{hostname}:{PORT}'


def network(name):
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', name):
        raise RuntimeError('Choose a tailnet name using lowercase letters, numbers, and hyphens.')
    wait_orca()
    # Keep inbound traffic closed during enrollment and certificate setup. The tailnet owner
    # configures the dedicated port grant before running this command.
    tailscale('up', '--hostname', name, f'--advertise-tags={TAG}', '--shields-up=true',
              '--accept-dns=false', '--accept-routes=false', '--timeout=90s', timeout=100)
    address = endpoint()
    tailscale('serve', '--bg', f'--https={PORT}', HTTP_BACKEND, timeout=40)
    verify_private_route(address)
    tailscale('set', '--shields-up=false', timeout=10)
    print(f'Private Orca endpoint {address}')
    print(f'Next, run: python3 {CONTROL} pair')


def wait_orca():
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            reply = subprocess.run([ORCA, 'repo', 'list', '--json'], env=isolated_env(),
                                   capture_output=True, timeout=12)
            if reply.returncode == 0 and json.loads(reply.stdout).get('ok'):
                return
        except (subprocess.TimeoutExpired, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError(f'Orca did not become ready. Check {ROOT}/logs/orcahermes/current.')


def read_offer(process):
    deadline = time.monotonic() + 240
    line_buffer = b''
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline and ready.select(max(0, deadline - time.monotonic())):
            data = os.read(process.stdout.fileno(), 65536)
            if not data:
                break
            line_buffer += data
            while b'\n' in line_buffer:
                line, line_buffer = line_buffer.split(b'\n', 1)
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict) and message.get('type') == 'orca_server_ready':
                    offer = message.get('pairing', {})
                    if offer.get('available') and offer.get('url', '').startswith('orca://pair?'):
                        return offer['url']
                    raise RuntimeError(f'Orca could not generate an offer ({offer.get("reason")}).')
    raise RuntimeError(f'No pairing offer was produced. Check {ROOT}/logs/pairing.log.')


def verify_private_route(address):
    config = json.loads(tailscale('serve', 'status', '--json', capture_output=True, timeout=10).stdout)
    host = address.removeprefix('wss://')
    listener = config.get('TCP', {}).get(str(PORT), {})
    proxy = config.get('Web', {}).get(host, {}).get('Handlers', {}).get('/', {}).get('Proxy')
    if not listener.get('HTTPS') or proxy != HTTP_BACKEND:
        raise RuntimeError(f'The private TLS route is missing. Run python3 {CONTROL} network HOSTNAME.')
    if config.get('AllowFunnel', {}).get(host):
        raise RuntimeError('Turn off Tailscale Funnel on this listener before enabling access.')


def pair():
    address = endpoint()
    verify_private_route(address)
    service = SCAN / 'orcahermes'
    with lock(ROOT / '.pairing.lock'):
        check_slot(service)
        try:
            s6('s6-svc', '-wD', '-T', '35000', '-d', service)
            with (ROOT / 'logs/pairing.log').open('w') as errors:
                process = subprocess.Popen([ORCA, *SERVE_ARGS, '--pairing-address', address, '--json'],
                                           env=isolated_env(), cwd=ROOT / 'workspaces',
                                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=errors, start_new_session=True)
                try:
                    offer = read_offer(process)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=5)
                    process.stdout.close()
        finally:
            s6('s6-svc', '-u', service)
        wait_orca()
    print('Paste this private link into Orca’s Add Server dialog on your device.')
    print(offer)


def status():
    for name in SERVICES:
        print(name, flush=True)
        s6('s6-svstat', SCAN / name)
    wait_orca()
    print('Local Orca project RPC passed.')
    address = endpoint()
    verify_private_route(address)
    print(f'Private endpoint {address}')


def main():
    if sys.version_info < (3, 12) or platform.system() != 'Linux' or platform.machine() not in ARCHIVES:
        raise RuntimeError('Use Python 3.12 or newer on Linux x86-64 or arm64.')
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'network', 'pair', 'codex', 'status',
                                            '_register', '_serve', '_tailscaled'])
    parser.add_argument('name', nargs='?', help='unique Tailscale hostname for the network command')
    args = parser.parse_args()
    if args.command == 'install':
        install()
        return
    if not has_owner(ROOT):
        raise RuntimeError('Run install on this Hermes host before using this command.')
    if args.command == 'network':
        if args.name is None:
            parser.error('network requires a unique hostname')
        network(args.name)
        return
    if args.command == 'codex':
        os.execve(CODEX, [CODEX, 'login', '--device-auth'], isolated_env())
    if args.command in ('_serve', '_tailscaled'):
        run_service(args.command)
        return
    {'pair': pair, 'status': status, '_register': register}[args.command]()


def interrupted(signum, frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print('OrcaHermes setup interrupted.', file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f'OrcaHermes setup: {error}', file=sys.stderr)
        sys.exit(1)
