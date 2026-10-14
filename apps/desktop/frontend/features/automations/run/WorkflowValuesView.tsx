import {
  assetUri,
  workspaceFileUri,
  parseResourceUri,
  type ResourceLink,
  type WorkflowValues,
} from '@reflexion-os-studio/contracts'

export function WorkflowValuesView({
  values,
  onResource,
}: {
  values: WorkflowValues
  onResource?: (resource: ResourceLink) => void
}): React.JSX.Element {
  return (
    <div>
      {Object.entries(values).map(([key, value]) => (
        <section key={key}>
          <strong>{key}</strong>
          {value.type === 'resource' ? (
            <>
              <pre>{JSON.stringify(value.value, null, 2)}</pre>
              {onResource && (
                <button
                  type="button"
                  onClick={() =>
                    onResource(
                      parseResourceUri(
                        value.value.kind === 'asset'
                          ? assetUri(value.value.assetId)
                          : workspaceFileUri(
                              value.value.projectId,
                              value.value.path,
                            ),
                      ),
                    )
                  }
                >
                  打开资源
                </button>
              )}
            </>
          ) : (
            <pre>
              {value.type === 'text'
                ? value.value
                : JSON.stringify(value.value, null, 2)}
            </pre>
          )}
        </section>
      ))}
    </div>
  )
}
