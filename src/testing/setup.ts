import 'fake-indexeddb/auto';

// A global in tests, so a public-edition test can switch it with vi.stubGlobal.
Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: false });
