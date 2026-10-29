import { dangerDisable } from '../../api/permissions'
import { useCallback, useEffect, useState } from 'react'
import type {
  AgentTemplate,
  PermissionPreset,
  SkillManifest,
  UserQuestionAnswer,
} from '@reflexion-os-studio/runtime-client'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import {
  sendMessage,
  editResendMessage,
  cancelRun,
  retryRun,
  resolveApproval,
  respondToInteraction,
} from '../../api/chat'
import { request } from '../../api/client'
import { uploadMessageFiles } from '../chat/attachments/upload-message-files'
import type { useRemoteSession } from './useRemoteSession'
import { setSessionExecutionMode } from '../../api/sessions'

type SessionState = ReturnType<typeof useRemoteSession>
export function useRemoteActions(sessionId: string, state: SessionState) {
  const [permission, setPermission] =
    useState<PermissionPreset>('workspace-read')
  const [model, setModel] = useState<string | null>(null)
  const [models, setModels] = useState<RemoteCatalog['models']>([])
  const [skills, setSkills] = useState<SkillManifest[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const projectId = state.data?.session?.projectId
  const setNotice = state.setNotice
  const refresh = state.refresh
  const runs = state.data?.runs
  const refreshAfterMutation = useCallback(async (): Promise<void> => {
    try {
      await refresh()
    } catch {
      setNotice('操作已接受，但刷新失败；恢复连接后核对结果，勿重复提交')
    }
  }, [refresh, setNotice])
  useEffect(() => {
    if (projectId === undefined) return
    let disposed = false
    void Promise.all([
      request<RemoteCatalog>('remote.catalog'),
      request<{ skills: SkillManifest[] }>('skill.list', { projectId }),
      request<{ templates: AgentTemplate[] }>('agent_template.list', {
        projectId,
      }),
    ])
      .then(([catalog, manifest, roles]) => {
        if (disposed) return
        setModels(catalog.models)
        setModel(
          (current) =>
            current ??
            (catalog.models[0]
              ? `${catalog.models[0].providerId}::${catalog.models[0].model}`
              : null),
        )
        setSkills(manifest.skills)
        setTemplates(roles.templates)
      })
      .catch(() => {
        if (!disposed) setNotice('无法读取可用模型与技能，请检查电脑连接')
      })
    return () => {
      disposed = true
    }
  }, [projectId, setNotice])
  const config = useCallback(() => {
    const [providerId, selectedModel] = (model ?? '').split('::')
    return {
      ...(providerId && selectedModel
        ? { providerId, model: selectedModel }
        : {}),
      permissionPreset: permission,
    }
  }, [model, permission])
  const send = useCallback(
    async (
      content: string,
      agentTemplateId?: string,
      files: File[] = [],
    ): Promise<void> => {
      const attachmentAssetIds = await uploadMessageFiles(sessionId, files)
      await sendMessage({
        sessionId,
        content,
        attachmentAssetIds,
        agentTemplateId,
        ...config(),
      })
      await refreshAfterMutation()
    },
    [sessionId, config, refreshAfterMutation],
  )
  const edit = useCallback(
    async (
      messageId: string,
      content: string,
      retained: string[],
      files: File[],
    ): Promise<void> => {
      const uploaded = await uploadMessageFiles(sessionId, files)
      await editResendMessage({
        sessionId,
        messageId,
        content,
        attachmentAssetIds: [...retained, ...uploaded],
        ...config(),
      })
      await refreshAfterMutation()
    },
    [sessionId, config, refreshAfterMutation],
  )
  const stop = useCallback(async (): Promise<void> => {
    const run = runs?.find((candidate) =>
      [
        'created',
        'running',
        'awaiting_approval',
        'awaiting_user_input',
      ].includes(candidate.status),
    )
    if (run) await cancelRun(run.id)
    await refresh()
  }, [runs, refresh])
  const retry = useCallback(async (): Promise<void> => {
    const run = runs
      ?.filter((candidate) => candidate.supersededByRunId === null)
      .at(-1)
    if (!run) {
      setNotice('找不到可重试的运行，请刷新会话后重试')
      return
    }
    try {
      await retryRun({ runId: run.id })
      await refresh()
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? `重试失败：${cause.message}`
          : '重试失败，请检查电脑连接',
      )
    }
  }, [runs, refresh, setNotice])
  const choose = useCallback(
    (toolCallId: string, choiceId: string): void => {
      void resolveApproval({ toolCallId, choiceId })
        .then((result) => {
          if (!result.accepted) setNotice('该审批已被处理或已失效')
          return refresh()
        })
        .catch((cause) =>
          setNotice(cause instanceof Error ? cause.message : '审批失败'),
        )
    },
    [setNotice, refresh],
  )
  const answer = useCallback(
    async (
      interactionId: string,
      answers: UserQuestionAnswer[],
    ): Promise<boolean> =>
      (await respondToInteraction({ interactionId, answers })).accepted,
    [],
  )
  const executionMode = useCallback(
    async (mode: 'plan' | 'execute'): Promise<void> => {
      await setSessionExecutionMode(sessionId, mode)
      await refresh()
    },
    [sessionId, refresh],
  )
  const disableDanger = useCallback((): void => {
    void dangerDisable(sessionId).catch(() =>
      setNotice('关闭危险访问失败，请在电脑重试'),
    )
  }, [sessionId, setNotice])
  const settings = useCallback(
    () => setNotice('请在电脑设置页面配置 Provider'),
    [setNotice],
  )
  return {
    permission,
    setPermission,
    model,
    setModel,
    models,
    skills,
    templates,
    send,
    edit,
    stop,
    retry,
    choose,
    answer,
    executionMode,
    settings,
    disableDanger,
  }
}
