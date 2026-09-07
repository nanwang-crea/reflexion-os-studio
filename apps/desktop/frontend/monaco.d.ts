declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}

// Resolve JSX namespace for @monaco-editor/react types
declare namespace JSX {
  type Element = React.JSX.Element
  type ElementClass = React.JSX.ElementClass
  type IntrinsicElements = React.JSX.IntrinsicElements
  type IntrinsicAttributes = React.JSX.IntrinsicAttributes
}
