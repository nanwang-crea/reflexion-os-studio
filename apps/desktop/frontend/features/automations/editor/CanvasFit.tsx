import { useEffect } from 'react'
import { useNodesInitialized, useReactFlow } from '@xyflow/react'

/** Fit after topology measurements settle; no recurring animation or idle timer. */
export function CanvasFit({ topology }: { topology: string }): null {
  const measured = useNodesInitialized()
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (measured) void fitView({ padding: 0.2, maxZoom: 1 })
  }, [measured, topology, fitView])
  return null
}
