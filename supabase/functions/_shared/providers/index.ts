// Provider adapters: the contract, the capability-checking base class and the mock. Real integrations
// (see ../smm-v2-adapter.ts) implement the same IProviderAdapter.
export * from './contract.ts'
export { BaseProviderAdapter, type BaseProviderConfig } from './base-adapter.ts'
export { MOCK_CATALOG, MockProviderAdapter, type MockProviderConfig } from './mock-adapter.ts'
