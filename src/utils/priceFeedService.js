const axios = require('axios');
const logger = require('./logger');

class PriceFeedService {
    constructor() {
        this.solPrice = 100; // Default fallback price
        this.lastPriceUpdate = 0;
        this.priceUpdateInterval = 30000; // 30 seconds
        this.priceHistory = [];
        
        // Multiple price sources for reliability
        this.priceSources = [
            {
                name: 'Jupiter Price API',
                url: 'https://price.jup.ag/v4/price?ids=So11111111111111111111111111111111111111112',
                parser: (data) => data.data?.So11111111111111111111111111111111111111112?.price
            },
            {
                name: 'CoinGecko',
                url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
                parser: (data) => data.solana?.usd
            },
            {
                name: 'Binance',
                url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
                parser: (data) => parseFloat(data.price)
            },
            {
                name: 'CoinMarketCap',
                url: 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL',
                headers: process.env.CMC_API_KEY ? { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY } : {},
                parser: (data) => data.data?.SOL?.quote?.USD?.price
            }
        ];
        
        // Start price updates
        this.startPriceUpdates();
        
        logger.info('Price Feed Service initialized');
    }

    /**
     * Get current SOL price in USD with automatic updates
     */
    async getCurrentSOLPrice() {
        const now = Date.now();
        
        // Update price if it's stale
        if (now - this.lastPriceUpdate > this.priceUpdateInterval) {
            await this.updateSOLPrice();
        }
        
        return this.solPrice;
    }

    /**
     * Force update SOL price from multiple sources
     */
    async updateSOLPrice() {
        try {
            logger.debug('🔄 Updating SOL price from multiple sources...');
            
            const prices = [];
            
            // Try all price sources concurrently with timeout
            const pricePromises = this.priceSources.map(async (source) => {
                try {
                    const response = await axios.get(source.url, {
                        timeout: 5000,
                        headers: source.headers || {}
                    });
                    
                    const price = source.parser(response.data);
                    
                    if (price && typeof price === 'number' && price > 0) {
                        logger.debug(`✅ ${source.name}: $${price.toFixed(2)}`);
                        return { source: source.name, price };
                    } else {
                        logger.debug(`❌ ${source.name}: Invalid price data`);
                        return null;
                    }
                } catch (error) {
                    logger.debug(`❌ ${source.name}: ${error.message}`);
                    return null;
                }
            });
            
            // Wait for all price requests (with timeout)
            const results = await Promise.allSettled(pricePromises);
            
            // Collect valid prices
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    prices.push(result.value);
                }
            });
            
            if (prices.length > 0) {
                // Calculate average price from all sources
                const avgPrice = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
                
                // Validate the price (should be reasonable)
                if (avgPrice >= 1 && avgPrice <= 10000) {
                    const oldPrice = this.solPrice;
                    this.solPrice = Math.round(avgPrice * 100) / 100; // Round to 2 decimals
                    this.lastPriceUpdate = Date.now();
                    
                    // Store in price history
                    this.priceHistory.push({
                        timestamp: Date.now(),
                        price: this.solPrice,
                        sources: prices.map(p => p.source)
                    });
                    
                    // Keep only recent history (last 100 updates)
                    if (this.priceHistory.length > 100) {
                        this.priceHistory = this.priceHistory.slice(-100);
                    }
                    
                    const priceChange = ((this.solPrice - oldPrice) / oldPrice * 100);
                    const changeSymbol = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '📊';
                    
                    logger.info(`${changeSymbol} SOL Price Updated: $${this.solPrice} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
                    logger.info(`📡 Sources used: ${prices.map(p => p.source).join(', ')}`);
                    
                    return this.solPrice;
                } else {
                    logger.warn(`⚠️ Suspicious SOL price: $${avgPrice}, keeping previous price: $${this.solPrice}`);
                }
            } else {
                logger.warn('⚠️ Could not get SOL price from any source, using cached price');
            }
            
        } catch (error) {
            logger.error('Error updating SOL price:', error.message);
        }
        
        return this.solPrice;
    }

    /**
     * Start automatic price updates
     */
    startPriceUpdates() {
        // Initial price fetch
        this.updateSOLPrice();
        
        // Schedule regular updates
        this.priceUpdateTimer = setInterval(() => {
            this.updateSOLPrice();
        }, this.priceUpdateInterval);
        
        logger.info(`🔄 Automatic SOL price updates started (every ${this.priceUpdateInterval / 1000}s)`);
    }

    /**
     * Stop price updates
     */
    stopPriceUpdates() {
        if (this.priceUpdateTimer) {
            clearInterval(this.priceUpdateTimer);
            this.priceUpdateTimer = null;
            logger.info('🛑 SOL price updates stopped');
        }
    }

    /**
     * Get price statistics
     */
    getPriceStats() {
        if (this.priceHistory.length === 0) {
            return {
                currentPrice: this.solPrice,
                history: [],
                trend: 'UNKNOWN',
                volatility: 0,
                lastUpdate: this.lastPriceUpdate
            };
        }
        
        const recent = this.priceHistory.slice(-10); // Last 10 updates
        const prices = recent.map(h => h.price);
        
        // Calculate volatility (coefficient of variation)
        const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
        const volatility = Math.sqrt(variance) / avgPrice * 100;
        
        // Determine trend
        let trend = 'STABLE';
        if (prices.length >= 2) {
            const firstPrice = prices[0];
            const lastPrice = prices[prices.length - 1];
            const change = (lastPrice - firstPrice) / firstPrice * 100;
            
            if (change > 2) trend = 'RISING';
            else if (change < -2) trend = 'FALLING';
        }
        
        return {
            currentPrice: this.solPrice,
            history: recent,
            trend,
            volatility: Math.round(volatility * 100) / 100,
            lastUpdate: this.lastPriceUpdate,
            priceChange24h: this.calculate24hChange()
        };
    }

    /**
     * Calculate 24h price change
     */
    calculate24hChange() {
        const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
        const dayAgoPrice = this.priceHistory.find(h => h.timestamp >= dayAgo);
        
        if (dayAgoPrice) {
            return ((this.solPrice - dayAgoPrice.price) / dayAgoPrice.price * 100);
        }
        
        return 0;
    }

    /**
     * Convert SOL amount to USD
     */
    solToUSD(solAmount) {
        return solAmount * this.solPrice;
    }

    /**
     * Convert USD amount to SOL
     */
    usdToSOL(usdAmount) {
        return usdAmount / this.solPrice;
    }

    /**
     * Check if price data is fresh
     */
    isPriceFresh() {
        return (Date.now() - this.lastPriceUpdate) < (this.priceUpdateInterval * 2);
    }

    /**
     * Get price with freshness check
     */
    async getFreshSOLPrice() {
        if (!this.isPriceFresh()) {
            logger.debug('🔄 Price data stale, fetching fresh price...');
            await this.updateSOLPrice();
        }
        
        return this.solPrice;
    }

    /**
     * Update price interval dynamically
     */
    setPriceUpdateInterval(intervalMs) {
        this.priceUpdateInterval = Math.max(10000, intervalMs); // Minimum 10 seconds
        
        // Restart timer with new interval
        if (this.priceUpdateTimer) {
            clearInterval(this.priceUpdateTimer);
            this.priceUpdateTimer = setInterval(() => {
                this.updateSOLPrice();
            }, this.priceUpdateInterval);
        }
        
        logger.info(`🔄 Price update interval changed to ${this.priceUpdateInterval / 1000}s`);
    }

    /**
     * Force price refresh (useful for critical operations)
     */
    async forceRefreshPrice() {
        logger.info('🔄 Forcing SOL price refresh for critical operation...');
        return await this.updateSOLPrice();
    }

    /**
     * Get price summary for logging
     */
    getPriceSummary() {
        const stats = this.getPriceStats();
        const freshness = this.isPriceFresh() ? '🟢 Fresh' : '🟡 Stale';
        const age = Math.floor((Date.now() - this.lastPriceUpdate) / 1000);
        
        return {
            price: `$${this.solPrice}`,
            trend: `${stats.trend} ${stats.trend === 'RISING' ? '📈' : stats.trend === 'FALLING' ? '📉' : '📊'}`,
            volatility: `${stats.volatility}%`,
            freshness: `${freshness} (${age}s ago)`,
            sources: this.priceHistory.length > 0 ? this.priceHistory[this.priceHistory.length - 1].sources : []
        };
    }
}

// Create singleton instance
const priceFeedService = new PriceFeedService();

module.exports = priceFeedService;