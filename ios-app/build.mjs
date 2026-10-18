#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hubOrigin} from '../lib/community-origin.mjs';
import {prepareSourcePackage} from './source-package.mjs';
const hubUrl=hubOrigin(process.env.TEAMROOM_HUB_URL);

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const cache = path.join(root, '.build-cache');
const simulator = process.argv.includes('--simulator');
const archiveOnly = process.argv.includes('--archive-only');
const signed = process.argv.includes('--signed');
const team = process.env.TEAMROOM_APPLE_TEAM;
const version = process.env.TEAMROOM_IOS_VERSION || '1.0.0';
const build = process.env.TEAMROOM_IOS_BUILD || '1';
const bundleId = process.env.TEAMROOM_IOS_BUNDLE_ID || 'io.teamroom.community.ios';
if (process.platform !== 'darwin') throw new Error('Для сборки iOS нужен Mac с Xcode.');
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+$/.test(build) || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Неверная версия, номер сборки или bundle ID.');
if (signed && !/^[A-Z0-9]{10}$/.test(team || '')) throw new Error('Для подписанной сборки укажи TEAMROOM_APPLE_TEAM. Вход и подпись должны быть заранее настроены в Xcode.');
await fs.mkdir(dist, {recursive:true}); await fs.mkdir(cache, {recursive:true});

async function run(command,args,logName) {
  const log = await fs.open(path.join(dist, logName), 'w', 0o600);
  try {
    const status = await new Promise((resolve,reject) => {
      const child = spawn(command,args,{cwd:root,stdio:['ignore',log.fd,log.fd]});
      child.on('error',reject); child.on('close',resolve);
    });
    if(status !== 0) {
      const text = await fs.readFile(path.join(dist,logName),'utf8');
      throw new Error(`${path.basename(command)}: ${text.slice(-9000)}`);
    }
  } finally { await log.close(); }
}
console.log('Готовлю значок Team Room…');
await run('/usr/bin/xcrun',['swift','-module-cache-path',path.join(cache,'icon-modules'),path.join(root,'resources/IconRenderer.swift'),path.join(root,'resources/Assets.xcassets/AppIcon.appiconset')],'icons.log');
const archive = path.join(dist, `Team-Room-${version}-iOS${signed?'':'-unsigned'}.xcarchive`);
const derived = path.join(cache, simulator?'simulator':'device');
const configuredInfo=path.join(cache,'Info.configured.plist');
const escaped=hubUrl.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
await fs.writeFile(configuredInfo,(await fs.readFile(path.join(root,'resources/Info.plist'),'utf8')).replaceAll('__HUB_URL__',escaped));
const args = ['-project',path.join(root,'TeamRoom.xcodeproj'),'-scheme','TeamRoomiOS','-configuration','Release',
  '-destination',simulator?'generic/platform=iOS Simulator':'generic/platform=iOS','-derivedDataPath',derived,
  'MARKETING_VERSION='+version,'CURRENT_PROJECT_VERSION='+build,'PRODUCT_BUNDLE_IDENTIFIER='+bundleId,'INFOPLIST_FILE='+configuredInfo];
if (!signed || simulator) args.push('CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO');
else args.push('DEVELOPMENT_TEAM='+team);
if (!simulator) args.push('-archivePath',archive,'archive'); else args.push('build');
console.log(simulator?'Собираю версию для симулятора…':signed?'Собираю подписанный архив iOS…':'Собираю архив iOS без подписи Apple…');
await run('/usr/bin/xcodebuild',args,simulator?'simulator-build.log':'device-build.log');
const artifact = simulator?path.join(derived,'Build/Products/Release-iphonesimulator/Team Room Community.app'):archive;
if (signed && !simulator) await run('/usr/bin/codesign',['--verify','--strict',path.join(archive,'Products/Applications/Team Room Community.app')],'signing.log');
const report = {version,build,bundleId,minimumIOS:'17.0',platform:simulator?'iOS Simulator':'iOS',architectures:simulator?['arm64','x86_64']:['arm64'],
  builtAt:new Date().toISOString(),artifact:path.relative(root,artifact),signed:signed&&!simulator,
  signingRequested:signed&&!simulator,signatureVerified:signed&&!simulator,
  installableOnIPhone:false,installationRequiresXcodeOrExport:!simulator,requiresAppleSigning:!signed&&!simulator,
  testFlightUploaded:false,realIPhoneChecked:false,automatedTestsRun:false,
  subscriptions:'Existing Claude/Codex sessions on selected Mac; no runtimes or API keys on phone'};
await fs.writeFile(path.join(dist,simulator?'simulator-build-report.json':'build-report.json'),JSON.stringify(report,null,2)+'\n');
if (!archiveOnly) {
  const packageRoot = path.join(cache,'source-package'); const packageDir=path.join(packageRoot,'Team Room iOS');
  await fs.rm(packageRoot,{recursive:true,force:true}); await fs.mkdir(packageDir,{recursive:true});
  await prepareSourcePackage(root,packageDir);
  const sourceZip=path.join(dist,`Team-Room-${version}-iOS-Xcode.zip`);
  await fs.rm(sourceZip,{force:true});
  await run('/usr/bin/ditto',['-c','-k','--norsrc','--noextattr','--noqtn','--keepParent',packageDir,sourceZip],'source-package.log');
  const bytes=await fs.readFile(sourceZip);report.sourcePackage={filename:path.basename(sourceZip),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  await fs.writeFile(path.join(dist,simulator?'simulator-build-report.json':'build-report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log('Сборка готова: '+path.relative(root,artifact));
if(!signed&&!simulator) console.log('Этот архив не устанавливается на iPhone без подписи Apple. Исходный проект готов для Xcode.');
