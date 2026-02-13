import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  server: { port: 5173, host: true },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    // 性能优化：树摇，排除开发依赖
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // 代码分割：libp2p 单独打包
        manualChunks: (id) => {
          if (id.includes('libp2p') || id.includes('@libp2p')) {
            return 'libp2p'
          }
          if (id.includes('node_modules')) {
            // 将大型依赖单独打包
            if (id.includes('ethers')) return 'ethers'
            if (id.includes('react')) return 'react-vendor'
          }
          return undefined
        },
      },
      // 排除开发依赖（减小 bundle 大小）
      external: process.env.VITE_BASE === './' ? [] : undefined,
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2020',
    },
    // 仅包含生产依赖
    include: [
      'libp2p',
      '@libp2p/webrtc',
      '@libp2p/websockets',
      '@libp2p/tcp',
      '@libp2p/gossipsub',
      'uint8arrays',
      'ethers',
      'react',
      'react-dom',
    ],
    // 排除开发依赖
    exclude: ['@vitejs/plugin-react'],
  },
})
