import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const socket = io();

export default function App() {
  const [prices, setPrices] = useState<Record<string, { price: number, timestamp: number }>>({});

  useEffect(() => {
    socket.on('priceUpdate', (data: { symbol: string, price: number, timestamp: number }) => {
      setPrices(prev => ({
        ...prev,
        [data.symbol]: { price: data.price, timestamp: data.timestamp }
      }));
    });

    return () => {
      socket.off('priceUpdate');
    };
  }, []);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">Forex Paper Trading</h1>
      <div className="grid gap-4">
        {Object.entries(prices).map(([symbol, { price, timestamp }]) => (
          <div key={symbol} className="p-4 border border-gray-200 rounded">
            <h2 className="text-xl font-semibold">{symbol}</h2>
            <p className="text-2xl font-mono">{price.toFixed(5)}</p>
            <p className="text-sm text-gray-500">Last Update: {new Date(timestamp).toLocaleTimeString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
