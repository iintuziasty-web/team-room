#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hubOrigin} from '../lib/community-origin.mjs';
const hubUrl=process.env.TEAMROOM_HUB_URL?hubOrigin(process.env.TEAMROOM_HUB_URL):'';
const xml=value=>String(value).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&apos;'}[c]));

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(root);
const resources = path.join(root, 'resources');
const cache = path.join(root, '.build-cache');
const dist = path.join(root, 'dist');
const bundle = path.join(dist, 'Team Room Community.app');
const contents = path.join(bundle, 'Contents');
const bundledResources = path.join(contents, 'Resources');
const architectureOption = process.argv.find(value => value.startsWith('--arch='))?.slice(7);
const architectures = architectureOption ? architectureOption.split(',') : ['arm64', 'x64'];
const skipDMG = process.argv.includes('--no-dmg');
const prepareOnly = process.argv.includes('--prepare');
const identity = process.env.TEAMROOM_SIGN_IDENTITY || '-';
const pins = JSON.parse(await fs.readFile(path.join(resources, 'versions.json'), 'utf8'));
const appPackage = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
const version = process.env.TEAMROOM_APP_VERSION || appPackage.version;
const buildNumber = process.env.TEAMROOM_APP_BUILD || version.replace(/[^0-9.]/g, '');
const buildReport = {hubMode:hubUrl?'custom':'generic',version, build: buildNumber, minimumMacOS: pins.minimumMacOS, architectures,
                     runtime: {node: pins.node, codex: pins.codex, claude: pins.claude},
                     signing: identity === '-' ? 'ad-hoc' : 'Developer ID', notarized: false,
                     downloads: [], artifacts: []};

if (process.platform !== 'darwin') throw new Error('Сборка приложения Mac выполняется на macOS.');
if (!architectures.length || architectures.some(arch => !['arm64', 'x64'].includes(arch)) || new Set(architectures).size !== architectures.length)
  throw new Error('Допустимые архитектуры: --arch=arm64,x64, --arch=arm64 или --arch=x64.');
for (const value of [version, buildNumber, pins.node, pins.codex, pins.claude, pins.minimumMacOS])
  if (!/^\d+(?:\.\d+){1,3}(?:-[\w.]+)?$/.test(value || '')) throw new Error('Неверная версия в настройках сборки.');

async function run(bin, args, options = {}) {
  try {
    return await exec(bin, args, {cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 600000, ...options});
  } catch (error) {
    throw new Error(`${path.basename(bin)}: ${String(error.stderr || error.stdout || error.message).trim().slice(-5000)}`);
  }
}
async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function ensureDir(dir) { await fs.mkdir(dir, {recursive: true, mode: 0o700}); }
async function readJSON(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')); }
async function hashFile(filename, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  const file = await fs.open(filename);
  try { for await (const chunk of file.createReadStream({autoClose: false})) hash.update(chunk); }
  finally { await file.close(); }
  return hash.digest('hex');
}
function officialURL(input, allowedHost) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.username || url.password || url.port)
    throw new Error('Загрузка разрешена только с официального адреса поставщика.');
  return url;
}
async function fetchText(input, host, limit = 1024 * 1024) {
  const response = await fetch(officialURL(input, host), {redirect: 'error', signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Не удалось загрузить ${new URL(input).pathname}: HTTP ${response.status}.`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length; if (total > limit) throw new Error('Ответ сервера превышает допустимый размер.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function download(input, host, filename, expected, algorithm, limit = 800 * 1024 * 1024) {
  officialURL(input, host);
  if (await exists(filename)) {
    if (await hashFile(filename, algorithm) === expected) return filename;
    await fs.rm(filename, {force: true});
  }
  const response = await fetch(input, {redirect: 'error', signal: AbortSignal.timeout(600000)});
  if (!response.ok) throw new Error(`Не удалось загрузить ${new URL(input).pathname}: HTTP ${response.status}.`);
  const temporary = filename + '.' + crypto.randomUUID() + '.part';
  const hash = crypto.createHash(algorithm); let size = 0;
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    for await (const chunk of response.body) {
      size += chunk.length; if (size > limit) throw new Error('Архив превышает допустимый размер.');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const {bytesWritten} = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Не удалось записать официальный архив.');
        offset += bytesWritten;
      }
    }
    if (hash.digest('hex') !== expected) throw new Error('Контрольная сумма официального архива не совпала.');
    await file.sync(); await file.close(); await fs.rename(temporary, filename);
  } catch (error) { await file.close().catch(() => {}); await fs.rm(temporary, {force: true}); throw error; }
  return filename;
}
async function archiveFiles(filename, expectedRoot) {
  const entries = (await run('/usr/bin/tar', ['-tzf', filename])).stdout.split('\n').filter(Boolean);
  if (entries.length > 100000 || entries.some(name => !name.startsWith(expectedRoot + '/') || /[\x00-\x1f\\]/.test(name)
      || name.startsWith('/') || name.split('/').some(part => part === '..'))) throw new Error('В архиве обнаружен небезопасный путь.');
  const detailed = (await run('/usr/bin/tar', ['-tvzf', filename])).stdout.split('\n').filter(Boolean);
  if (detailed.some(line => line[0] === 'l' || line[0] === 'h')) throw new Error('Нативный пакет содержит неожиданные ссылки.');
  return entries;
}
async function prepareNode(arch) {
  const archiveName = `node-v${pins.node}-darwin-${arch}.tar.gz`;
  const prefix = `node-v${pins.node}-darwin-${arch}`;
  const sumsURL = `https://nodejs.org/dist/v${pins.node}/SHASUMS256.txt`;
  const sums = await fetchText(sumsURL, 'nodejs.org');
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archiveName)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Node.js не опубликовал контрольную сумму для нужной архитектуры.');
  const filename = path.join(cache, archiveName);
  await download(`https://nodejs.org/dist/v${pins.node}/${archiveName}`, 'nodejs.org', filename, expected, 'sha256');
  const destination = path.join(cache, prefix);
  await fs.rm(destination, {recursive: true, force: true});
  await run('/usr/bin/tar', ['-xzf', filename, '-C', cache, '--', `${prefix}/bin/node`, `${prefix}/LICENSE`]);
  await fs.chmod(path.join(destination, 'bin', 'node'), 0o755);
  buildReport.downloads.push({product: 'Node.js', version: pins.node, architecture: arch, url: `https://nodejs.org/dist/v${pins.node}/${archiveName}`, sha256: expected});
  return destination;
}
async function preparePackage(name, packageVersion, arch, product) {
  const metadataURL = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${packageVersion}`;
  const metadata = JSON.parse(await fetchText(metadataURL, 'registry.npmjs.org'));
  if (metadata.version !== packageVersion || !metadata.dist?.integrity?.startsWith('sha512-'))
    throw new Error('Официальный пакет не содержит ожидаемой версии и контрольной суммы.');
  const integrity = metadata.dist.integrity.slice(7);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('Неверная контрольная сумма пакета.');
  const expected = Buffer.from(integrity, 'base64').toString('hex');
  if (expected.length !== 128) throw new Error('Неверный размер контрольной суммы пакета.');
  officialURL(metadata.dist.tarball, 'registry.npmjs.org');
  const filename = path.join(cache, `${product}-${packageVersion}-${arch}.tgz`);
  await download(metadata.dist.tarball, 'registry.npmjs.org', filename, expected, 'sha512');
  await archiveFiles(filename, 'package');
  const destination = path.join(cache, `${product}-${packageVersion}-${arch}`);
  await fs.rm(destination, {recursive: true, force: true}); await ensureDir(destination);
  await run('/usr/bin/tar', ['-xzf', filename, '-C', destination]);
  buildReport.downloads.push({product, version: packageVersion, architecture: arch, url: metadata.dist.tarball, sha512: expected});
  return path.join(destination, 'package');
}
async function portableBinary(filename, arch) {
  const expected = arch === 'x64' ? 'x86_64' : arch;
  const actual = (await run('/usr/bin/lipo', ['-archs', filename])).stdout.trim().split(/\s+/);
  if (!actual.includes(expected)) throw new Error(`${path.basename(filename)} не поддерживает ${expected}.`);
  const libraries = (await run('/usr/bin/otool', ['-L', filename])).stdout.split('\n').slice(1).map(line => line.trim().split(' ')[0]).filter(Boolean);
  if (libraries.some(lib => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/Library/')))
    throw new Error(`${path.basename(filename)} зависит от библиотек вне macOS и не может быть перенесён на другой Mac.`);
}
async function bundleRuntime(arch, prepared) {
  const runtime = path.join(bundledResources, 'runtime', arch); const bin = path.join(runtime, 'bin');
  await ensureDir(bin);
  await fs.copyFile(path.join(prepared.node, 'bin', 'node'), path.join(bin, 'node'));
  await fs.copyFile(path.join(prepared.node, 'LICENSE'), path.join(runtime, 'NODE-LICENSE'));
  const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const vendor = path.join(prepared.codex, 'vendor', triple);
  // Preserve the vendor tree relative to bin/codex: native resources and rg resolve beside it.
  await fs.cp(vendor, runtime, {recursive: true, dereference: false});
  await fs.copyFile(path.join(prepared.claude, 'claude'), path.join(bin, 'claude'));
  await fs.copyFile(path.join(prepared.claude, 'LICENSE.md'), path.join(runtime, 'CLAUDE-LICENSE.md'));
  await fs.writeFile(path.join(runtime, 'CODEX-LICENSE-NOTICE.txt'),
    'Codex CLI ' + pins.codex + '\nCopyright OpenAI. Licensed under the Apache License, Version 2.0.\nhttps://github.com/openai/codex/blob/main/LICENSE\n');
  const executableNames = ['node', 'codex', 'claude'];
  for (const executable of executableNames) {
    const filename = path.join(bin, executable); await fs.chmod(filename, 0o755);
    await portableBinary(filename, arch);
  }
  // Keep provider signatures intact. Sign unsigned Node only; its JIT uses the supplied entitlements.
  if (!(await run('/usr/bin/codesign', ['--verify', path.join(bin, 'node')]).then(() => true).catch(() => false)))
    await run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp=none', '--entitlements', path.join(resources, 'runtime-entitlements.plist'), path.join(bin, 'node')]);
}
async function copyConnector() {
  const destination = path.join(bundledResources, 'connect'); await ensureDir(destination);
  const files = ['bridge.mjs', 'teamroom.mjs', 'install-integration.mjs', 'install-background.mjs', 'package.json', 'package-lock.json'];
  for (const filename of files) await fs.copyFile(path.join(project, filename), path.join(destination, filename));
  // The hub and connector have separate versions. The Mac auto-updater must
  // compare the connector's heartbeat with its own bundled program version.
  const connectorVersion = (await fs.readFile(path.join(destination, 'bridge.mjs'), 'utf8')).match(/^const connectorVersion='(\d+\.\d+\.\d+)';$/m)?.[1];
  if (!connectorVersion) throw new Error('Не найдена версия фонового подключения.');
  const connectorPackage = await readJSON(path.join(destination, 'package.json'));
  connectorPackage.version = connectorVersion;
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(connectorPackage, null, 2) + '\n');
  const connectorLock = await readJSON(path.join(destination, 'package-lock.json'));
  connectorLock.version = connectorVersion;
  if (connectorLock.packages?.['']) connectorLock.packages[''].version = connectorVersion;
  await fs.writeFile(path.join(destination, 'package-lock.json'), JSON.stringify(connectorLock, null, 2) + '\n');
  await fs.cp(path.join(project, 'lib'), path.join(destination, 'lib'), {recursive: true});
  const moduleSource = path.join(project, 'node_modules');
  if (!await exists(path.join(moduleSource, 'ws', 'package.json')) || !await exists(path.join(moduleSource, '@modelcontextprotocol', 'sdk', 'package.json')))
    throw new Error('В проекте отсутствуют зависимости подключения. Подготовь зависимости проекта перед сборкой.');
  await fs.cp(moduleSource, path.join(destination, 'node_modules'), {recursive: true, dereference: false,
    filter: filename => !path.relative(moduleSource, filename).split(path.sep).some(part => ['.bin', '.cache', '.git', '@openai', '@anthropic-ai'].includes(part))});
  const desktop = path.join(root, 'connector');
  for (const filename of ['helper.mjs', 'install-background.mjs'])
    if (!await exists(path.join(desktop, filename))) throw new Error('Нативный помощник приложения ещё не подготовлен: ' + filename);
  await fs.cp(desktop, path.join(bundledResources, 'desktop'), {recursive: true});
}
async function verifyPublicBundle() {
  const forbiddenNames = new Set(['storage', 'device-config.json', 'team-data.json', 'local-client.json', 'auth.json', 'credentials.json',
                                  'security-key', 'security-config.json', 'mcp-vault.json', '.mcp-sync', '.skills-sync', 'running-jobs.json', 'pending-results.json']);
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      if (forbiddenNames.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.'))
        throw new Error('В публичной сборке найден приватный файл: ' + entry.name);
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(filename);
        if (target !== bundle && !target.startsWith(bundle + path.sep)) throw new Error('Ссылка внутри приложения выходит за пределы сборки.');
      } else if (entry.isDirectory()) await walk(filename);
    }
  }
  await walk(bundle);
}
async function compile() {
  const sources = (await fs.readdir(path.join(root, 'Sources'))).filter(name => name.endsWith('.swift')).sort().map(name => path.join(root, 'Sources', name));
  if (!sources.length) throw new Error('Исходный код приложения ещё не подготовлен.');
  const sdk = (await run('/usr/bin/xcrun', ['--show-sdk-path'])).stdout.trim();
  const swiftc = (await run('/usr/bin/xcrun', ['--find', 'swiftc'])).stdout.trim();
  const moduleCache = path.join(cache, 'swift-module-cache'); await ensureDir(moduleCache);
  const binaries = [];
  for (const arch of architectures) {
    const output = path.join(cache, `TeamRoom-${arch}`); binaries.push(output);
    await run(swiftc, ['-parse-as-library', '-swift-version', '5', '-O', '-whole-module-optimization', '-sdk', sdk, '-module-cache-path', moduleCache,
      '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx${pins.minimumMacOS}`,
      '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers', '-framework', 'Security',
      ...sources, '-o', output]);
  }
  const executable = path.join(contents, 'MacOS', 'Team Room Community'); await ensureDir(path.dirname(executable));
  if (binaries.length === 1) await fs.copyFile(binaries[0], executable);
  else await run('/usr/bin/lipo', ['-create', ...binaries, '-output', executable]);
  await fs.chmod(executable, 0o755);
  const info = (await fs.readFile(path.join(resources, 'Info.plist'), 'utf8')).replaceAll('__VERSION__', version).replaceAll('__BUILD__', buildNumber).replaceAll('__MINIMUM_MACOS__', pins.minimumMacOS).replaceAll('__HUB_URL__',xml(hubUrl));
  await fs.writeFile(path.join(contents, 'Info.plist'), info); await run('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
  const iconRenderer = path.join(cache, 'IconRenderer');
  await run(swiftc, ['-O', '-sdk', sdk, '-module-cache-path', moduleCache, '-framework', 'AppKit', path.join(resources, 'IconRenderer.swift'), '-o', iconRenderer]);
  const iconset = path.join(cache, 'AppIcon.iconset'); await ensureDir(iconset);
  await run(iconRenderer, [iconset]); await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(bundledResources, 'AppIcon.icns')]);
}
async function packageDistribution() {
  const architectureSuffix = architectures.length === 2 ? 'universal' : architectures[0];
  const basename = `Team-Room-${version}-macOS-${architectureSuffix}`;
  const zip = path.join(dist, basename + '.zip'); await fs.rm(zip, {force: true});
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip]);
  buildReport.artifacts.push({filename: path.basename(zip), bytes: (await fs.stat(zip)).size, sha256: await hashFile(zip)});
  if (!skipDMG) {
    const stage = path.join(cache, 'dmg-stage'); await fs.rm(stage, {recursive: true, force: true}); await ensureDir(stage);
    await fs.cp(bundle, path.join(stage, 'Team Room Community.app'), {recursive: true, dereference: false});
    await fs.symlink('/Applications', path.join(stage, 'Applications'));
    const dmg = path.join(dist, basename + '.dmg'); await fs.rm(dmg, {force: true});
    await run('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Team Room', '-fs', 'HFS+', '-srcfolder', stage, '-format', 'UDZO', dmg]);
    buildReport.artifacts.push({filename: path.basename(dmg), bytes: (await fs.stat(dmg)).size, sha256: await hashFile(dmg)});
    await fs.rm(stage, {recursive: true, force: true});
  }
  await fs.writeFile(path.join(dist, 'build-report.json'), JSON.stringify(buildReport, null, 2) + '\n');
}

await ensureDir(cache); await ensureDir(dist);
console.log('Подготавливаю проверенные официальные компоненты для Mac.');
const prepared = new Map();
for (const arch of architectures) {
  console.log('Компоненты: ' + (arch === 'arm64' ? 'Apple Silicon' : 'Intel') + '.');
  const [node, codex, claude] = await Promise.all([
    prepareNode(arch),
    preparePackage('@openai/codex', `${pins.codex}-darwin-${arch}`, arch, 'codex'),
    preparePackage(`@anthropic-ai/claude-code-darwin-${arch}`, pins.claude, arch, 'claude')
  ]);
  prepared.set(arch, {node, codex, claude});
}
if (prepareOnly) { console.log('Компоненты подготовлены. Приложение ещё не собиралось.'); process.exit(0); }
await fs.rm(bundle, {recursive: true, force: true}); await ensureDir(bundledResources);
console.log('Собираю приложение Team Room.');
await copyConnector();
const updateKey=process.env.TEAMROOM_UPDATE_PUBLIC_KEY;
if(updateKey){const key=await fs.readFile(updateKey,'utf8');crypto.createPublicKey(key);await fs.writeFile(path.join(bundledResources,'desktop','update-public-key.pem'),key);}
const updateChannel=process.env.TEAMROOM_UPDATE_CHANNEL==='off'?'off':updateKey?'private':'community';
await fs.writeFile(path.join(bundledResources,'instance.json'),JSON.stringify({hubUrl:hubUrl||null,updateChannel,updatesEnabled:updateChannel!=='off'}));
for (const arch of architectures) await bundleRuntime(arch, prepared.get(arch));
await compile(); await verifyPublicBundle();
await fs.writeFile(path.join(bundledResources, 'build-info.json'), JSON.stringify({hubMode:hubUrl?'custom':'generic',version, build: buildNumber, architectures, minimumMacOS: pins.minimumMacOS, runtime: buildReport.runtime}, null, 2));
await run('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? ['--timestamp=none'] : ['--options', 'runtime', '--timestamp']), bundle]);
await run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
console.log('Готовлю установочный архив.');
await packageDistribution();
console.log(JSON.stringify({directory: dist, artifacts: buildReport.artifacts, signing: buildReport.signing, notarized: false}, null, 2));
