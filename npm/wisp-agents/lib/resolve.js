// The pure half of the launcher: which platform package holds the binary, where the binary sits
// inside it, and what to say when it is missing. No I/O here, so the tests can cover every
// platform from any machine.

import path from 'node:path';

// <process.platform>-<process.arch> → the Rust triple release builds compile for. Linux builds are
// musl and static, so one package works on glibc and musl distros alike.
export const TARGETS = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-arm': 'armv7-unknown-linux-musleabihf',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
});

export const SCOPE = '@wisp';

export const isSupported = (platform, arch) => Object.hasOwn(TARGETS, `${platform}-${arch}`);

export const packageName = (platform, arch) => `${SCOPE}/core-${platform}-${arch}`;

export const binaryName = (platform) => (platform === 'win32' ? 'wisp.exe' : 'wisp');

// pkgJson: the resolved path of the platform package's package.json.
export const binaryPath = (pkgJson, platform) => path.join(path.dirname(pkgJson), 'bin', binaryName(platform));

export function unsupportedMessage(platform, arch) {
  return [
    `wisp: there is no wisp build for ${platform}-${arch}.`,
    `Supported: ${Object.keys(TARGETS).join(', ')}.`,
    'If you built wisp yourself, point WISP_BINARY at it: WISP_BINARY=/path/to/wisp wisp',
  ].join('\n');
}

export function missingMessage(platform, arch) {
  return [
    `wisp: the wisp binary for ${platform}-${arch} is not installed.`,
    `It ships in the optional package ${packageName(platform, arch)}, which npm skipped.`,
    'Fix: run `npm install -g wisp-agents` again, without --omit=optional or --no-optional,',
    'or set WISP_BINARY to the path of a wisp binary.',
  ].join('\n');
}

// The launcher's whole decision, given what it found: { bin } or { error }.
// resolvePkg(name) returns the package.json path or throws, like require.resolve.
export function locate({ platform, arch, env, resolvePkg }) {
  if (env.WISP_BINARY) return { bin: env.WISP_BINARY };
  if (!isSupported(platform, arch)) return { error: unsupportedMessage(platform, arch) };
  try {
    return { bin: binaryPath(resolvePkg(`${packageName(platform, arch)}/package.json`), platform) };
  } catch {
    return { error: missingMessage(platform, arch) };
  }
}

// WISP_WEB_DIR tells the binary where the web bundle is; an explicit one wins.
export function childEnv(env, webDir, webDirExists) {
  if (env.WISP_WEB_DIR || !webDirExists) return { ...env };
  return { ...env, WISP_WEB_DIR: webDir };
}
