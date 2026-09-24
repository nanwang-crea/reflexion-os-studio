interface BootstrapScreenProps {
  status: string
  detail: string
}

export function BootstrapScreen(
  props: BootstrapScreenProps,
): React.JSX.Element {
  return (
    <div className="boot-screen">
      <h1>ReflexionOS Studio</h1>
      <p className="boot-status">{props.status}</p>
      <p className="boot-detail">{props.detail}</p>
    </div>
  )
}
