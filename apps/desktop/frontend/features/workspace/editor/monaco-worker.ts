/**
 * Monaco Worker 环境配置点。
 *
 * vite-plugin-monaco-editor 在构建时通过 transformIndexHtml 自动注入
 * MonacoEnvironment.getWorkerUrl，将 workers 从 CDN 切换为本地打包资源。
 * 此文件同时配置 @monaco-editor/loader 使用本地 Monaco 而非 CDN。
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

loader.config({ monaco })
