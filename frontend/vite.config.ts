import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  server: { port: 5173, host: true },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes('libp2p') || id.includes('@libp2p') ? 'libp2p' : undefined) },
    },
  },
  optimizeDeps: {
    include: ['libp2p', '@libp2p/webrtc', '@libp2p/websockets', '@libp2p/gossipsub', 'uint8arrays'],
  },
})
