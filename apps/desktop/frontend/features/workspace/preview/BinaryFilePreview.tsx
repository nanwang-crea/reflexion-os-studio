interface BinaryFilePreviewProps {
  /** 文件路径（仅用于提示文案）。 */
  path: string
}

/**
 * 二进制/图片等不可按文本展示的文件：给出行内占位提示，避免把
 * 二进制内容当文本渲染出乱码。图片预览属后续迭代（需要 read_file
 * 提供 base64 契约）。
 */
export function BinaryFilePreview(
  props: BinaryFilePreviewProps,
): React.JSX.Element {
  const fileName = props.path.split('/').pop() ?? props.path
  return (
    <div className="workspace-panel-empty">
      <p>「{fileName}」是二进制文件，暂不支持预览。</p>
    </div>
  )
}
