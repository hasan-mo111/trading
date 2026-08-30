import fs from 'fs';
import path from 'path';

interface StoreData {
    users: number[];
    admins: string[];
    trades: any[];
}

const DB_PATH = path.join(process.cwd(), 'db.json');

class Store {
    private data: StoreData = { users: [], admins: [], trades: [] };

    constructor() {
        this.load();
    }

    private load() {
        if (fs.existsSync(DB_PATH)) {
            const file = fs.readFileSync(DB_PATH, 'utf-8');
            this.data = JSON.parse(file);
            if (!this.data.trades) this.data.trades = []; // Backwards compatibility
        } else {
            this.data.admins = process.env.ADMIN_USERNAME ? [process.env.ADMIN_USERNAME.replace('@', '')] : [];
            this.save();
        }
    }

    private save() {
        fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
    }

    addUser(chatId: number) {
        if (!this.data.users.includes(chatId)) {
            this.data.users.push(chatId);
            this.save();
        }
    }

    addAdmin(username: string) {
        const cleanUsername = username.replace('@', '');
        if (!this.data.admins.includes(cleanUsername)) {
            this.data.admins.push(cleanUsername);
            this.save();
        }
    }

    isAdmin(username: string | undefined): boolean {
        if (!username) return false;
        return this.data.admins.includes(username.replace('@', ''));
    }

    getAllUsers(): number[] {
        return this.data.users;
    }

    addTrade(trade: any) {
        trade.timestamp = Date.now();
        this.data.trades.push(trade);
        // Keep only the last 50 trades
        if (this.data.trades.length > 50) {
            this.data.trades.shift();
        }
        this.save();
    }

    getTrades() {
        return this.data.trades;
    }
}

export const store = new Store();
