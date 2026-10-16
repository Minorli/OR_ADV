export function selectBuild(args, config) {
  let mode = 'mock';
  let target = 'test';
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--watch') continue;
    if (!['--mode', '--env'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: build [--mode mock|cloud] [--env test|production] [--watch]');
    }
    const value = args[++index];
    if (key === '--mode') mode = value;
    else target = value;
  }
  if (!['mock', 'cloud'].includes(mode) || !['test', 'production'].includes(target)) {
    throw new Error('Unknown build mode or target');
  }
  if (mode === 'mock' && target !== 'test') throw new Error('Mock builds cannot target production');
  const appId = config.appId || '';
  const version = config.version || '0.2.0-test.5';
  if (!/^[\w.-]{1,40}$/.test(version)) throw new Error('Invalid build version');
  const envId = mode === 'cloud' ? config.environments?.[target]?.envId : '';
  if (mode === 'cloud') {
    if (!/^wx[a-fA-F0-9]{16}$/.test(appId) || typeof envId !== 'string' || !envId.trim()) {
      throw new Error('Cloud build requires real AppID and selected EnvId in config/local.json');
    }
    if (config.environments?.test?.envId === config.environments?.production?.envId) {
      throw new Error('Test and production EnvId must differ');
    }
  }
  return { mode, target, appId, envId: envId || '', version };
}
