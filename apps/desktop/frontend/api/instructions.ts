import { request } from './client'

export interface InstructionFile {
  path: string | null
  content: string
}

export function getInstruction(input: {
  scope: 'global' | 'project'
  projectId?: string
  kind: 'agents' | 'memory'
}): Promise<InstructionFile> {
  return request<InstructionFile>('instructions.get', input)
}

export function saveInstruction(input: {
  scope: 'global' | 'project'
  projectId?: string
  kind: 'agents' | 'memory'
  content: string
}): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>('instructions.save', input)
}
