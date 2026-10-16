#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const help = `Usage: node scripts/cloud-plan.cjs [--env test] [--config config/local.json] [--check]

Prints config/database-plan.v3.json and a local deployment preflight. No network
calls, cloud resources, fixtures or data writes. --check exits nonzero if the
local test configuration/build is incomplete. --execute is deliberately refused:
apply collections/indexes/rules in the actual console, verify and record results.
An offline plan does not prove remote environment existence, permissions, index
readiness or rules. The cloud function is cloudfunctions/oradv, entry index.main.
Required cloud variables: ORADV_ENV_ID=actual EnvId, ORADV_APP_ID=mini program AppID.
Set runtime Node.js >=18 supported by the actual WeChat CloudBase environment.
`;

try {
  const argv = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option in options) throw new Error(`Duplicate option: ${option}`);
    if (option === '--help' || option === '--check' || option === '--execute') options[option] = true;
    else if (['--env', '--config'].includes(option) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[option] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${option}`);
  }
  if (options['--help']) { console.log(help); process.exit(0); }
  if (options['--execute']) throw new Error('Automatic mutation is not implemented: use the versioned plan and current cloud console. No resources were changed.');
  if (options['--env'] && options['--env'] !== 'test') throw new Error('This beta preflight accepts only --env test');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'config/database-plan.v3.json'), 'utf8'));
  const configPath = path.resolve(root, options['--config'] || 'config/local.json');
  const blockers = [];
  let config = {};
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  else blockers.push('Missing ignored local configuration');
  if (!/^wx[a-fA-F0-9]{16}$/.test(config.appId || '')) blockers.push('Set the actual mini program AppID');
  if (config.clubId !== 'oradv') blockers.push('Set clubId to oradv');
  const envId = config.environments?.test?.envId;
  if (!envId || !/^[a-zA-Z0-9_-]{5,100}$/.test(envId) || /placeholder|REAL_ENV|<|>/i.test(envId)) blockers.push('Record the actual test EnvId after cloud activation');
  if (envId && envId === config.environments?.production?.envId) blockers.push('Test and production must use different environments');
  if (!fs.existsSync(path.join(root, 'cloudfunctions/oradv/lib/index.js')) || !fs.existsSync(path.join(root, 'cloudfunctions/oradv/index.js'))) blockers.push('Run npm run build to produce the deployable function and index.main shim');
  if (!fs.existsSync(path.join(root, 'cloudfunctions/oradv/node_modules/wx-server-sdk/package.json'))) blockers.push('Run npm ci --prefix cloudfunctions/oradv to install the locked cloud dependency');
  console.log(JSON.stringify({ mode: 'offline_plan', environment: 'test', envId: envId || null, appId: config.appId || null, blockers,
    remoteVerification: 'NOT_RUN', plan,
  }, null, 2));
  if (options['--check'] && blockers.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON configuration' : error.message);
  process.exitCode = 1;
}
