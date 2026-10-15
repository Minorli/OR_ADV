# Cloud dependency maintenance

`wx-server-sdk` stays pinned at **4.0.2**. Its pinned transitive dependencies
included vulnerable Axios 0.27.2, `lodash.set` 4.3.2 and `lodash.unset` 4.5.2.
The latest CloudBase database package still uses these standalone Lodash versions;
an automatic SDK downgrade is not an appropriate fix.

The function package applies these explicit npm overrides:

- **Axios 0.34.0**: maintained security fixes within the existing 0.x API family.
- **Local `lodash.set` / `lodash.unset` compatibility modules**: each exports the
  corresponding method from maintained **Lodash 4.18.1**. Their local version
  `4.18.1-oradv.1` identifies this project's adapter, not an official standalone
  Lodash release. The vulnerable implementations are not copied or retained.

Keep `compat/`, `package.json` and `package-lock.json` together in the deployed
function directory. Install with an npm version supporting `overrides` (>=8.3).
Use the lockfile; verify the resulting dependency tree when the deployment
platform installs dependencies remotely.

```sh
npm ci --prefix cloudfunctions/oradv --registry=https://registry.npmjs.org
npm ls --prefix cloudfunctions/oradv axios lodash.set lodash.unset lodash --all
npm audit --prefix cloudfunctions/oradv --registry=https://registry.npmjs.org --omit=dev
node --import tsx --test tests/cloud/*.test.ts
```

Verification uses the actual dependency resolution from `@cloudbase/database`,
checks callable nested-path set/unset behavior, blocks prototype traversal
(including array-wrapped path segments), and tests the locked WeChat SDK's
missing-document boundary with networking replaced. A fresh `npm ci` and audit
reported zero advisories during implementation. This does not verify a real
cloud deployment, permissions or database transactions.

Review these overrides when the upstream SDK/database releases compatible fixes:
[Axios changelog](https://github.com/axios/axios/blob/v0.34.0/CHANGELOG.md),
[Lodash releases](https://github.com/lodash/lodash/releases),
[set advisory](https://github.com/advisories/GHSA-p6mc-m468-83gw),
[unset advisory](https://github.com/advisories/GHSA-f23m-r3pf-42rh),
[WeChat SDK](https://github.com/wechat-miniprogram/wx-server-sdk).
