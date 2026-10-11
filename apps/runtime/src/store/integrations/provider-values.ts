import { ProviderModelSchema } from '@reflexion-os-studio/contracts'

type NumericParameter =
  'temperature' | 'maxTokens' | 'contextWindow' | 'contextBudget'

/** SQLite 历史/手动损坏的值只在读取边界回退，不重写原记录。 */
export function readProviderNumber(
  field: NumericParameter,
  value: unknown,
): number | null {
  const result = ProviderModelSchema.shape[field].safeParse(value ?? null)
  return result.success ? result.data : null
}
