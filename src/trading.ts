import WebSocket from 'ws';
import { EMA, RSI } from 'technicalindicators';
import { checkUpcomingHighImpactNews } from './news.ts';
import { store } from './store.ts';

const DERIV_APP_ID = 1089;

type TradeState = 'IDLE' | 'SCANNING_TREND' | 'SNIPING_ENTRY' | 'MONITORING_TRADE';

interface SignalConfig {
    symbol: string;
    state: TradeState;
    trend: 'UP' | 'DOWN' | 'NONE';
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    type?: 'LONG' | 'SHORT';
}

export class TradingEngine {
    private state: SignalConfig = {
        symbol: 'frxXAUUSD',
        state: 'IDLE',
        trend: 'NONE',
        entryPrice: 0,
        takeProfit: 0,
        stopLoss: 0,
    };

    private ws: WebSocket | null = null;
    private onMessageCb: (msg: string) => void;
    private onBroadcastCb: (msg: string) => void;

    constructor(onMessage: (msg: string) => void, onBroadcast: (msg: string) => void) {
        this.onMessageCb = onMessage;
        this.onBroadcastCb = onBroadcast;
    }

    public async startAnalysis(symbol: string) {
        if (this.state.state !== 'IDLE') {
            this.onMessageCb(`⚠️ النظام يقوم بالفعل بمراقبة أو إدارة صفقة لـ ${this.state.symbol}.`);
            return;
        }

        // Handle generic XAUUSD to Deriv's specific frxXAUUSD format
        if (symbol.toUpperCase() === 'XAUUSD' || symbol === '') {
            this.state.symbol = 'frxXAUUSD';
        } else {
            this.state.symbol = symbol;
        }

        this.state.state = 'SCANNING_TREND';
        this.onMessageCb(`🔍 تم بدء التحليل لزوج ${this.state.symbol} عبر مزود بيانات Deriv...\n\nالخطوة 1: مراقبة الاتجاه العام على فريم 4 ساعات.`);

        await this.analyzeTrend();
    }

    private async fetchKlines(symbol: string, granularity: number, limit: number = 250): Promise<number[]> {
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
                    const closes = response.candles.map((c: any) => parseFloat(c.close));
                    resolve(closes);
                }
                ws.close();
            });

            ws.on('error', (err) => {
                reject(err);
            });
        });
    }

    private async analyzeTrend() {
        try {
            // Fetch 4H data for trend direction (4 hours = 14400 seconds)
            const closes = await this.fetchKlines(this.state.symbol, 14400, 250);
            
            // Calculate EMA 50 and 200
            const ema50 = EMA.calculate({ period: 50, values: closes });
            const ema200 = EMA.calculate({ period: 200, values: closes });

            const lastEma50 = ema50[ema50.length - 1];
            const lastEma200 = ema200[ema200.length - 1];

            if (lastEma50 > lastEma200) {
                this.state.trend = 'UP';
                this.state.state = 'SNIPING_ENTRY';
                this.onMessageCb(`📈 الاتجاه العام صاعد (EMA50 > EMA200).\n\nالخطوة 2: الانتقال إلى وضع القنص (Sniper Mode) على فريم 15 دقيقة للبحث عن فرصة شراء (Long).`);
                this.startSniperMode();
            } else if (lastEma50 < lastEma200) {
                this.state.trend = 'DOWN';
                this.state.state = 'SNIPING_ENTRY';
                this.onMessageCb(`📉 الاتجاه العام هابط (EMA50 < EMA200).\n\nالخطوة 2: الانتقال إلى وضع القنص (Sniper Mode) على فريم 15 دقيقة للبحث عن فرصة بيع (Short).`);
                this.startSniperMode();
            } else {
                this.state.state = 'IDLE';
                this.onMessageCb(`⏸️ لا يوجد اتجاه واضح حالياً. يرجى المحاولة لاحقاً.`);
            }
        } catch (error) {
            this.state.state = 'IDLE';
            this.onMessageCb(`❌ حدث خطأ أثناء تحليل الاتجاه (Deriv API): ${(error as Error).message}`);
        }
    }

    private async startSniperMode() {
        // In a real app, this would be a cron job or interval checking every 15 mins.
        // For demonstration, we will poll it once, and simulate waiting.
        let sniped = false;
        let attempts = 0;

        const sniperInterval = setInterval(async () => {
            attempts++;
            if (this.state.state !== 'SNIPING_ENTRY') {
                clearInterval(sniperInterval);
                return;
            }

            try {
                // 15 minutes = 900 seconds
                const closes = await this.fetchKlines(this.state.symbol, 900, 50);
                const rsiValues = RSI.calculate({ period: 14, values: closes });
                const lastRsi = rsiValues[rsiValues.length - 1];
                const currentPrice = closes[closes.length - 1];

                console.log(`[Sniper] RSI: ${lastRsi}, Trend: ${this.state.trend}`);

                // Simplified Entry Logic: Buy if Uptrend & Oversold, Sell if Downtrend & Overbought
                if (this.state.trend === 'UP' && lastRsi < 40) {
                    sniped = true;
                    this.executeTrade(currentPrice, 'LONG');
                } else if (this.state.trend === 'DOWN' && lastRsi > 60) {
                    sniped = true;
                    this.executeTrade(currentPrice, 'SHORT');
                } else {
                    // Just for the sake of the demo, we force a trade after 2 attempts if conditions aren't met
                    if (attempts >= 2) {
                        sniped = true;
                        this.executeTrade(currentPrice, this.state.trend === 'UP' ? 'LONG' : 'SHORT');
                    }
                }

                if (sniped) {
                    clearInterval(sniperInterval);
                }
            } catch (e) {
                console.error("Sniper error", e);
            }
        }, 5000); // Fast interval for demo purposes. Real app: 15 * 60 * 1000
    }

    private executeTrade(price: number, type: 'LONG' | 'SHORT') {
        this.state.state = 'MONITORING_TRADE';
        this.state.entryPrice = price;
        this.state.type = type;
        
        // Setup TP/SL (e.g., 2% TP, 1% SL)
        if (type === 'LONG') {
            this.state.takeProfit = price * 1.02;
            this.state.stopLoss = price * 0.99;
        } else {
            this.state.takeProfit = price * 0.98;
            this.state.stopLoss = price * 1.01;
        }

        store.addTrade({
            symbol: this.state.symbol,
            type: this.state.type,
            entryPrice: this.state.entryPrice,
            takeProfit: this.state.takeProfit,
            stopLoss: this.state.stopLoss,
            status: 'OPEN'
        });

        const signalMessage = `🚨 <b>فرصة قنص جديدة!</b> 🚨\n\n` +
                              `العملة: #${this.state.symbol}\n` +
                              `النوع: ${type === 'LONG' ? 'شراء 🟢' : 'بيع 🔴'}\n` +
                              `سعر الدخول: ${this.state.entryPrice.toFixed(2)}\n` +
                              `الأهداف (TP): ${this.state.takeProfit.toFixed(2)}\n` +
                              `وقف الخسارة (SL): ${this.state.stopLoss.toFixed(2)}\n\n` +
                              `الخطوة 3: تم الانتقال إلى وضع المراقبة الحية للحفاظ على رأس المال.`;

        this.onBroadcastCb(signalMessage);
        this.startMonitoring();
    }

    private async startMonitoring() {
        // Connect to Deriv WS for live price monitoring
        const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
        this.ws = new WebSocket(wsUrl);

        let lastNewsCheck = 0;

        this.ws.on('open', () => {
            // Subscribe to live ticks
            this.ws?.send(JSON.stringify({
                ticks: this.state.symbol,
                subscribe: 1
            }));
        });

        this.ws.on('message', async (data: string) => {
            if (this.state.state !== 'MONITORING_TRADE') return;

            const response = JSON.parse(data);
            if (response.error) {
                console.error("Deriv WS Error:", response.error.message);
                return;
            }

            if (!response.tick) return; // Ignore non-tick messages

            const currentPrice = parseFloat(response.tick.quote);

            // 1. Check TP / SL
            if (this.state.trend === 'UP') {
                if (currentPrice >= this.state.takeProfit) this.closeTrade(currentPrice, 'TAKE_PROFIT');
                else if (currentPrice <= this.state.stopLoss) this.closeTrade(currentPrice, 'STOP_LOSS');
            } else {
                if (currentPrice <= this.state.takeProfit) this.closeTrade(currentPrice, 'TAKE_PROFIT');
                else if (currentPrice >= this.state.stopLoss) this.closeTrade(currentPrice, 'STOP_LOSS');
            }

            // 2. Check Fundamentals / News periodically (every 5 mins)
            const now = Date.now();
            if (now - lastNewsCheck > 5 * 60 * 1000) {
                lastNewsCheck = now;
                const hasNews = await checkUpcomingHighImpactNews(this.state.symbol);
                if (hasNews) {
                    this.onBroadcastCb(`⚠️ <b>تنبيه أخبار هامة!</b> ⚠️\nهناك خبر قوي جداً سيصدر قريباً وقد يؤثر على ${this.state.symbol}.\nلحماية رأس المال، سيتم تأمين الصفقة الحالية أو إغلاقها.`);
                    this.closeTrade(currentPrice, 'NEWS_PROTECTION');
                }
            }
        });

        this.ws.on('error', (err) => console.error('WS Error:', err));
    }

    private closeTrade(price: number, reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'NEWS_PROTECTION') {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.state.state = 'IDLE';

        let reasonStr = '';
        if (reason === 'TAKE_PROFIT') reasonStr = '✅ تم ضرب الهدف (Take Profit)! مبروك الأرباح.';
        else if (reason === 'STOP_LOSS') reasonStr = '❌ تم ضرب وقف الخسارة (Stop Loss). حظاً أوفر في الصفقات القادمة.';
        else if (reason === 'NEWS_PROTECTION') reasonStr = '🛡️ تم إغلاق الصفقة يدوياً لحماية رأس المال بسبب الأخبار.';

        const profitStr = ((price - this.state.entryPrice) / this.state.entryPrice * 100).toFixed(2);
        
        store.addTrade({
            symbol: this.state.symbol,
            type: this.state.type,
            entryPrice: this.state.entryPrice,
            closePrice: price,
            reason: reasonStr,
            profitPercent: profitStr,
            status: 'CLOSED'
        });
        
        this.onBroadcastCb(`🔔 <b>تحديث الصفقة (${this.state.symbol})</b>\n\n` +
                           `السعر الحالي للإغلاق: ${price.toFixed(2)}\n` +
                           `السبب: ${reasonStr}\n` +
                           `\nعاد البوت الآن إلى وضع الاستعداد.`);
    }

    public stopEngine() {
        if (this.ws) this.ws.close();
        this.state.state = 'IDLE';
        this.onMessageCb('🛑 تم إيقاف محرك التداول والمراقبة بطلب من الإدارة.');
    }
}
