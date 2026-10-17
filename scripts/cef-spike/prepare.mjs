import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Opt-in native macOS experiment; never invoked by the product build.
if (process.platform !== 'darwin') {
  throw new Error('This native embedding experiment currently requires macOS')
}
const root = resolve(process.argv[2] ?? '')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (revision !== '163744c8286d5f593d89202c7807751a7898db28') {
  throw new Error('Use the cef-rs revision pinned in the validation report')
}
const directory = join(root, 'examples', 'cefembed')
await cp(join(root, 'examples', 'cefsimple'), directory, { recursive: true })
async function replace(file, before, after) {
  const path = join(directory, file)
  const source = await readFile(path, 'utf8')
  if (!source.includes(before)) throw new Error(`Unexpected source: ${file}`)
  await writeFile(path, source.replaceAll(before, after))
}
await replace('Cargo.toml', 'cefsimple', 'cefembed')
await replace('Cargo.toml', 'resources_path = "resources"', '')
await replace(
  'Cargo.toml',
  '[dependencies]',
  '[build-dependencies]\ntauri-build = "=2.6.3"\n\n[dependencies]\ntauri = { version = "=2.11.5", features = [] }\ntauri-runtime = "=2.11.3"\ntauri-runtime-wry = "=2.11.4"\ntauri-utils = "=2.9.3"\ntauri-macros = "=2.6.3"\ntauri-codegen = "=2.6.3"',
)
await rename(
  join(directory, 'src/bin/cefsimple_helper.rs'),
  join(directory, 'src/bin/cefembed_helper.rs'),
)
await writeFile(
  join(directory, 'build.rs'),
  'fn main() { tauri_build::build(); }\n',
)
await replace('src/main.rs', 'pub mod shared;', 'pub mod shared;\nmod embed;')
await replace(
  'src/shared/mod.rs',
  'let mut app = simple_app::SimpleApp::new();',
  'let mut app = crate::embed::EmbedApp::new();',
)
await replace(
  'src/shared/mod.rs',
  'no_sandbox: !cfg!(feature = "sandbox") as _,',
  'no_sandbox: !cfg!(feature = "sandbox") as _,\n        root_cache_path: CefString::from(std::env::temp_dir().join("reflexion-cef-embed-profile").to_str().unwrap()),\n        remote_debugging_port: 19228,\n        external_message_pump: 1,',
)
await replace(
  'src/shared/mod.rs',
  '    #[cfg(target_os = "macos")]\n    let _delegate = crate::mac::setup_simple_app_delegate();\n\n    run_message_loop();',
  '    crate::embed::run();',
)
await cp(new URL('./native/', import.meta.url), join(directory, 'src'), {
  recursive: true,
})
await cp(new URL('./fixture/', import.meta.url), join(directory, 'ui'), {
  recursive: true,
})
await mkdir(join(directory, 'icons'), { recursive: true })
await cp(
  new URL('../../apps/desktop/src-tauri/icons/64x64.png', import.meta.url),
  join(directory, 'icons/icon.png'),
)
await writeFile(
  join(directory, 'tauri.conf.json'),
  JSON.stringify(
    {
      productName: 'CEF Embed Validation',
      version: '0.1.0',
      identifier: 'dev.reflexion.cefembed.spike',
      build: { frontendDist: 'ui' },
      app: {
        windows: [
          {
            label: 'main',
            title: 'Tauri + CEF 嵌入验证',
            width: 1100,
            height: 720,
          },
        ],
      },
      bundle: { active: false },
    },
    null,
    2,
  ) + '\n',
)
console.log(`Prepared isolated Tauri/CEF experiment: ${directory}`)
