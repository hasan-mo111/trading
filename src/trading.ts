import WebSocket from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import { checkUpcomingHighImpactNews } from './news.ts';
import { store } from './store.ts';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

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
    private lastScanTime: Date | null = null;
    private scanCount: number = 0;
    
    private onMessageCb: (msg: string) => void;
    private onBroadcastCb: (msg: string) => void;

    constructor(onMessage: (msg: string) => void, onBroadcast: (msg: string) => void) {
        this.onMessageCb = onMessage;
        this.onBroadcastCb = onBroadcast;
    }

    public getStatus(): string {
        if (!this.isScanning) {
            return '⚪ الرادار متوقف حالياً. (استخدم /analyze للتشغيل)';
        }
        
        const activeCount = this.activeTrades.size;
        const scanTimeStr = this.lastScanTime ? this.lastScanTime.toLocaleTimeString('ar-EG', { timeZone: 'Asia/Riyadh' }) : 'لم يتم المسح بعد';
        
        let statusMsg = `🟢 <b>حالة الرادار: نشط</b>\n\n`;
        statusMsg += `🔄 عدد دورات المسح المكتملة: ${this.scanCount}\n`;
        statusMsg += `⏱️ آخر مسح تم في: ${scanTimeStr} (بتوقيت السعودية)\n`;
        statusMsg += `📈 الصفقات المفتوحة حالياً: ${activeCount}\n`;
        
        if (activeCount > 0) {
            statusMsg += `\nالأزواج النشطة: ` + Array.from(this.activeTrades.keys()).join(', ');
        }
        
        return statusMsg;
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
        let newTrades = 0;
        for (const sym of pairs) {
            if (this.activeTrades.has(sym)) continue; // Skip if already have an active trade for this pair

            try {
                await new Promise(res => setTimeout(res, 6000)); // تأخير 6 ثواني لتفادي حظر الطلبات السريعة (429 Rate Limits)
                const signal = await this.analyzePair(sym);
                if (signal) {
                    this.executeTrade(signal);
                    newTrades++;
                }
            } catch (err) {
                console.error(`Error scanning ${sym}:`, err);
            }
        }
        
        this.lastScanTime = new Date();
        this.scanCount++;

        if (this.scanCount === 1 && newTrades === 0) {
            this.onMessageCb('✅ اكتملت دورة المسح الأولى!\nلم يتم العثور على فرص تطابق الشروط الصارمة حالياً.\nالرادار مستمر في الخلفية (كل 15 دقيقة) وسيعلمك فور التقاط فرصة ذهبية.');
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
        // Fetch last 30 candles on 15m timeframe for precision analysis
        const m15Candles = await this.fetchKlines(symbol, 900, 30);
        if (m15Candles.length < 30) return null;
        
        const currentPrice = m15Candles[m15Candles.length - 1].close;

        // Format candles for Gemini
        const candlesData = m15Candles.map((c, i) => 
            `Candle ${i+1}: Open=${c.open}, High=${c.high}, Low=${c.low}, Close=${c.close}`
        ).join('\n');

        const prompt = `
أنت متداول محترف في الفوركس و محلل فني خبير يدمج بين مدارس متعددة (Price Action, Smart Money Concepts, ICT, العرض والطلب, والمؤشرات الفنية).
يجب عليك تحليل آخر 30 شمعة (فريم 15 دقيقة) للزوج: ${symbol}

بيانات الشموع:
${candlesData}

المطلوب:
1. قم بتحليل الاتجاه العام وهيكل السوق (Market Structure).
2. حدد ما إذا كان هناك فرصة تداول قوية (Long أو Short) أو إذا كان الأفضل البقاء خارج السوق (No Trade).
3. **شرط صارم جداً:** يجب أن تكون نسبة العائد إلى المخاطرة (Reward to Risk Ratio) لا تقل عن 1:2 أو أعلى. (أي أن المسافة من نقطة الدخول إلى الهدف يجب أن تكون ضعف المسافة من نقطة الدخول إلى وقف الخسارة على الأقل).
4. اذكر سبب الدخول بوضوح وبشكل مقنع يشرح المدرسة الفنية المستخدمة.

قم بإرجاع النتيجة بصيغة JSON فقط متوافقة مع هذا الهيكل:
`;

        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            hasTrade: {
                                type: Type.BOOLEAN,
                                description: "هل توجد فرصة تداول قوية تلبي جميع الشروط؟"
                            },
                            type: {
                                type: Type.STRING,
                                description: "LONG أو SHORT (فقط في حال وجود فرصة)"
                            },
                            entryPrice: {
                                type: Type.NUMBER,
                                description: "سعر الدخول المقترح"
                            },
                            stopLoss: {
                                type: Type.NUMBER,
                                description: "سعر وقف الخسارة"
                            },
                            takeProfit: {
                                type: Type.NUMBER,
                                description: "سعر أخذ الربح (يجب أن يحقق R:R 1:2 على الأقل)"
                            },
                            reason: {
                                type: Type.STRING,
                                description: "سبب الدخول باختصار مع ذكر المدرسة الفنية المستخدمة باللغة العربية"
                            }
                        },
                        required: ["hasTrade", "reason"]
                    },
                    temperature: 0.2, // Low temperature for more analytical/consistent logic
                }
            });

            if (!response.text) return null;

            const aiAnalysis = JSON.parse(response.text.trim());

            if (!aiAnalysis.hasTrade) {
                return null; // No setup identified by Gemini
            }

            // Fallback safety check: verify R:R ratio programmatically
            const entry = aiAnalysis.entryPrice;
            const sl = aiAnalysis.stopLoss;
            const tp = aiAnalysis.takeProfit;

            if (!entry || !sl || !tp) return null;

            const risk = Math.abs(entry - sl);
            const reward = Math.abs(tp - entry);

            if (risk === 0 || reward / risk < 1.9) {
                // R:R is less than ~2, reject this setup
                console.log(`[Gemini] Rejected ${symbol} trade due to bad R:R. Risk: ${risk}, Reward: ${reward}`);
                return null;
            }
            
            // Ensure logic matches LONG/SHORT
            if (aiAnalysis.type === 'LONG' && tp < entry) return null;
            if (aiAnalysis.type === 'SHORT' && tp > entry) return null;

            return {
                symbol,
                type: aiAnalysis.type as 'LONG' | 'SHORT',
                entryPrice: currentPrice, // Execute at current market price
                stopLoss: sl,
                takeProfit: tp,
                reason: `🤖 (تحليل الذكاء الاصطناعي - Gemini):\n` + aiAnalysis.reason
            };

        } catch (error) {
            console.error("Gemini Analysis Error:", error);
            return null;
        }
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

