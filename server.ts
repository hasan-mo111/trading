import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { bot } from './src/bot.ts';

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

// Basic route to serve the trading page (keep it available just in case)
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'trading-page.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    
    // Initialize Bot
    if (bot) {
        bot.launch().then(() => console.log('🤖 Telegram Bot is online and listening.'));
    } else {
        console.log('⚠️ Telegram Bot Token not provided, bot is offline. Set TELEGRAM_BOT_TOKEN.');
    }
});
