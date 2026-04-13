module.exports = {
  kind: 'test-kind',
  displayName: 'Test Kind',
  version: '0.0.1',
  description: 'Fixture kind used by integration tests only.',
  defaultConfig: {
    greeting: 'hello',
    nested: { a: 1 }
  },
  directiveHandlers: {
    'config.set': async ({ payload, db }) => {
      db.run(
        'INSERT OR REPLACE INTO satellite_meta (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
        [payload.key, JSON.stringify(payload.value)]
      );
      return { status: 'applied' };
    }
  },
  onCreate: async () => {},
  onBoot: async () => {},
  onArchive: async () => {},
  handlers: {}
};
