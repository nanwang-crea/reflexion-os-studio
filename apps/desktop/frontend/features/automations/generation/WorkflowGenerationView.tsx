import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import * as api from '../../../api/workflow'
import type { useWorkflowEditor } from '../useWorkflowEditor'
import { GenerationPanel } from './GenerationPanel'

export function WorkflowGenerationView({
  editor,
  projectId,
  providers,
  modelKey,
  onModel,
  onOpenCanvas,
}: {
  editor: ReturnType<typeof useWorkflowEditor>
  projectId: string
  providers: ProviderProfile[]
  modelKey: string
  onModel: (key: string) => void
  onOpenCanvas: () => void
}): React.JSX.Element {
  return (
    <GenerationPanel
      value={editor.generation}
      disabled={editor.busy || !modelKey}
      canApply={
        !editor.dirty &&
        !editor.busy &&
        editor.draft?.revision === editor.generation?.baseRevision
      }
      modelPicker={
        <label>
          默认语言模型
          <Select
            value={modelKey}
            disabled={editor.busy || editor.generation?.status === 'running'}
            onValueChange={onModel}
          >
            <option value="">请选择模型</option>
            {providers
              .filter(
                (provider) =>
                  provider.enabled && provider.capabilities.includes('chat'),
              )
              .flatMap((provider) =>
                provider.models.map((model) => (
                  <option
                    key={JSON.stringify([provider.id, model])}
                    value={JSON.stringify([provider.id, model])}
                  >
                    {provider.name} / {model}
                  </option>
                )),
              )}
          </Select>
        </label>
      }
      onGenerate={(mode, description) => {
        if (!modelKey) return
        const [providerId, model] = JSON.parse(modelKey) as [string, string]
        void editor.generate(mode, description, providerId, model)
      }}
      onCancel={() => void editor.cancelGeneration()}
      onApply={() => void editor.apply(onOpenCanvas)}
      onOpenCanvas={onOpenCanvas}
      onEdit={(definition) =>
        editor.action(async () => {
          if (!editor.generation) throw new Error('候选已切换，请重新审阅')
          const result = await api.editWorkflowGeneration({
            projectId,
            generationId: editor.generation.id,
            stateVersion: editor.generation.stateVersion,
            definition,
          })
          editor.setGeneration((old) =>
            old?.id === result.generation.id &&
            old.stateVersion > result.generation.stateVersion
              ? old
              : result.generation,
          )
        }, true)
      }
    />
  )
}
