declare module '@testing-library/react' {
  // 为 TS 类型补充 waitFor，运行时由 RTL 自身提供
  export const waitFor: (callback: () => void | Promise<void>, options?: { timeout?: number; interval?: number }) => Promise<void>
  // 为 TS 类型补充 renderHook，运行时由 RTL 自身提供
  export function renderHook<Result, Props = void>(
    callback: (initialProps: Props) => Result,
    options?: {
      initialProps?: Props
      wrapper?: React.ComponentType<{ children: React.ReactNode }>
    }
  ): {
    result: { current: Result }
    rerender: (newProps?: Props) => void
    unmount: () => void
  }
}

