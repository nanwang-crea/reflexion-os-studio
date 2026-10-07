/** dumpbin 输出不依赖语言，只提取 DLL 名；不得把空输出当成验证成功。 */
export function verifyCrtDependencies(output) {
  const dependencies = [...new Set(output.match(/[a-z0-9_.-]+\.dll\b/gi) ?? [])]
  if (dependencies.length === 0) {
    throw new Error('dumpbin did not report any DLL dependencies')
  }
  const dynamicCrt = dependencies.filter((name) =>
    /^(?:(?:vcruntime|msvcp|msvcr|concrt)\d[^/]*|ucrtbase|api-ms-win-crt-[^/]+)\.dll$/i.test(
      name,
    ),
  )
  if (dynamicCrt.length > 0) {
    throw new Error(
      `Windows sidecar depends on dynamic CRT: ${dynamicCrt.join(', ')}; rebuild with +crt-static`,
    )
  }
  return dependencies
}
