import { useEffect, useState } from 'react'
import { Order } from '../p2p/types'

interface OrderBookData {
  pair: string
  bids: Order[]
  asks: Order[]
}

export function useOrderBook(pair: string) {
  const [orderBook, setOrderBook] = useState<OrderBookData>({
    pair,
    bids: [],
    asks: [],
  })

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const customEvent = event as CustomEvent
      const { pair: eventPair, bids, asks } = customEvent.detail
      if (eventPair === pair) {
        setOrderBook({ pair, bids, asks })
      }
    }

    window.addEventListener('orderbook-update', handleUpdate)

    return () => {
      window.removeEventListener('orderbook-update', handleUpdate)
    }
  }, [pair])

  return orderBook
}
