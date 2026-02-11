/**
 * 虚拟滚动：只渲染可见区域 + overscan，减少大量订单时的 DOM 数量
 */
import { useRef, useState, useLayoutEffect } from 'react'

export interface VirtualListProps<T> {
  items: T[]
  itemHeight: number
  height: number
  overscan?: number
  getKey: (item: T, index: number) => string
  children: (item: T, index: number) => React.ReactNode
  className?: string
}

export function VirtualList<T>({
  items,
  itemHeight,
  height,
  overscan = 3,
  getKey,
  children,
  className = '',
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  const totalHeight = items.length * itemHeight
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const visibleCount = Math.ceil(height / itemHeight) + overscan * 2
  const endIndex = Math.min(items.length, startIndex + visibleCount)
  const visibleItems = items.slice(startIndex, endIndex)
  const offsetY = startIndex * itemHeight

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      ref={containerRef}
      className={`virtual-list ${className}`}
      style={{
        height,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100%',
            transform: `translateY(${offsetY}px)`,
          }}
        >
          {visibleItems.map((item, i) => {
            const index = startIndex + i
            return (
              <div
                key={getKey(item, index)}
                style={{ height: itemHeight, minHeight: itemHeight }}
              >
                {children(item, index)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
