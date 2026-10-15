#!/usr/bin/env node
'use strict';
// Local preflight by default. --execute is required to call the official SDK.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = require('./asset-inventory.cjs');

function fail(message) { throw new Error(message); }
function readJson(file, label) {
  if (!fs.existsSync(file)) fail(label + ' missing; see docs/11-wechat.md');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(label + ' is not valid JSON'); }
}
function parse(args) {
  const action = args.shift();
  if (!['preview', 'upload'].includes(action)) fail('Usage: preview|upload --env test|production --config FILE [--mock] [--execute]');
  const options = {action, env:null, config:null, execute:false, mock:false};
  while (args.length) {
    const key = args.shift();
    if (key === '--mock') { options.mock = true; continue; }
    if (key === '--execute') { options.execute = true; continue; }
    if (!['--env', '--config'].includes(key)) fail('Unknown argument');
    const value = args.shift();
    if (!value || value.startsWith('--')) fail('Missing argument value');
    options[key.slice(2)] = value;
  }
  if (!['test','production'].includes(options.env)) fail('Explicit --env test|production required');
  if (options.mock && (action!=='preview' || options.env!=='test')) fail('Mock mode is only allowed for test preview');
  if (!options.config) fail('Explicit --config required');
  return options;
}
function contained(parent, child) {
  const relative=path.relative(parent,child);
  return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));
}
function preflight(options) {
  const configPath=path.resolve(root, options.config);
  const config=readJson(configPath,'Local configuration');
  if (!/^wx[a-zA-Z0-9]{16}$/.test(config.appId || '')) fail('Set the real mini-program AppID; do not use an official-account AppID');
  const selected=config.environments && config.environments[options.env];
  if (!options.mock && (!selected || typeof selected.envId!=='string' || !selected.envId.trim())) fail('Set the selected real cloud EnvId');
  if (config.environments.test && config.environments.production &&
      config.environments.test.envId && config.environments.test.envId===config.environments.production.envId) {
    fail('Test and production EnvId must differ');
  }
  if (typeof config.version!=='string' || !config.version.trim()) fail('Set a build version');
  if (!Number.isInteger(config.robot) || config.robot < 1) fail('robot must be a positive integer supported by your CI version');
  if (typeof config.projectPath!=='string' || !config.projectPath.trim()) fail('Set projectPath');
  const projectPath=path.resolve(root,config.projectPath);
  if (!fs.existsSync(projectPath)) fail('Native project absent; this handoff is not an implemented mini program');
  if (!contained(root,fs.realpathSync(projectPath))) fail('Project must be inside this repository');
  assets.inventory(projectPath);
  const wxProject=readJson(path.join(projectPath,'project.config.json'),'project.config.json');
  if (wxProject.appid!==config.appId) fail('project.config.json AppID differs');
  if (wxProject.miniprogramRoot && wxProject.miniprogramRoot!=='./' && wxProject.miniprogramRoot!=='.') fail('For this wrapper projectPath must itself contain app.js/app.json; set miniprogramRoot to ./');
  const app=readJson(path.join(projectPath,'app.json'),'app.json');
  if (!Array.isArray(app.pages) || !app.pages.length) fail('app.json must have implemented pages');
  if (!fs.existsSync(path.join(projectPath,'app.js'))) fail('Compiled app.js missing; build TypeScript first');
  for (const page of app.pages) {
    if (typeof page!=='string' || page.includes('..') || path.isAbsolute(page)) fail('Invalid page path');
    for (const ext of ['.js','.wxml']) {
      if (!fs.existsSync(path.join(projectPath,page+ext))) fail('A declared page is missing compiled JS/WXML');
    }
  }
  const meta=readJson(path.join(projectPath,'build-meta.json'),'build-meta.json');
  const expectedEnvId=options.mock ? '' : selected.envId;
  if (meta.appId!==config.appId || meta.envId!==expectedEnvId || meta.target!==options.env || meta.version!==config.version) fail('Build metadata differs from selected AppID/EnvId/target/version; rebuild');
  const runtime=readJson(path.join(projectPath,'runtime-config.json'),'runtime-config.json');
  const expectedMode=options.mock ? 'mock' : 'cloud';
  if (runtime.mode!==expectedMode || meta.mode!==expectedMode || runtime.appId!==meta.appId || runtime.envId!==meta.envId || runtime.target!==meta.target || runtime.version!==meta.version) fail('Runtime configuration differs from the selected cloud build; rebuild');
  assets.verify(projectPath,meta);
  if (typeof config.privateKeyPath!=='string' || !path.isAbsolute(config.privateKeyPath)) fail('privateKeyPath must be an absolute path outside this repository');
  const keyPath=path.resolve(config.privateKeyPath);
  const checkedKey=fs.existsSync(keyPath) ? fs.realpathSync(keyPath) : keyPath;
  if (contained(root,checkedKey)) fail('Keep upload private key outside the repository');
  if (options.execute) {
    if (!fs.existsSync(keyPath) || !fs.statSync(keyPath).isFile()) fail('Upload key file is not available');
    if (process.platform!=='win32' && (fs.statSync(keyPath).mode & 0o077)) fail('Upload key permissions too broad; restrict to execution user');
    if (!config.actualEgressIp) fail('Record actual egress IP and verify whitelist before execution');
  }
  return {config,projectPath,keyPath,selected:{envId:expectedEnvId}};
}
async function main() {
  const options=parse(process.argv.slice(2));
  const p=preflight(options);
  console.log(JSON.stringify({
    mode:options.execute?'EXECUTE':'DRY_RUN', action:options.action, target:options.env,
    appId:p.config.appId, envId:p.selected.envId, version:p.config.version,
    privateKeyContentRead:false, platformAuthorizationVerified:false
  },null,2));
  if (!options.execute) {
    console.log('PASS local preflight only. No key read, SDK loaded, upload or cloud call performed.');
    return;
  }
  let ci;
  try { ci=require(require.resolve('miniprogram-ci',{paths:[root,path.join(root,'work/wechat-ci')]})); }
  catch { fail('Install and pin official miniprogram-ci locally, then retry'); }
  const project=new ci.Project({
    appid:p.config.appId,type:'miniProgram',projectPath:p.projectPath,
    privateKeyPath:p.keyPath,ignores:assets.SDK_IGNORES
  });
  const common={
    project,version:p.config.version,desc:p.config.description || 'OR ADV',
    robot:p.config.robot,setting:{es6:true,es7:true,minify:true,autoPrefixWXSS:true},
    onProgress:()=>{}
  };
  if (options.action==='preview') {
    const output=path.resolve(root,p.config.outputPath || 'work/ci-output');
    if (!contained(root,output)) fail('Preview output must stay inside repository');
    const safeOutput=assets.safeOutputDirectory(root,output);
    const qrcode=path.join(safeOutput,'preview-'+options.env+'.png');
    if (fs.existsSync(qrcode) && fs.lstatSync(qrcode).isSymbolicLink()) fail('Preview output cannot be a symbolic link');
    await ci.preview({...common,qrcodeFormat:'image',qrcodeOutputDest:qrcode});
    console.log('Preview created. This is not code review or public release.');
  } else {
    await ci.upload(common);
    console.log('Development version uploaded. Select experience version or submit review in the official console as appropriate.');
  }
}
if (require.main===module) {
  // miniprogram-ci may retain worker/timer handles after its promise settles.
  // Drain our final output, then terminate this one-shot CLI deterministically.
  const finish=(code)=>process.stdout.write('',()=>process.stderr.write('',()=>process.exit(code)));
  main().then(()=>finish(0),error=>{
    // Do not dump raw SDK errors, request bodies, key paths or credentials.
    const safe=error && error.message;
    const own=[
      'Mock mode','Usage:','Unknown argument','Missing argument','Explicit ','Local configuration','Set ',
      'Test and production','robot ','Native project','Project must','project.config.json',
      'For this wrapper','app.json','Compiled ','Runtime configuration','runtime-config.json','A declared page','Invalid page','build-meta.json',
      'Build metadata','privateKeyPath','Keep upload','Upload key','Record actual','Install and pin',
      'Preview output','Asset inventory:'
    ];
    console.error(own.some(prefix=>String(safe).startsWith(prefix)) ? safe : 'Official CI execution failed; check SDK compatibility, account access, key, network and IP whitelist. Raw error suppressed.');
    finish(2);
  });
}
module.exports={parse,preflight};
