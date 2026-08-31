import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { bot, engine } from './src/bot.ts';
import { store } from './src/store.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Basic route to check if server is running
app.get('/api/health', (req, res) => {
    res.json({ status: 'active', message: 'Trading Backend is running successfully.' });
});

app.get('/api/stats', (req, res) => {
    const activeTrades = engine.getActiveTrades();
    const trades = store.getTrades();
    
    // Filter out only CLOSED trades since activeTrades handles OPEN
    const closedTrades = trades.filter((t: any) => t.status === 'CLOSED');
    
    let totalProfitPercent = 0;
    let dailyProfitPercent = 0;
    
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    closedTrades.forEach((t: any) => {
        const profit = parseFloat(t.profitPercent) || 0;
        totalProfitPercent += profit;
        
        if (now - t.timestamp <= oneDay) {
            dailyProfitPercent += profit;
        }
    });

    res.json({
        activeTrades,
        closedTrades,
        totalProfitPercent: totalProfitPercent.toFixed(2),
        dailyProfitPercent: dailyProfitPercent.toFixed(2)
    });
});

// Basic route to serve the trading page (keep it available just in case)
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'trading-page.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    
    // Initialize Bot
    if (bot) {
        bot.launch().then(() => console.log('🤖 Telegram Bot is online and listening.'))
           .catch((err) => {
               console.error('⚠️ Could not start Telegram Bot. It may be running on another instance (e.g., Render).', err.message);
           });
    } else {
        console.log('⚠️ Telegram Bot Token not provided, bot is offline. Set TELEGRAM_BOT_TOKEN.');
    }
});
