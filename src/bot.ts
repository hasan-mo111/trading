import { Telegraf } from 'telegraf';
import { store } from './store.ts';
import { TradingEngine } from './trading.ts';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set. Bot will not start.");
}

export const bot = token ? new Telegraf(token) : null;

if (bot) {
    // Engine callbacks for messaging
    const sendToAdmin = (msg: string) => {
        // Send to all admins for simplicity, or just log if no chat IDs known for admin yet
        console.log("[Bot to Admin]:", msg);
    };

    const broadcastToUsers = (msg: string) => {
        const users = store.getAllUsers();
        users.forEach(chatId => {
            bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }).catch(e => console.error(`Failed to send to ${chatId}`, e));
        });
    };

    const engine = new TradingEngine(
        (msg) => broadcastToUsers(msg), // Forward engine system msgs to users/admins
        (msg) => broadcastToUsers(msg)  // Broadcast signals
    );

    bot.command('start', (ctx) => {
        store.addUser(ctx.chat.id);
        const isAdmin = store.isAdmin(ctx.from.username);
        
        let msg = `مرحباً بك في بوت التداول الآلي! 🤖\n\n` +
                  `أنت الآن مسجل كمستخدم. ستتلقى التنبيهات والصفقات فور قنصها.\n`;
        
        if (isAdmin) {
            msg += `\n👑 <b>أنت بصلاحية أدمن</b>.\n` +
                   `يمكنك استخدام الأوامر التالية:\n` +
                   `/analyze &lt;symbol&gt; - لبدء تحليل وقنص صفقة (مثال: /analyze BTCUSDT)\n` +
                   `/stop - لإيقاف المحرك\n` +
                   `/history - لعرض آخر الصفقات المرسلة\n` +
                   `/broadcast &lt;message&gt; - لإرسال رسالة للمستخدمين`;
        } else {
            msg += `\nإذا كنت مدير النظام، يمكنك تسجيل الدخول بصلاحيات الأدمن عبر الأمر:\n/admin_login &lt;password&gt;`;
        }

        ctx.reply(msg, { parse_mode: 'HTML' });
    });

    bot.command('admin_login', (ctx) => {
        const password = ctx.message.text.split(' ')[1];
        if (!password) {
            return ctx.reply('يرجى إدخال كلمة المرور، مثال:\n/admin_login 123456');
        }

        if (process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
            if (ctx.from.username) {
                store.addAdmin(ctx.from.username);
                ctx.reply('✅ تم تفعيل صلاحيات الأدمن بنجاح. يمكنك الآن استخدام أوامر الإدارة.');
            } else {
                ctx.reply('❌ يرجى تعيين Username (اسم مستخدم) لحساب التيليجرام الخاص بك لتتمكن من أخذ صلاحية الأدمن.');
            }
        } else {
            ctx.reply('❌ كلمة المرور غير صحيحة أو غير معينة.');
        }
    });

    bot.command('analyze', async (ctx) => {
        if (!store.isAdmin(ctx.from.username)) {
            return ctx.reply('⛔ هذا الأمر مخصص للأدمن فقط.');
        }

        const symbol = ctx.message.text.split(' ')[1] || '';

        ctx.reply(`جاري تشغيل محرك التحليل...`);
        await engine.startAnalysis(symbol);
    });

    bot.command('stop', (ctx) => {
        if (!store.isAdmin(ctx.from.username)) return;
        engine.stopEngine();
        ctx.reply('تم إيقاف المحرك.');
    });

    bot.command('broadcast', (ctx) => {
        if (!store.isAdmin(ctx.from.username)) return;
        
        const msg = ctx.message.text.replace('/broadcast', '').trim();
        if (!msg) return ctx.reply('يرجى كتابة الرسالة بعد الأمر.');

        broadcastToUsers(`📢 <b>رسالة من الإدارة:</b>\n\n${msg}`);
        ctx.reply('تم إرسال الرسالة لجميع المستخدمين بنجاح.');
    });

    bot.command('history', (ctx) => {
        if (!store.isAdmin(ctx.from.username)) return;

        const trades = store.getTrades();
        if (trades.length === 0) {
            return ctx.reply('لا توجد صفقات مسجلة حتى الآن.');
        }

        let historyMsg = `📊 <b>سجل الصفقات الأخيرة:</b>\n\n`;
        // Show only the last 10 trades to avoid hitting Telegram message length limits
        const recentTrades = trades.slice(-10).reverse();

        recentTrades.forEach((t, i) => {
            const date = new Date(t.timestamp).toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
            historyMsg += `<b>${i + 1}. ${t.symbol} (${t.type})</b>\n`;
            historyMsg += `حالة الصفقة: ${t.status === 'OPEN' ? 'مفتوحة 🟢' : 'مغلقة 🔴'}\n`;
            historyMsg += `سعر الدخول: ${t.entryPrice?.toFixed(2)}\n`;
            if (t.status === 'CLOSED') {
                historyMsg += `سعر الإغلاق: ${t.closePrice?.toFixed(2)}\n`;
                historyMsg += `النتيجة: ${t.profitPercent}%\n`;
                historyMsg += `ملاحظة: ${t.reason}\n`;
            }
            historyMsg += `التاريخ: ${date}\n`;
            historyMsg += `〰️〰️〰️〰️〰️〰️〰️\n`;
        });

        ctx.reply(historyMsg, { parse_mode: 'HTML' });
    });

    bot.command('status', (ctx) => {
        if (!store.isAdmin(ctx.from.username)) return;
        const statusMsg = engine.getStatus();
        ctx.reply(statusMsg, { parse_mode: 'HTML' });
    });

    // Handle gracefully
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
