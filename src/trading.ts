import WebSocket from 'ws';
import { SMA, MACD } from 'technicalindicators';
import { store } from './store.ts';

const DERIV_APP_ID = 1089;
const WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const SYMBOL = 'frxXAUUSD';

export interface TradeSetup {
    symbol: string;
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    reason: string;
    currentPrice?: number;
    currentPnLPercent?: string;
    contractId?: number;
    highestPriceReached?: number;
    lowestPriceReached?: number;
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

    private derivToken = process.env.DERIV_API_TOKEN || '';

    constructor(onMessage: (msg: string) => void, onBroadcast: (msg: string) => void) {
        this.onMessageCb = onMessage;
        this.onBroadcastCb = onBroadcast;
    }

    public getStatus(): string {
        if (!this.isScanning) {
            return '⚪ رادار الذهب متوقف حالياً. (استخدم /analyze للتشغيل)';
        }
        
        const activeCount = this.activeTrades.size;
        const scanTimeStr = this.lastScanTime ? this.lastScanTime.toLocaleTimeString('ar-EG', { timeZone: 'Asia/Riyadh' }) : 'لم يتم المسح بعد';
        
        let statusMsg = `🟢 <b>حالة رادار الذهب (Druckenmiller): نشط</b>\n\n`;
        statusMsg += `🔄 دورات المسح: ${this.scanCount}\n`;
        statusMsg += `⏱️ آخر مسح: ${scanTimeStr}\n`;
        statusMsg += `📈 صفقات الذهب النشطة: ${activeCount}\n`;
        
        return statusMsg;
    }

    public getActiveTrades(): TradeSetup[] {
        return Array.from(this.activeTrades.values());
    }

    public async startAnalysis(symbol?: string) {
        if (this.isScanning) {
            this.onMessageCb(`⚠️ النظام يقوم بالفعل بالبحث عن صفقات.`);
            return;
        }

        if (!this.derivToken) {
            this.onMessageCb(`⚠️ يرجى إضافة DERIV_API_TOKEN في الإعدادات للتمكن من فتح الصفقات وتتبعها.`);
        }

        this.isScanning = true;
        this.onMessageCb(`🔍 تم تشغيل رادار قنص الذهب باستراتيجية (Druckenmiller)...\nجاري مراقبة XAU/USD بدقة للبحث عن فرص...`);
        
        this.scanXAUUSD();
        this.scanInterval = setInterval(() => this.scanXAUUSD(), 15 * 60 * 1000); // 15m
        
        this.startMonitoringWs();
    }

    private async fetchKlines(symbol: string, granularity: number, limit: number = 250): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(WS_URL);
            
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error(`WebSocket Timeout`));
            }, 10000);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count: limit,
                    end: "latest",
                    style: "candles",
                    granularity: granularity
                }));
            });

            ws.on('message', (data: string) => {
                clearTimeout(timeout);
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

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    private async checkMacroTrend(): Promise<'UP' | 'DOWN' | 'NEUTRAL'> {
        // Daily candles (86400 seconds)
        const dailyCandles = await this.fetchKlines(SYMBOL, 86400, 200).catch(() => []);
        if (dailyCandles.length < 200) return 'NEUTRAL';

        const closes = dailyCandles.map(c => c.close);
        const sma200 = SMA.calculate({ period: 200, values: closes });
        
        if (sma200.length === 0) return 'NEUTRAL';
        
        const currentPrice = closes[closes.length - 1];
        const currentSma = sma200[sma200.length - 1];

        return currentPrice > currentSma ? 'UP' : 'DOWN';
    }

    private async scanXAUUSD() {
        if (this.activeTrades.has(SYMBOL)) return; // Already in trade

        try {
            const macroTrend = await this.checkMacroTrend();
            
            // Fetch 15m candles for trigger
            const m15Candles = await this.fetchKlines(SYMBOL, 900, 100);
            if (m15Candles.length < 50) return;

            const closes = m15Candles.map(c => c.close);
            const currentPrice = closes[closes.length - 1];

            const macdInput = {
                values: closes,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            };

            const macdResult = MACD.calculate(macdInput);
            if (macdResult.length < 2) return;

            const lastMacd = macdResult[macdResult.length - 1];
            const prevMacd = macdResult[macdResult.length - 2];

            if (!lastMacd.histogram || !prevMacd.histogram) return;

            let setup: TradeSetup | null = null;

            // Long Trigger: Macro is UP, MACD Histogram crosses above 0
            if (macroTrend === 'UP' && prevMacd.histogram < 0 && lastMacd.histogram > 0) {
                setup = {
                    symbol: SYMBOL,
                    type: 'LONG',
                    entryPrice: currentPrice,
                    stopLoss: currentPrice * 0.995, // 0.5% Hard Stop
                    takeProfit: currentPrice * 1.02, // 2% Take Profit
                    reason: "📈 الاتجاه الكلي صاعد (السعر فوق MA 200 يومي). \nالزناد: تقاطع إيجابي MACD على فريم 15 دقيقة (Breakout Momentum)."
                };
            }
            // Short Trigger: Macro is DOWN, MACD Histogram crosses below 0
            else if (macroTrend === 'DOWN' && prevMacd.histogram > 0 && lastMacd.histogram < 0) {
                setup = {
                    symbol: SYMBOL,
                    type: 'SHORT',
                    entryPrice: currentPrice,
                    stopLoss: currentPrice * 1.005, // 0.5% Hard Stop
                    takeProfit: currentPrice * 0.98, // 2% Take Profit
                    reason: "📉 الاتجاه الكلي هابط (السعر تحت MA 200 يومي). \nالزناد: تقاطع سلبي MACD على فريم 15 دقيقة."
                };
            }

            if (setup) {
                await this.executeDerivTrade(setup);
            }

            this.lastScanTime = new Date();
            this.scanCount++;
        } catch (err) {
            console.error("Error scanning XAUUSD:", err);
        }
    }

    private async executeDerivTrade(trade: TradeSetup) {
        if (!this.derivToken) {
            // Paper trade simulation if no token
            this.handleTradeOpened(trade, null);
            return;
        }

        const ws = new WebSocket(WS_URL);
        
        ws.on('open', () => {
            ws.send(JSON.stringify({ authorize: this.derivToken }));
        });

        ws.on('message', (data: string) => {
            const res = JSON.parse(data);
            
            if (res.error) {
                this.onBroadcastCb(`❌ خطأ أثناء تنفيذ صفقة الذهب: ${res.error.message}`);
                ws.close();
                return;
            }

            if (res.msg_type === 'authorize') {
                // Execute Buy
                ws.send(JSON.stringify({
                    buy: 1,
                    price: 100, // example stake
                    parameters: {
                        amount: 10,
                        basis: "stake",
                        contract_type: trade.type === 'LONG' ? "MULTUP" : "MULTDOWN",
                        currency: "USD",
                        multiplier: 100,
                        symbol: trade.symbol
                    }
                }));
            }

            if (res.msg_type === 'buy') {
                const contractId = res.buy.contract_id;
                this.handleTradeOpened(trade, contractId);
                ws.close();
            }
        });
    }

    private handleTradeOpened(trade: TradeSetup, contractId: number | null) {
        trade.contractId = contractId || Math.floor(Math.random() * 1000000); // mock id if paper
        trade.highestPriceReached = trade.entryPrice;
        trade.lowestPriceReached = trade.entryPrice;
        
        this.activeTrades.set(trade.symbol, trade);

        store.addTrade({
            symbol: trade.symbol,
            type: trade.type,
            entryPrice: trade.entryPrice,
            takeProfit: trade.takeProfit,
            stopLoss: trade.stopLoss,
            status: 'OPEN'
        });

        const signalMessage = `🚨 <b>تم فتح صفقة ذهب (Druckenmiller Strategy)!</b> 🚨\n\n` +
                              `النوع: ${trade.type === 'LONG' ? 'شراء 🟢' : 'بيع 🔴'}\n` +
                              `السعر: ${trade.entryPrice.toFixed(2)}\n` +
                              `الوقف الصارم: ${trade.stopLoss.toFixed(2)}\n\n` +
                              `📝 <b>السبب:</b>\n${trade.reason}\n\n` +
                              `الرادار سيقوم بتتبع العقد لحظياً وتحريك الوقف (Trailing Stop) لتأمين الأرباح! 👁️`;

        this.onBroadcastCb(signalMessage);

        // If WS monitor is connected, subscribe to the new contract
        if (this.monitorWs && this.monitorWs.readyState === WebSocket.OPEN && this.derivToken && contractId) {
            this.monitorWs.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            }));
        }
    }

    private startMonitoringWs() {
        if (this.monitorWs) return;

        this.monitorWs = new WebSocket(WS_URL);
        let pingInterval: NodeJS.Timeout;

        this.monitorWs.on('open', () => {
            if (this.derivToken) {
                this.monitorWs!.send(JSON.stringify({ authorize: this.derivToken }));
            } else {
                // Paper mode tracking fallback via ticks
                this.monitorWs!.send(JSON.stringify({ ticks: SYMBOL }));
            }
            
            // Keep alive
            pingInterval = setInterval(() => {
                if (this.monitorWs?.readyState === WebSocket.OPEN) {
                    this.monitorWs.send(JSON.stringify({ ping: 1 }));
                }
            }, 30000);
        });

        this.monitorWs.on('message', async (data: string) => {
            const res = JSON.parse(data);

            if (res.msg_type === 'authorize') {
                // Re-subscribe to all active open contracts upon reconnection
                for (const trade of this.activeTrades.values()) {
                    if (trade.contractId) {
                        this.monitorWs!.send(JSON.stringify({
                            proposal_open_contract: 1,
                            contract_id: trade.contractId,
                            subscribe: 1
                        }));
                    }
                }
            }

            // Real Contract Tracking (Real-time tracking loop)
            if (res.msg_type === 'proposal_open_contract' && res.proposal_open_contract) {
                const contract = res.proposal_open_contract;
                const trade = Array.from(this.activeTrades.values()).find(t => t.contractId === contract.contract_id);
                if (!trade) return;

                const currentPrice = parseFloat(contract.current_spot);
                const profitPercent = parseFloat(contract.profit_percentage);
                trade.currentPrice = currentPrice;
                trade.currentPnLPercent = profitPercent.toFixed(2);

                if (contract.is_sold) {
                    this.closeTrade(trade, currentPrice, profitPercent > 0 ? 'TAKE_PROFIT' : 'STOP_LOSS', profitPercent);
                    return;
                }

                // Trailing Stop Logic (Druckenmiller Fast Cut & Let Profit Run)
                if (trade.type === 'LONG') {
                    if (currentPrice > (trade.highestPriceReached || trade.entryPrice)) {
                        trade.highestPriceReached = currentPrice;
                        // Move SL up if profit > 1%
                        if (currentPrice > trade.entryPrice * 1.01) {
                            const newSL = currentPrice * 0.995; // Trail by 0.5%
                            if (newSL > trade.stopLoss) {
                                trade.stopLoss = newSL;
                            }
                        }
                    }
                    
                    // Hard Close if below Stop Loss
                    if (currentPrice <= trade.stopLoss) {
                        this.sellContract(trade.contractId!, currentPrice, trade);
                    }
                } else {
                    if (currentPrice < (trade.lowestPriceReached || trade.entryPrice)) {
                        trade.lowestPriceReached = currentPrice;
                        if (currentPrice < trade.entryPrice * 0.99) {
                            const newSL = currentPrice * 1.005; // Trail by 0.5%
                            if (newSL < trade.stopLoss) {
                                trade.stopLoss = newSL;
                            }
                        }
                    }
                    if (currentPrice >= trade.stopLoss) {
                        this.sellContract(trade.contractId!, currentPrice, trade);
                    }
                }
            }

            // Paper Trading Fallback
            if (res.msg_type === 'tick' && !this.derivToken) {
                const currentPrice = parseFloat(res.tick.quote);
                const trade = this.activeTrades.get(SYMBOL);
                if (!trade) return;

                trade.currentPrice = currentPrice;
                
                const slDist = Math.abs(trade.entryPrice - trade.stopLoss);
                const moved = trade.type === 'LONG' ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
                trade.currentPnLPercent = ((moved / slDist) * 100).toFixed(2);

                if (trade.type === 'LONG') {
                    if (currentPrice > (trade.highestPriceReached || trade.entryPrice)) {
                        trade.highestPriceReached = currentPrice;
                        if (currentPrice > trade.entryPrice * 1.01) {
                            const newSL = currentPrice * 0.995;
                            if (newSL > trade.stopLoss) trade.stopLoss = newSL;
                        }
                    }
                    if (currentPrice <= trade.stopLoss) this.closeTrade(trade, currentPrice, 'STOP_LOSS', parseFloat(trade.currentPnLPercent));
                    else if (currentPrice >= trade.takeProfit) this.closeTrade(trade, currentPrice, 'TAKE_PROFIT', parseFloat(trade.currentPnLPercent));
                } else {
                    if (currentPrice < (trade.lowestPriceReached || trade.entryPrice)) {
                        trade.lowestPriceReached = currentPrice;
                        if (currentPrice < trade.entryPrice * 0.99) {
                            const newSL = currentPrice * 1.005;
                            if (newSL < trade.stopLoss) trade.stopLoss = newSL;
                        }
                    }
                    if (currentPrice >= trade.stopLoss) this.closeTrade(trade, currentPrice, 'STOP_LOSS', parseFloat(trade.currentPnLPercent));
                    else if (currentPrice <= trade.takeProfit) this.closeTrade(trade, currentPrice, 'TAKE_PROFIT', parseFloat(trade.currentPnLPercent));
                }
            }
        });

        this.monitorWs.on('close', () => {
            clearInterval(pingInterval);
            if (this.isScanning) {
                this.monitorWs = null;
                setTimeout(() => this.startMonitoringWs(), 3000); // Fast reconnect logic
            }
        });
    }

    private sellContract(contractId: number, currentPrice: number, trade: TradeSetup) {
        if (!this.monitorWs || this.monitorWs.readyState !== WebSocket.OPEN) return;
        this.monitorWs.send(JSON.stringify({
            sell: contractId,
            price: 0 // sell at market
        }));
    }

    private closeTrade(trade: TradeSetup, closePrice: number, reason: 'TAKE_PROFIT' | 'STOP_LOSS', finalProfitPercent: number) {
        this.activeTrades.delete(trade.symbol);

        let reasonStr = '';
        if (reason === 'TAKE_PROFIT') reasonStr = '✅ إغلاق رابح (Trailing/Take Profit)';
        else if (reason === 'STOP_LOSS') reasonStr = '❌ قطع الخسارة الصارم (Stop Loss)';

        store.addTrade({
            symbol: trade.symbol,
            type: trade.type,
            entryPrice: trade.entryPrice,
            closePrice: closePrice,
            reason: reasonStr,
            profitPercent: finalProfitPercent.toFixed(2),
            status: 'CLOSED'
        });
        
        this.onBroadcastCb(`🔔 <b>إغلاق صفقة الذهب (${trade.symbol})</b>\n\n` +
                           `السعر وقت الإغلاق: ${closePrice.toFixed(2)}\n` +
                           `النتيجة: ${reasonStr} (${finalProfitPercent.toFixed(2)}%)\n`);
    }

    public stopEngine() {
        this.isScanning = false;
        if (this.scanInterval) clearInterval(this.scanInterval);
        if (this.monitorWs) {
            this.monitorWs.close();
            this.monitorWs = null;
        }
        this.activeTrades.clear();
        this.onMessageCb('🛑 تم إيقاف رادار الذهب ومحرك التتبع بنجاح.');
    }
}
