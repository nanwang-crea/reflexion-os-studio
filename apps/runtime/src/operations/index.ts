import type { Store } from '../store/index.js'
import { OperationRegistry } from './registry.js'
export { OperationRegistry } from './registry.js'
const registries = new WeakMap<Store, OperationRegistry>()
export function operationsFor(store: Store): OperationRegistry {
  let registry = registries.get(store)
  if (!registry) {
    registry = new OperationRegistry()
    registries.set(store, registry)
  }
  return registry
}
export function registerOperations(
  store: Store,
  registry: OperationRegistry,
): void {
  registries.set(store, registry)
}
