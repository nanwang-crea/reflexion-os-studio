import { PlaywrightBackend as Backend } from '../../dist/browser/agent/worker/backend.js'
import { launchAgentBrowser } from '../../dist/browser/agent/worker/launch.js'

export class PlaywrightBackend extends Backend {
  constructor(display = 'headless', launch) {
    super(display, launch, undefined, (config, options, isCurrent) =>
      launchAgentBrowser(
        config,
        {
          ...options,
          args: [
            ...options.args,
            '--no-proxy-server',
            '--host-resolver-rules=MAP *.test 127.0.0.1',
          ],
        },
        isCurrent,
      ),
    )
  }
}
