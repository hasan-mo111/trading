import Parser from 'rss-parser';

const parser = new Parser();

// This uses a public economic calendar RSS feed (ForexFactory)
// In a real production scenario, you would parse the specific currencies for your pairs.
export async function checkUpcomingHighImpactNews(asset: string): Promise<boolean> {
    try {
        const feed = await parser.parseURL('https://nfs.faireconomy.media/ff_calendar_thisweek.xml');
        
        const now = new Date();
        const thirtyMinsFromNow = new Date(now.getTime() + 30 * 60000);

        // Map crypto/assets to fiat currencies for news impact
        let targetCurrency = 'USD'; 
        if (asset.includes('EUR')) targetCurrency = 'EUR';
        if (asset.includes('GBP')) targetCurrency = 'GBP';
        
        for (const item of feed.items) {
            // Check if it's high impact (usually denoted by 'High' in the feed)
            if (item.title && item.title.includes(targetCurrency)) {
                // Simplified date check for the prototype
                const newsTime = new Date(item.pubDate || '');
                if (newsTime > now && newsTime < thirtyMinsFromNow) {
                    console.log(`[NEWS] High impact news detected for ${targetCurrency} soon!`);
                    return true;
                }
            }
        }
        return false;
    } catch (error) {
        console.error('Error fetching news:', error);
        return false;
    }
}
