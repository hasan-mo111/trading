import WebSocket from 'ws';
import { EMA, RSI, ADX, MACD, BollingerBands, ATR } from 'technicalindicators';
import { checkUpcomingHighImpactNews } from './news.ts';
import { store } from './store.ts';

const DERIV_APP_ID = 1089;

const TOP_10_PAIRS = [
    'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxUSDCHF', 
    'frxAUDUSD', 'frxUSDCAD', 'frxNZDUSD', 'frxEURGBP', 
    'frxEURJPY', 'frxXAUUSD'
];

interface Candle {
    high: number;
    low: number;
    close: number;
    open: number;
}

export interface TradeSetup {
    symbol: string;
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    reason: string;
}

export class TradingEngine {
    private isScanning = false;
    private scanInterval: NodeJS.Timeout | null = null;
    private monitorWs: WebSocket | null = null;
    private activeTrades = new Map<string, TradeSetup>();
    
    private onMessageCb: (msg: string) => void;
    private onBroadcastCb: (msg: string) => void;

    constructor(onMessage: (msg: string) => void, onBroadcast: (msg: string) => void) {
        this.onMessageCb = onMessage;
        this.onBroadcastCb = onBroadcast;
    }

    public async startAnalysis(symbol: string) {
        if (this.isScanning) {
            this.onMessageCb(`⚠️ النظام يقوم بالفعل بالبحث عن صفقات.`);
            return;
        }

        const pairsToScan = (symbol && symbol.trim() !== '') 
            ? [symbol.toUpperCase() === 'XAUUSD' ? 'frxXAUUSD' : symbol] 
            : TOP_10_PAIRS;

        this.isScanning = true;
        this.onMessageCb(`🔍 تم تشغيل رادار القنص المتقدم...\n\nجاري مسح الأزواج التالية:\n${pairsToScan.join(', ')}\n\nيتم تحديد نوع السوق (عرضي/صاعد/هابط) واستخدام مدارس تحليل مختلفة بـ (R:R 1:2).`);
        
        // Scan immediately, then every 15 minutes
        this.scanPairs(pairsToScan);
        this.scanInterval = setInterval(() => this.scanPairs(pairsToScan), 15 * 60 * 1000);
        
        // Start live monitor connection
        this.startMonitoringWs();
    }

    private async scanPairs(pairs: string[]) {
        for (const sym of pairs) {
            if (this.activeTrades.has(sym)) continue; // Skip if already have an active trade for this pair

            try {
                await new Promise(res => setTimeout(res, 1000)); // Delay between pairs to avoid rate limits
                const signal = await this.analyzePair(sym);
                if (signal) {
                    this.executeTrade(signal);
                }
            } catch (err) {
                console.error(`Error scanning ${sym}:`, err);
            }
        }
    }

    private async fetchKlines(symbol: string, granularity: number, limit: number = 250): Promise<Candle[]> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`);
            
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count: limit,
                    end: "latest",
                    style: "candles",
                    granularity: granularity // Timeframe in seconds
                }));
            });

            ws.on('message', (data: string) => {
                const response = JSON.parse(data);
                if (response.error) {
                    reject(new Error(response.error.message));
                } else if (response.candles) {
                    const candles = response.candles.map((c: any) => ({
                        high: parseFloat(c.high),
                        low: parseFloat(c.low),
                        close: parseFloat(c.close),
                        open: parseFloat(c.open)
                    }));
                    resolve(candles);
                }
                ws.close();
            });

            ws.on('error', (err) => reject(err));
        });
    }

    private async analyzePair(symbol: string): Promise<TradeSetup | null> {
        // 1. Fetch 4H Context
        const h4Candles = await this.fetchKlines(symbol, 14400, 150);
        if (h4Candles.length < 50) return null;
        
        const h4Highs = h4Candles.map(c => c.high);
        const h4Lows = h4Candles.map(c => c.low);
        const h4Closes = h4Candles.map(c => c.close);

        const adxResult = ADX.calculate({ high: h4Highs, low: h4Lows, close: h4Closes, period: 14 });
        const lastAdx = adxResult[adxResult.length - 1];
        
        const ema50 = EMA.calculate({ period: 50, values: h4Closes });
        const ema200 = EMA.calculate({ period: 200, values: h4Closes });
        const lastEma50 = ema50[ema50.length - 1];
        const lastEma200 = ema200[ema200.length - 1];

        // Market Context Detection
        let context: 'TREND_UP' | 'TREND_DOWN' | 'RANGING' = 'RANGING';
        if (lastAdx.adx > 25) {
            if (lastEma50 > lastEma200) context = 'TREND_UP';
            else if (lastEma50 < lastEma200) context = 'TREND_DOWN';
        }

        // 2. Fetch 15m for precision entry
        const m15Candles = await this.fetchKlines(symbol, 900, 100);
        const m15Highs = m15Candles.map(c => c.high);
        const m15Lows = m15Candles.map(c => c.low);
        const m15Closes = m15Candles.map(c => c.close);
        const currentPrice = m15Closes[m15Closes.length - 1];

        // Use ATR for dynamic Volatility-based Stop Loss & Take Profit (Guarantee 1:2 R:R)
        const atrResult = ATR.calculate({ high: m15Highs, low: m15Lows, close: m15Closes, period: 14 });
        const currentAtr = atrResult[atrResult.length - 1];

        let signal: TradeSetup | null = null;

        if (context === 'TREND_UP' || context === 'TREND_DOWN') {
            // Strategy: Trend Following (MACD Momentum + Trend Alignment)
            const macdResult = MACD.calculate({ values: m15Closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
            const lastMacd = macdResult[macdResult.length - 1];

            if (context === 'TREND_UP' && lastMacd.MACD! > lastMacd.signal!) {
                signal = {
                    symbol, type: 'LONG', entryPrice: currentPrice,
                    stopLoss: currentPrice - (1.5 * currentAtr),
                    takeProfit: currentPrice + (3.0 * currentAtr), // 1:2 R:R
                    reason: 'السوق في ترند صاعد قوي (ADX>25) 📈 + تأكيد الزخم الشرائي بتقاطع MACD إيجابي.'
                };
            } else if (context === 'TREND_DOWN' && lastMacd.MACD! < lastMacd.signal!) {
                signal = {
                    symbol, type: 'SHORT', entryPrice: currentPrice,
                    stopLoss: currentPrice + (1.5 * currentAtr),
                    takeProfit: currentPrice - (3.0 * currentAtr), // 1:2 R:R
                    reason: 'السوق في ترند هابط قوي (ADX>25) 📉 + تأكيد الزخم البيعي بتقاطع MACD سلبي.'
                };
            }
        } else {
            // Strategy: Range Bound / Mean Reversion (Bollinger Bands Fade + RSI Overbought/Oversold)
            const bbResult = BollingerBands.calculate({ period: 20, values: m15Closes, stdDev: 2 });
            const rsiResult = RSI.calculate({ period: 14, values: m15Closes });
            const lastBb = bbResult[bbResult.length - 1];
            const lastRsi = rsiResult[rsiResult.length - 1];

            if (currentPrice <= lastBb.lower && lastRsi < 35) {
                signal = {
                    symbol, type: 'LONG', entryPrice: currentPrice,
                    stopLoss: currentPrice - (1 * currentAtr),
                    takeProfit: currentPrice + (2 * currentAtr), // 1:2 R:R
                    reason: 'السوق في مسار عرضي (ADX<25) ↔️ + ارتداد من قاع البولينجر باند + تشبع بيعي RSI (مدرسة العودة للمتوسط).'
                };
            } else if (currentPrice >= lastBb.upper && lastRsi > 65) {
                signal = {
                    symbol, type: 'SHORT', entryPrice: currentPrice,
                    stopLoss: currentPrice + (1 * currentAtr),
                    takeProfit: currentPrice - (2 * currentAtr), // 1:2 R:R
                    reason: 'السوق في مسار عرضي (ADX<25) ↔️ + ارتداد من قمة البولينجر باند + تشبع شرائي RSI (مدرسة العودة للمتوسط).'
                };
            }
        }

        return signal;
    }

    private executeTrade(trade: TradeSetup) {
        this.activeTrades.set(trade.symbol, trade);

        store.addTrade({
            symbol: trade.symbol,
            type: trade.type,
            entryPrice: trade.entryPrice,
            takeProfit: trade.takeProfit,
            stopLoss: trade.stopLoss,
            status: 'OPEN'
        });

        const signalMessage = `🚨 <b>فرصة قنص جديدة تم التقاطها!</b> 🚨\n\n` +
                              `الزوج: #${trade.symbol}\n` +
                              `النوع: ${trade.type === 'LONG' ? 'شراء 🟢' : 'بيع 🔴'}\n` +
                              `السعر: ${trade.entryPrice.toFixed(4)}\n` +
                              `الأهداف: ${trade.takeProfit.toFixed(4)}\n` +
                              `الوقف: ${trade.stopLoss.toFixed(4)}\n` +
                              `مخاطرة/عائد (R:R): 1:2 ⚖️\n\n` +
                              `📝 <b>سبب الدخول:</b>\n${trade.reason}\n\n` +
                              `الرادار مستمر بمراقبة الصفقة لحظياً 👁️`;

        this.onBroadcastCb(signalMessage);

        // Make sure live WS is tracking this symbol
        if (this.monitorWs && this.monitorWs.readyState === WebSocket.OPEN) {
            this.monitorWs.send(JSON.stringify({ ticks: trade.symbol, subscribe: 1 }));
        }
    }

    private startMonitoringWs() {
        if (this.monitorWs) return;

        this.monitorWs = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`);
        let lastNewsCheck = 0;

        this.monitorWs.on('open', () => {
            // Subscribe to all currently active trades
            for (const sym of this.activeTrades.keys()) {
                this.monitorWs?.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
            }
        });

        this.monitorWs.on('message', async (data: string) => {
            const response = JSON.parse(data);
            if (response.error || !response.tick) return;

            const symbol = response.tick.symbol;
            const currentPrice = parseFloat(response.tick.quote);

            const trade = this.activeTrades.get(symbol);
            if (!trade) return;

            // Check TP / SL
            if (trade.type === 'LONG') {
                if (currentPrice >= trade.takeProfit) this.closeTrade(trade, currentPrice, 'TAKE_PROFIT');
                else if (currentPrice <= trade.stopLoss) this.closeTrade(trade, currentPrice, 'STOP_LOSS');
            } else {
                if (currentPrice <= trade.takeProfit) this.closeTrade(trade, currentPrice, 'TAKE_PROFIT');
                else if (currentPrice >= trade.stopLoss) this.closeTrade(trade, currentPrice, 'STOP_LOSS');
            }

            // Periodically check news (every 5 mins) to protect capital
            const now = Date.now();
            if (now - lastNewsCheck > 5 * 60 * 1000) {
                lastNewsCheck = now;
                const hasNews = await checkUpcomingHighImpactNews(symbol).catch(() => false);
                if (hasNews && this.activeTrades.has(symbol)) {
                    this.onBroadcastCb(`⚠️ <b>تنبيه أخبار هامة!</b> ⚠️\nخبر قوي سيصدر قريباً قد يعصف بـ ${symbol}.\nتم إغلاق الصفقة فوراً لحماية رأس المال.`);
                    this.closeTrade(trade, currentPrice, 'NEWS_PROTECTION');
                }
            }
        });

        this.monitorWs.on('close', () => {
            if (this.isScanning) {
                this.monitorWs = null;
                setTimeout(() => this.startMonitoringWs(), 5000); // Reconnect
            }
        });
    }

    private closeTrade(trade: TradeSetup, closePrice: number, reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'NEWS_PROTECTION') {
        this.activeTrades.delete(trade.symbol); // Remove from tracking

        let reasonStr = '';
        if (reason === 'TAKE_PROFIT') reasonStr = '✅ تم ضرب الهدف (Take Profit)! مبروك الأرباح. 🎯';
        else if (reason === 'STOP_LOSS') reasonStr = '❌ تم ضرب وقف الخسارة (Stop Loss).';
        else if (reason === 'NEWS_PROTECTION') reasonStr = '🛡️ إغلاق وقائي بسبب الأخبار.';

        const profitCalc = trade.type === 'LONG' ? (closePrice - trade.entryPrice) : (trade.entryPrice - closePrice);
        const profitPercent = (profitCalc / trade.entryPrice * 100).toFixed(2);
        
        store.addTrade({
            symbol: trade.symbol,
            type: trade.type,
            entryPrice: trade.entryPrice,
            closePrice: closePrice,
            reason: reasonStr,
            profitPercent: profitPercent,
            status: 'CLOSED'
        });
        
        this.onBroadcastCb(`🔔 <b>إغلاق صفقة (${trade.symbol})</b>\n\n` +
                           `السعر وقت الإغلاق: ${closePrice.toFixed(4)}\n` +
                           `النتيجة: ${reasonStr} (${profitPercent}%)\n`);
    }

    public stopEngine() {
        this.isScanning = false;
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.monitorWs) this.monitorWs.close();
        this.monitorWs = null;
        this.activeTrades.clear();
        this.onMessageCb('🛑 تم إيقاف رادار الصفقات ومحرك المراقبة بنجاح.');
    }
}

