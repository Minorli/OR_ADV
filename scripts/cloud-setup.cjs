#!/usr/bin/env node
'use strict';
// Initial TEST infrastructure only, using pinned public CloudBase manager APIs.
// Default is offline. No billing, function deployment, document import, drop or delete operations.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const inspector=require('./wechat-cloud-inspect.cjs');
const assets=require('./asset-inventory.cjs');
const root=path.resolve(__dirname,'..');
const COLLECTIONS=['clubs','users','memberships','staff_roles','activities','registrations','qualifications','checkins','points_ledger','member_stats','public_rankings','annual_rewards','audit_logs','settlement_jobs','rpc_limits','schema_migrations','activity_briefings','public_recommendations','member_dossiers','member_media','learning_catalog','learning_attempts','skill_submissions','club_content','club_inquiries','activity_stories','activity_reviews'];
const DENY={read:false,write:false};
class SetupError extends Error { constructor(code,stage='preflight'){super(code);this.code=code;this.stage=stage;} }
function reject(code,stage){throw new SetupError(code,stage);}
function exactDeny(value){return value && !Array.isArray(value) && Object.keys(value).sort().join(',')==='read,write' && value.read===false && value.write===false;}
function readJSON(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{reject('INVALID_JSON');}}
function validatePlan(plan,storage){
  if(plan?.version!==3 || plan.clubId!=='oradv' || !exactDeny(plan.clientRulesForEveryCollection) || !exactDeny(storage))reject('INVALID_SECURITY_PLAN');
  if(!Array.isArray(plan.collections) || plan.collections.length!==27 || new Set(plan.collections).size!==27 || COLLECTIONS.some(name=>!plan.collections.includes(name)))reject('INVALID_COLLECTION_PLAN');
  if(!Array.isArray(plan.indexes) || plan.indexes.length!==31)reject('INVALID_INDEX_PLAN');
  const seen=new Set();
  for(const index of plan.indexes){
    if(!index || Object.keys(index).sort().join(',')!=='collection,fields,name,unique' || !COLLECTIONS.includes(index.collection) || !/^[a-z][a-z0-9_]{0,63}$/.test(index.name) || index.unique!==false || !Array.isArray(index.fields) || !index.fields.length || index.fields.length>10)reject('INVALID_INDEX_PLAN');
    const id=index.collection+'/'+index.name;
    if(seen.has(id))reject('DUPLICATE_INDEX_PLAN');
    seen.add(id);
    const fields=new Set();
    for(const field of index.fields){
      if(!Array.isArray(field) || field.length!==2 || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field[0]) || !['asc','desc'].includes(field[1]) || fields.has(field[0]))reject('INVALID_INDEX_PLAN');
      fields.add(field[0]);
    }
  }
  return createHash('sha256').update(JSON.stringify({collections:plan.collections,indexes:plan.indexes,rules:DENY,storage})).digest('hex');
}
function parse(args){
  const action=args.shift();
  if(!['inspect','apply'].includes(action))reject('INVALID_ACTION');
  // The shared preflight only accepts inspect; its target/key-path checks are reused without reading a key.
  let options;
  try{options=inspector.parse(['inspect',...args]);}catch{reject('INVALID_ARGUMENTS');}
  return {...options,action};
}
function loadContext(options){
  let context;
  try{context=inspector.loadContext({...options,action:'inspect'});}catch(error){
    if(error instanceof inspector.CloudInspectError)reject(error.code,error.stage);
    reject('INVALID_LOCAL_CONFIG');
  }
  const plan=readJSON(path.join(root,'config/database-plan.v3.json'));
  const storage=readJSON(path.join(root,'config/storage-rules.v1.json'));
  return {...context,options,plan,storage,planHash:validatePlan(plan,storage)};
}
async function call(stage,operation){
  try{return await operation();}catch(error){if(error instanceof SetupError)throw error;throw new SetupError('CLOUD_CALL_FAILED',stage);}
}
function packageEntry(name,version){
  let entry;
  try{entry=require.resolve(name,{paths:[path.join(root,'work/cloud-tools')]});}catch{reject('PINNED_PUBLIC_SDK_REQUIRED');}
  let directory=path.dirname(entry);
  while(!fs.existsSync(path.join(directory,'package.json'))){const parent=path.dirname(directory);if(parent===directory)reject('PINNED_PUBLIC_SDK_REQUIRED');directory=parent;}
  const pkg=readJSON(path.join(directory,'package.json'));
  if(pkg.name!==name || pkg.version!==version)reject('PINNED_PUBLIC_SDK_REQUIRED');
  return entry;
}
function validateEnvironment(response,context){
  const env=response?.EnvInfo;
  const normalized={envId:env?.EnvId,status:env?.Status,databases:env?.Databases?.map(db=>({instanceId:db.InstanceId,status:db.Status,region:db.Region})),functions:env?.Functions?.map(fn=>({namespace:fn.Namespace,region:fn.Region})),storages:env?.Storages?.map(storage=>({bucket:storage.Bucket,region:storage.Region}))};
  try{inspector.validateEnvironment({envList:[normalized]},context);}catch{reject('ENVIRONMENT_RESOURCE_MISMATCH','environment');}
  return env;
}
async function connect(context){
  if(!context.options.execute || context.options.appId!==context.config.appId || context.options.envId!==context.selected.envId)reject('TARGET_CONFIRMATION_REQUIRED');
  const toolboxEntry=packageEntry('@cloudbase/toolbox','0.9.1');
  const managerEntry=packageEntry('@cloudbase/manager-node','5.9.1');
  const toolbox=require(toolboxEntry), Manager=require(managerEntry);
  const credential=await call('authorized-session',()=>toolbox.checkAndGetCredential({cwd:root}));
  if(typeof credential?.secretId!=='string' || !credential.secretId || typeof credential.secretKey!=='string' || !credential.secretKey || typeof credential.token!=='string' || !credential.token)reject('AUTHORIZED_DEVICE_SESSION_REQUIRED','authentication');
  const manager=new Manager({envId:context.selected.envId,region:context.selected.region,secretId:credential.secretId,secretKey:credential.secretKey,token:credential.token});
  const result=await call('environment',()=>manager.env.getEnvInfo());
  const environment=validateEnvironment(result,context);
  return {...context,manager,environment,databaseTag:environment.Databases[0].InstanceId};
}
async function listFunctions(context){
  const result=await call('list-functions',()=>context.manager.functions.getFunctionList(100,0));
  const functions=result?.Functions||[];
  if(!Array.isArray(functions) || !Number.isSafeInteger(result?.TotalCount) || result.TotalCount!==functions.length || functions.length>100 || functions.some(fn=>typeof fn.FunctionName!=='string'))reject('FUNCTION_LIMIT_OR_RESPONSE','inspect');
  return functions.map(({FunctionName,Runtime,Status})=>({FunctionName,Runtime,Status}));
}
function indexEqual(actual,expected){
  return actual?.Unique===false && JSON.stringify(actual.Keys?.map(key=>[key.Name,key.Direction]))===JSON.stringify(expected.fields.map(([name,direction])=>[name,direction==='asc'?'1':'-1']));
}
function denyReadback(value){
  try{return value?.AclTag==='CUSTOM' && exactDeny(typeof value.Rule==='string'?JSON.parse(value.Rule):value.Rule);}catch{return false;}
}
function storageDenyReadback(value){
  try{return value?.acl==='CUSTOM' && exactDeny(typeof value.rule==='string'?JSON.parse(value.rule):value.rule);}catch{return false;}
}
function parseCountResult(result){
  try{
    if(!Array.isArray(result?.Data) || result.Data.length!==1 || typeof result.Data[0]!=='string' || result.Data[0].length>16384)reject('INVALID_COLLECTION_COUNT','inspect');
    const rows=JSON.parse(result.Data[0]);
    if(!Array.isArray(rows) || rows.length!==1 || typeof rows[0]!=='string' || rows[0].length>16384)reject('INVALID_COLLECTION_COUNT','inspect');
    const value=JSON.parse(rows[0]);
    const ok=value?.ok===1 || (value?.ok && Object.keys(value.ok).join(',')==='$numberDouble' && /^1(?:\.0+)?$/.test(value.ok.$numberDouble));
    const raw=typeof value?.n==='number'?value.n:value?.n && Object.keys(value.n).length===1?(value.n.$numberInt??value.n.$numberLong):undefined;
    if(!ok || !['string','number'].includes(typeof raw) || (typeof raw==='string' && !/^(0|[1-9][0-9]*)$/.test(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw)<0)reject('INVALID_COLLECTION_COUNT','inspect');
    return Number(raw);
  }catch(error){if(error instanceof SetupError)throw error;reject('INVALID_COLLECTION_COUNT','inspect');}
}
async function countCollection(context,name){
  const result=await call('count-collection',()=>context.manager.database.runCommands({MgoCommands:[{TableName:name,CommandType:'QUERY',Command:JSON.stringify({count:name,query:{}})}]}));
  return parseCountResult(result);
}
async function collectionRule(context,name){
  return call('read-collection-rule',()=>context.manager.commonService('tcb','2018-06-08').call({Action:'DescribeSafeRule',Param:{EnvId:context.selected.envId,CollectionName:name}}));
}
async function inspect(context){
  const {manager}=context;
  const list=await call('list-collections',()=>manager.database.listCollections({MgoLimit:1000,MgoOffset:0}));
  if(!Array.isArray(list?.Collections) || list.Collections.length>1000 || !Number.isSafeInteger(list.Pager?.Total) || list.Pager.Total!==list.Collections.length)reject('COLLECTION_LIMIT_OR_RESPONSE','inspect');
  const names=list.Collections.map(table=>table.CollectionName);
  if(new Set(names).size!==names.length || names.some(name=>typeof name!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)))reject('INVALID_COLLECTION_RESPONSE','inspect');
  const functions=await listFunctions(context);
  const collections=[];
  for(const name of names.filter(name=>COLLECTIONS.includes(name))){
    const count=await countCollection(context,name);
    const detail=await call('describe-indexes',()=>manager.database.describeCollection(name));
    if(!Array.isArray(detail?.Indexes) || detail.Indexes.length>100)reject('INVALID_INDEX_RESPONSE','inspect');
    const rule=await collectionRule(context,name);
    collections.push({name,count,indexes:detail.Indexes.map(({Name,Keys,Unique})=>({Name,Keys,Unique})),rule});
  }
  const storageRule=await call('read-storage-rule',()=>manager.storage.getStorageAcl({withRule:true}));
  return {time:new Date().toISOString(),action:context.options.action,target:'test',envId:context.selected.envId,appId:context.config.appId,region:context.selected.region,planHash:context.planHash,collections,otherCollections:names.filter(name=>!COLLECTIONS.includes(name)),functions,storageRule,mutationsPerformed:context.options.action==='apply'};
}
function initialGuard(report,plan){
  if(report.functions.some(fn=>fn.FunctionName==='oradv'))reject('EXISTING_ORADV_FUNCTION_REFUSED','initial-setup');
  // Storage permissions apply to the entire environment; this initializer requires a dedicated one.
  if(report.otherCollections.length || report.functions.length)reject('SHARED_ENVIRONMENT_REFUSED','initial-setup');
  if(report.collections.some(collection=>collection.count!==0))reject('BUSINESS_DATA_PRESENT','initial-setup');
  for(const collection of report.collections){
    for(const expected of plan.indexes.filter(index=>index.collection===collection.name)){
      const found=collection.indexes.filter(index=>index.Name===expected.name);
      if(found.length>1 || (found.length===1 && !indexEqual(found[0],expected)))reject('INDEX_MISMATCH','initial-setup');
    }
  }
}
async function indexReadback(context,name,index){
  for(let attempt=0;attempt<10;attempt++){
    const detail=await call('verify-index',()=>context.manager.database.describeCollection(name));
    if(!Array.isArray(detail?.Indexes) || detail.Indexes.length>100)reject('INVALID_INDEX_RESPONSE','verify');
    const matches=detail.Indexes.filter(actual=>actual.Name===index.name);
    if(matches.length===1 && indexEqual(matches[0],index))return;
    if(matches.length)reject('INDEX_READBACK_MISMATCH','verify');
    if(attempt<9)await new Promise(resolve=>setTimeout(resolve,500));
  }
  reject('INDEX_READBACK_TIMEOUT','verify');
}
async function apply(context){
  if(!context.options.execute || context.options.appId!==context.config.appId || context.options.envId!==context.selected.envId)reject('TARGET_CONFIRMATION_REQUIRED');
  const before=await inspect(context);
  initialGuard(before,context.plan);
  const existing=new Map(before.collections.map(collection=>[collection.name,collection]));
  for(const name of context.plan.collections){
    if(!existing.has(name))await call('create-collection',()=>context.manager.database.createCollection(name));
    await call('deny-collection',()=>context.manager.commonService('tcb','2018-06-08').call({Action:'ModifySafeRule',Param:{EnvId:context.selected.envId,CollectionName:name,AclTag:'CUSTOM',Rule:JSON.stringify(DENY)}}));
    if(!denyReadback(await collectionRule(context,name)))reject('COLLECTION_RULE_READBACK_MISMATCH','verify');
    for(const index of context.plan.indexes.filter(index=>index.collection===name)){
      const found=existing.get(name)?.indexes.find(actual=>actual.Name===index.name);
      if(!found)await call('create-index',()=>context.manager.database.updateCollection(name,{CreateIndexes:[{IndexName:index.name,MgoKeySchema:{MgoIndexKeys:index.fields.map(([field,direction])=>({Name:field,Direction:direction==='asc'?'1':'-1'})),MgoIsUnique:false}}],DropIndexes:[]}));
      await indexReadback(context,name,index);
    }
  }
  await call('deny-storage',()=>context.manager.storage.setStorageAcl('CUSTOM',DENY));
  const after=await inspect(context);
  initialGuard(after,context.plan);
  if(after.collections.length!==27 || after.collections.some(collection=>!denyReadback(collection.rule)) || !storageDenyReadback(after.storageRule))reject('FINAL_SECURITY_READBACK_MISMATCH','verify');
  for(const expected of context.plan.indexes){
    const actual=after.collections.find(collection=>collection.name===expected.collection)?.indexes.filter(index=>index.Name===expected.name);
    if(actual?.length!==1 || !indexEqual(actual[0],expected))reject('FINAL_INDEX_READBACK_MISMATCH','verify');
  }
  return after;
}
function saveReport(report){
  const output=assets.safeOutputDirectory(root,path.join(root,'work/cloud-reports'));
  fs.chmodSync(output,0o700);
  const file='setup-'+report.action+'-'+Date.now()+'.json';
  fs.writeFileSync(path.join(output,file),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return 'work/cloud-reports/'+file;
}
async function main(args=process.argv.slice(2),dependencies={}){
  const context=loadContext(parse([...args]));
  if(!context.options.execute){
    const summary={mode:'OFFLINE_PLAN',action:context.options.action,target:'test',appId:context.config.appId,envId:context.selected.envId,region:context.selected.region,collections:27,indexes:31,planHash:context.planHash,sdkLoaded:false,credentialsRead:false,privateKeyRead:false,networkCalled:false};
    (dependencies.output||console.log)(JSON.stringify(summary));return summary;
  }
  const connected=await (dependencies.connect||connect)(context);
  const report=context.options.action==='apply'?await apply(connected):await inspect(connected);
  const file=(dependencies.saveReport||saveReport)(report);
  (dependencies.output||console.log)(JSON.stringify({mode:'EXECUTED',action:context.options.action,target:'test',collections:report.collections.length,planHash:context.planHash,report:file,businessDataImported:false,billingChanged:false}));
  return report;
}
function safeError(error){return error instanceof SetupError?`${error.code} (stage: ${error.stage})`:'CLOUD_SETUP_FAILED (raw error suppressed)';}
if(require.main===module){const finish=code=>process.stdout.write('',()=>process.stderr.write('',()=>process.exit(code)));main().then(()=>finish(0),error=>{console.error(safeError(error));finish(2);});}
module.exports={SetupError,COLLECTIONS,parse,loadContext,validatePlan,validateEnvironment,connect,parseCountResult,countCollection,listFunctions,inspect,apply,initialGuard,indexEqual,denyReadback,storageDenyReadback,main,safeError,call};
