/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: string
  readonly VITE_BASE?: string
  // 第二十轮快线（LI.FI）：可选。无 key 时走官方免 key 通道（限流紧）；主网前由 Ren 在 LI.FI Partner Portal 申请
  readonly VITE_LIFI_API_KEY?: string
  readonly VITE_LIFI_INTEGRATOR?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
