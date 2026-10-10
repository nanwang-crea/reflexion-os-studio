import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_MESSAGE_IMAGES } from '@reflexion-os-studio/runtime-client'
import { validateImageFile } from '../../features/chat/images/upload-message-images'

export interface DraftImage {
  id: string
  file: File
  url: string
}

export function useComposerImages() {
  const [images, setImages] = useState<DraftImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const current = useRef<DraftImage[]>([])
  useEffect(
    () => () =>
      current.current.forEach((image) => URL.revokeObjectURL(image.url)),
    [],
  )
  const add = useCallback((files: File[]) => {
    try {
      if (current.current.length + files.length > MAX_MESSAGE_IMAGES)
        throw new Error('每条消息最多 4 张图片')
      files.forEach(validateImageFile)
      const next = [
        ...current.current,
        ...files.map((file) => ({
          id: crypto.randomUUID(),
          file,
          url: URL.createObjectURL(file),
        })),
      ]
      current.current = next
      setImages(next)
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : '图片添加失败')
    }
  }, [])
  const remove = useCallback((id: string) => {
    const image = current.current.find((image) => image.id === id)
    if (image) URL.revokeObjectURL(image.url)
    const next = current.current.filter((image) => image.id !== id)
    current.current = next
    setImages(next)
  }, [])
  const clear = useCallback(() => {
    current.current.forEach((image) => URL.revokeObjectURL(image.url))
    current.current = []
    setImages([])
    setError(null)
  }, [])
  return { images, error, add, remove, clear }
}
