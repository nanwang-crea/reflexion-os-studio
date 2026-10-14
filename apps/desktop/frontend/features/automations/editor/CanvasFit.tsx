import { useEffect } from 'react'
import { useNodesInitialized, useReactFlow, useStore } from '@xyflow/react'

/** Fit after topology measurements settle; no recurring animation or idle timer. */
export function CanvasFit({ topology }: { topology: string }): null {
  const measured = useNodesInitialized()
  const { fitView } = useReactFlow()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  useEffect(() => {
    if (measured && width > 0 && height > 0)
      void fitView({ padding: 0.2, maxZoom: 1 })
  }, [measured, topology, fitView, width, height])
  return null
}
