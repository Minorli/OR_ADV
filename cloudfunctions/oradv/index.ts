import cloud = require('wx-server-sdk');
import { createService } from '../../shared/service';
import type { Store } from '../../shared/store';
import { createCloudHandler } from './handler';
import { CloudStore, type CloudDatabase } from './store';
import { createAvatarStorage } from './avatar-storage';

let store: Store | undefined;
let service: ReturnType<typeof createService> | undefined;

function getStore(): Store {
  if (!store) {
    cloud.init({ env: process.env.ORADV_ENV_ID! });
    // Supported by wx-server-sdk 4.0.2 implementation; its declaration omits
    // throwOnNotFound. Only an actually absent document becomes data:null.
    const options = { env: process.env.ORADV_ENV_ID!, throwOnNotFound: false };
    store = new CloudStore(cloud.database(options) as unknown as CloudDatabase);
  }
  return store;
}

export const main = createCloudHandler({
  config: () => ({ envId: process.env.ORADV_ENV_ID, appId: process.env.ORADV_APP_ID, runtimeEnvId: process.env.TCB_ENV || process.env.SCF_NAMESPACE }),
  context: () => cloud.getWXContext(),
  store: getStore,
  invoke: async (request, identity, traceId) => {
    service ??= createService(getStore(), { clubId: 'oradv', avatarStorage: createAvatarStorage(cloud),
      log: (entry) => console.warn(JSON.stringify(entry)) });
    return service.handle(request, identity, traceId);
  },
  log: (entry) => console.warn(JSON.stringify(entry)),
});
