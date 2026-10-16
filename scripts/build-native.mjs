import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The Linux + Windows cross-build requires a Linux x64 build host');
}
const headers = process.env.NODE_INCLUDE_DIR || [
  resolve(dirname(process.execPath), '../include/node'), '/usr/include/node',
].find(path => existsSync(join(path, 'node_api.h')));
if (!headers) throw new Error('Set NODE_INCLUDE_DIR to the directory containing node_api.h');

const linux = join(root, 'build/deps/linux-x64');
const windows = join(root, 'build/deps/win32-x64');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function build(target, buildDir, ssh, ssl, flags = []) {
  const artifacts = join(root, 'prebuilds', target);
  mkdirSync(artifacts, { recursive: true });
  run('cmake', ['-S', 'native', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release',
    ...flags, `-DWOLFSSH_ROOT=${ssh}`, `-DWOLFSSL_ROOT=${ssl}`,
    `-DNODE_INCLUDE_DIR=${headers}`, `-DARTIFACT_DIR=${artifacts}`]);
  run('cmake', ['--build', buildDir, '--parallel']);
}

build('linux-x64', 'build', linux, linux);
build('win32-x64', 'build/windows-x64', windows, windows, [
  '-DCMAKE_SYSTEM_NAME=Windows',
  '-DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++',
  `-DWOLF_WINDOWS_BIN=${join(windows, 'bin')}`,
]);
