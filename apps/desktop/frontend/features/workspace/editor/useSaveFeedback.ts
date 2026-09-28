import { useEffect, useState } from 'react'

/** 成功保存后短暂显示反馈；初次加载（version=0）不显示。 */
export function useSaveFeedback(saveVersion: number): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (saveVersion === 0) {
      setVisible(false)
      return
    }
    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), 1600)
    return () => window.clearTimeout(timer)
  }, [saveVersion])

  return visible
}
