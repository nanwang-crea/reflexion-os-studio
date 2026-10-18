/** Preserve actionable browser failure categories without exposing URLs or page text. */
export function browserFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/^browser_[a-z_]+$/.test(message)) return new Error(message)
  const code =
    /Execution context.*destroyed|Cannot find context|not attached to an active page|frame was detached/i.test(
      message,
    )
      ? 'browser_page_loading'
      : /ERR_NAME_NOT_RESOLVED/.test(message)
        ? 'browser_network_dns_failed'
        : /ERR_CONNECTION_REFUSED/.test(message)
          ? 'browser_network_connection_refused'
          : /ERR_CERT_|ERR_SSL_/.test(message)
            ? 'browser_network_certificate'
            : /ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE/.test(message)
              ? 'browser_navigation_blocked'
              : /Timeout|timeout|ERR_TIMED_OUT/.test(message)
                ? 'browser_navigation_timeout'
                : /Target closed|has been closed|browser has been closed/i.test(
                      message,
                    )
                  ? 'browser_closed'
                  : /ERR_|Navigation|navigation/.test(message)
                    ? 'browser_navigation_failed'
                    : 'browser_interaction_failed'
  return new Error(code)
}
