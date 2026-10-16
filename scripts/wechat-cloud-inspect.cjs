#!/usr/bin/env node
'use strict';
// Read-only unsupported private adapter: pinned miniprogram-ci 2.1.31 internals.
// Environment listing is supported by the current bridge. No billing, resource setup,
// function, database, storage-rule or business-data operations are exposed here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const assets = require('./asset-inventory.cjs');
const PIN = {
  'dist/common/cloud-api/index.js': '9c48e1fb4ae659a63430c8a930d399becfce92a5b02d44e5fe4a00d8097602cd',
  'dist/ci/cloud/cloudapi.js': '06ab366f28b7d3412a16752b62d704f457ac0838d2196c77dfdf1bfbd4fc5706',
};
class CloudInspectError extends Error {
  constructor(code, stage='preflight') { super(code); this.code=code; this.stage=stage; }
}
function reject(code, stage) { throw new CloudInspectError(code, stage); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function contained(parent, child) {
  const relative=path.relative(parent,child);
  return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));
}
function json(file) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { reject('INVALID_JSON'); }
}
function parse(args) {
  const action=args.shift();
  if (action!=='inspect') reject('INVALID_ACTION');
  const options={action,env:null,config:null,execute:false,appId:null,envId:null};
  const seen=new Set();
  while (args.length) {
    const key=args.shift();
    if (seen.has(key)) reject('DUPLICATE_ARGUMENT');
    seen.add(key);
    if (key==='--execute') { options.execute=true; continue; }
    const names={'--env':'env','--config':'config','--app-id':'appId','--env-id':'envId'};
    if (!names[key]) reject('UNKNOWN_ARGUMENT');
    const value=args.shift();
    if (!value || value.startsWith('--')) reject('MISSING_ARGUMENT');
    options[names[key]]=value;
  }
  if (options.env!=='test' || !options.config) reject('TEST_CONFIG_REQUIRED');
  return options;
}
function loadContext(options) {
  if (options.action!=='inspect' || options.env!=='test' || typeof options.config!=='string') reject('TEST_CONFIG_REQUIRED');
  const config=json(path.resolve(root,options.config));
  if (!config || typeof config!=='object' || Array.isArray(config)) reject('INVALID_TEST_CONFIG');
  const selected=config.environments?.test;
  if (!/^wx[a-zA-Z0-9]{16}$/.test(config.appId||'') || config.clubId!=='oradv' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{3,127}$/.test(selected?.envId||'') || !/^ap-[a-z]+$/.test(selected?.region||'')) reject('INVALID_TEST_TARGET');
  if (selected.envId===config.environments?.production?.envId) reject('PRODUCTION_TARGET_REFUSED');
  if (options.execute && (options.appId!==config.appId || options.envId!==selected.envId)) reject('TARGET_CONFIRMATION_REQUIRED');
  if ((options.appId && options.appId!==config.appId) || (options.envId && options.envId!==selected.envId)) reject('TARGET_MISMATCH');
  if (typeof config.privateKeyPath!=='string' || !path.isAbsolute(config.privateKeyPath) || contained(root,path.resolve(config.privateKeyPath))) reject('EXTERNAL_KEY_REQUIRED');
  if (config.projectPath!=='app/miniprogram') reject('INVALID_PROJECT_PATH');
  return {options,config,selected,projectPath:path.join(root,'app/miniprogram'),keyPath:config.privateKeyPath};
}
function noLinks(target) {
  let current=path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    if (fs.lstatSync(current).isSymbolicLink()) reject('SYMLINK_REFUSED');
  }
}
async function cloudCall(stage, fn) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof CloudInspectError) throw error;
    // Do not include SDK messages/codes: they can embed request bodies and signed credentials.
    const code=/^-1 invalid cloud api action [A-Za-z]+$/.test(String(error?.message||''))?'UNSUPPORTED_CLOUD_ACTION':'CLOUD_CALL_FAILED';
    throw new CloudInspectError(code,stage);
  }
}
async function connect(context) {
  if (!context.options.execute) reject('EXECUTION_REQUIRED');
  return cloudCall('connect',async()=>{
    noLinks(context.keyPath);
    const stat=fs.statSync(context.keyPath);
    if (!stat.isFile() || (stat.mode&0o777)!==0o600) reject('KEY_MODE_600_REQUIRED');
    if (contained(root,fs.realpathSync(context.keyPath))) reject('EXTERNAL_KEY_REQUIRED');
    noLinks(context.projectPath);
    const wx=json(path.join(context.projectPath,'project.config.json'));
    if (wx.appid!==context.config.appId) reject('PROJECT_APPID_MISMATCH');
    let entry;
    try { entry=require.resolve('miniprogram-ci',{paths:[root,path.join(root,'work/wechat-ci')]}); }
    catch { reject('PINNED_SDK_REQUIRED'); }
    let sdkRoot=path.dirname(entry);
    while (!fs.existsSync(path.join(sdkRoot,'package.json'))) {
      const parent=path.dirname(sdkRoot);
      if (parent===sdkRoot) reject('PINNED_SDK_REQUIRED');
      sdkRoot=parent;
    }
    const pkg=json(path.join(sdkRoot,'package.json'));
    if (pkg.name!=='miniprogram-ci' || pkg.version!=='2.1.31') reject('PINNED_SDK_REQUIRED');
    for (const [name,digest] of Object.entries(PIN)) if (hash(fs.readFileSync(path.join(sdkRoot,name)))!==digest) reject('SDK_ADAPTER_HASH_MISMATCH');
    const ci=require(entry);
    const api=require(path.join(sdkRoot,'dist/common/cloud-api/index.js'));
    const bridge=require(path.join(sdkRoot,'dist/ci/cloud/cloudapi.js'));
    const project=new ci.Project({appid:context.config.appId,type:'miniProgram',projectPath:context.projectPath,privateKeyPath:context.keyPath,ignores:assets.SDK_IGNORES});
    bridge.initCloudAPI(context.config.appId);
    api.setRequest(bridge.boundTransactRequest(project));
    api.setTransactType(api.TransactType.IDE);
    const request=bridge.boundTransactRequest(project);
    const result=await api.tcbGetEnvironments({envId:context.selected.envId,appId:context.config.appId},{request,transactType:api.TransactType.IDE});
    const environment=validateEnvironment(result,context);
    return {...context,environment};
  });
}
function validateEnvironment(result, context) {
  const envs=result?.envList?.filter(env=>env.envId===context.selected.envId);
  if (envs?.length!==1) reject('BOUND_ENVIRONMENT_NOT_FOUND','environment');
  const env=envs[0], region=context.selected.region;
  if (env.status!=='NORMAL' || env.databases?.length!==1 || env.databases[0].status!=='RUNNING' || typeof env.databases[0].instanceId!=='string' || !env.databases[0].instanceId || env.databases[0].region!==region || env.functions?.length!==1 || env.functions[0].region!==region || env.functions[0].namespace!==env.envId || env.storages?.length!==1 || env.storages[0].region!==region || typeof env.storages[0].bucket!=='string' || !env.storages[0].bucket) reject('ENVIRONMENT_RESOURCE_MISMATCH','environment');
  return env;
}
function reportFor(context) {
  const environment=context.environment;
  return {
    time:new Date().toISOString(), action:'inspect', target:'test',
    appId:context.config.appId, envId:context.selected.envId, region:context.selected.region,
    metadataVerification:'VERIFIED', status:environment.status,
    database:{region:environment.databases[0].region,status:environment.databases[0].status},
    functions:{region:environment.functions[0].region,namespace:environment.functions[0].namespace},
    storage:{region:environment.storages[0].region,configured:true},
    remoteVerification:{collections:'NOT_RUN',indexes:'NOT_RUN',databaseRules:'NOT_RUN',storageRules:'NOT_RUN',deployedFunctions:'NOT_RUN',businessData:'NOT_RUN',billing:'NOT_RUN'},
    mutationsPerformed:false,
  };
}
function saveReport(report) {
  const output=assets.safeOutputDirectory(root,path.join(root,'work/cloud-reports'));
  fs.chmodSync(output,0o700);
  const name='environment-inspect-'+Date.now()+'.json';
  fs.writeFileSync(path.join(output,name),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return 'work/cloud-reports/'+name;
}
async function main(args=process.argv.slice(2),dependencies={}) {
  const options=parse([...args]);
  const context=loadContext(options);
  if (!options.execute) {
    const summary={mode:'OFFLINE_PLAN',action:'inspect',target:'test',appId:context.config.appId,envId:context.selected.envId,region:context.selected.region,privateKeyRead:false,sdkLoaded:false,networkCalled:false};
    (dependencies.output||console.log)(JSON.stringify(summary));
    return summary;
  }
  const connected=await (dependencies.connect||connect)(context);
  // Revalidate injected/test contexts too; no success based solely on adapter completion.
  validateEnvironment({envList:[connected.environment]},context);
  const report=reportFor(connected);
  const file=(dependencies.saveReport||saveReport)(report);
  (dependencies.output||console.log)(JSON.stringify({mode:'EXECUTED',action:'inspect',target:'test',metadataVerification:'VERIFIED',remoteChecks:'NOT_RUN',mutationsPerformed:false,report:file}));
  return report;
}
function safeError(error) { return error instanceof CloudInspectError?`${error.code} (stage: ${error.stage})`:'CLOUD_INSPECTION_FAILED (raw error suppressed)'; }
if (require.main===module) {
  const finish=code=>process.stdout.write('',()=>process.stderr.write('',()=>process.exit(code)));
  main().then(()=>finish(0),error=>{console.error(safeError(error));finish(2);});
}
module.exports={CloudInspectError,parse,loadContext,validateEnvironment,connect,cloudCall,reportFor,saveReport,main,safeError};
