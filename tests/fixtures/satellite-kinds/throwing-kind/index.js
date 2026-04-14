module.exports = {
  kind: 'throwing-kind',
  displayName: 'Throwing Kind',
  version: '0.0.1',
  description: 'Fixture kind whose onCreate throws — used to test createInstance rollback.',
  defaultConfig: {},
  directiveHandlers: {},
  onCreate: async () => { throw new Error('onCreate-boom'); },
  onBoot: async () => {},
  onArchive: async () => {},
  handlers: {}
};
