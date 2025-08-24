const logger = require('./logger');
const { getQuote } = require('./jupiterApiClient');
const { toDecimal, toNumber } = require('./index');

class SimplifiedMEVFinder {
    constructor() {
        this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.15;
        this.minTradeSize = parseFloat(process.env.MIN_TRADE_SIZE_SOL) || 0.005;
        this.minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.1;
        this.minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD) || 0.25;
        this.maxSlippage = parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 400; // 4%
        
        logger.info('Simplified MEV Finder initialized', {
            maxSize: this.maxTradeSize,
            minSize: this.minTradeSize,
            minProfitPercent: this.minProfitThreshold,
            minProfitUSD: this.minProfitUSD
        });
    }

    /**
     * Find MEV opportunity using binary search within min/max range
     */
    async findMEVOpportunity(tokenA, tokenB, solPriceUSD) {
        const tokenPair = `${tokenA.symbol}-${tokenB.symbol}`;
        
        try {
            logger.debug(`🔍 Searching for MEV: ${tokenPair} (${this.minTradeSize} - ${this.maxTradeSize} SOL)`);
            
            // Start with maximum size and work backwards to find profitable opportunity
            let currentSize = this.maxTradeSize;
            let bestResult = null;
            
            // Try max size first
            let result = await this.testArbitrageSize(tokenA, tokenB, currentSize, solPriceUSD);
            if (result.success && this.isProfitable(result, solPriceUSD)) {
                logger.info(`🎯 MAX SIZE MEV FOUND: ${currentSize} SOL - ${result.profitPercent.toFixed(4)}% ($${result.profitUSD.toFixed(2)})`);
                return result;
            }
            
            // Try minimum size
            currentSize = this.minTradeSize;
            result = await this.testArbitrageSize(tokenA, tokenB, currentSize, solPriceUSD);
            if (result.success && this.isProfitable(result, solPriceUSD)) {
                bestResult = result;
                logger.info(`💰 MIN SIZE MEV FOUND: ${currentSize} SOL - ${result.profitPercent.toFixed(4)}% ($${result.profitUSD.toFixed(2)})`);
            }
            
            // Binary search for optimal size in the middle if min worked
            if (bestResult) {
                const optimalSize = await this.binarySearchOptimalSize(tokenA, tokenB, solPriceUSD, bestResult);
                if (optimalSize && optimalSize.profitUSD > bestResult.profitUSD) {
                    bestResult = optimalSize;
                    logger.info(`⚡ OPTIMAL MEV FOUND: ${optimalSize.sizeSOL} SOL - ${optimalSize.profitPercent.toFixed(4)}% ($${optimalSize.profitUSD.toFixed(2)})`);
                }
            }
            
            if (bestResult) {
                return bestResult;
            } else {
                logger.debug(`❌ No profitable MEV found for ${tokenPair}`);
                return null;
            }
            
        } catch (error) {
            logger.error(`Error finding MEV for ${tokenPair}:`, error);
            return null;
        }
    }

    /**
     * Binary search for optimal size between min and max
     */
    async binarySearchOptimalSize(tokenA, tokenB, solPriceUSD, baseResult) {
        let low = this.minTradeSize;
        let high = this.maxTradeSize;
        let bestResult = baseResult;
        let attempts = 0;
        const maxAttempts = 5; // Limit iterations to avoid too many API calls
        
        while (low < high && attempts < maxAttempts) {
            const mid = (low + high) / 2;
            attempts++;
            
            try {
                const result = await this.testArbitrageSize(tokenA, tokenB, mid, solPriceUSD);
                
                if (result.success && this.isProfitable(result, solPriceUSD)) {
                    if (result.profitUSD > bestResult.profitUSD) {
                        bestResult = result;
                        logger.debug(`📈 Better size found: ${mid.toFixed(4)} SOL - $${result.profitUSD.toFixed(2)}`);
                    }
                    // Try larger size
                    low = mid + 0.001;
                } else {
                    // Try smaller size
                    high = mid - 0.001;
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                logger.warn(`Binary search failed at size ${mid}:`, error.message);
                break;
            }
        }
        
        return bestResult !== baseResult ? bestResult : null;
    }

    /**
     * Test triangular arbitrage at specific size
     */
    async testArbitrageSize(tokenA, tokenB, sizeSOL, solPriceUSD) {
        const sizeRaw = toNumber(sizeSOL, tokenA.decimals);
        
        try {
            // Step 1: SOL → Intermediate Token
            const route1 = await getQuote(
                tokenA.address, 
                tokenB.address, 
                sizeRaw.toString(), 
                this.maxSlippage
            );
            
            if (!route1 || !route1.outAmount) {
                return { success: false, error: 'No route1 available' };
            }
            
            // Small delay between quotes
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Step 2: Intermediate Token → SOL  
            const route2 = await getQuote(
                tokenB.address, 
                tokenA.address, 
                route1.outAmount, 
                this.maxSlippage
            );
            
            if (!route2 || !route2.outAmount) {
                return { success: false, error: 'No route2 available' };
            }
            
            // Calculate profitability
            const inputAmount = BigInt(sizeRaw.toString());
            const outputAmount = BigInt(route2.outAmount);
            const profitAmount = outputAmount - inputAmount;
            const profitPercent = Number(profitAmount * BigInt(10000) / inputAmount) / 100;
            
            // Calculate USD values
            const tradeSizeUSD = sizeSOL * solPriceUSD;
            const profitUSD = (profitPercent / 100) * tradeSizeUSD;
            
            // Calculate price impacts
            const priceImpact1 = parseFloat(route1.priceImpactPct || 0);
            const priceImpact2 = parseFloat(route2.priceImpactPct || 0);
            const totalPriceImpact = priceImpact1 + priceImpact2;
            
            return {
                success: true,
                sizeSOL,
                sizeRaw,
                profitPercent,
                profitUSD,
                profitAmount: Number(profitAmount),
                totalValue: tradeSizeUSD,
                totalPriceImpact,
                priceImpact1,
                priceImpact2,
                route1,
                route2,
                inputAmount: Number(inputAmount),
                outputAmount: Number(outputAmount)
            };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if result meets profitability requirements
     */
    isProfitable(result, solPriceUSD) {
        const meetsPercentThreshold = result.profitPercent >= this.minProfitThreshold;
        const meetsUSDThreshold = result.profitUSD >= this.minProfitUSD;
        const acceptablePriceImpact = result.totalPriceImpact <= 10.0; // Max 10% total impact
        
        return meetsPercentThreshold && meetsUSDThreshold && acceptablePriceImpact;
    }

    /**
     * Quick MEV scan - just check if any opportunity exists
     */
    async quickMEVScan(tokenA, tokenB, solPriceUSD) {
        try {
            // Just test min size for speed
            const result = await this.testArbitrageSize(tokenA, tokenB, this.minTradeSize, solPriceUSD);
            
            if (result.success && this.isProfitable(result, solPriceUSD)) {
                logger.debug(`⚡ Quick MEV detected: ${result.profitPercent.toFixed(4)}% profit available`);
                return true;
            }
            
            return false;
        } catch (error) {
            logger.debug(`Quick MEV scan failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get recommended size based on current market conditions
     */
    getRecommendedSize(tokenA, tokenB, solPriceUSD) {
        // Simple heuristic: use larger sizes for high-value SOL, smaller for low-value
        if (solPriceUSD > 300) {
            return Math.min(this.maxTradeSize, 0.05); // Cap at 0.05 SOL for very high prices
        } else if (solPriceUSD > 200) {
            return Math.min(this.maxTradeSize, 0.1); // Cap at 0.1 SOL for high prices
        } else {
            return this.maxTradeSize; // Use full max for reasonable prices
        }
    }

    /**
     * Update configuration dynamically
     */
    updateConfig(newConfig) {
        if (newConfig.maxTradeSize) this.maxTradeSize = newConfig.maxTradeSize;
        if (newConfig.minTradeSize) this.minTradeSize = newConfig.minTradeSize;
        if (newConfig.minProfitThreshold) this.minProfitThreshold = newConfig.minProfitThreshold;
        if (newConfig.minProfitUSD) this.minProfitUSD = newConfig.minProfitUSD;
        
        logger.info('MEV Finder configuration updated', newConfig);
    }

    /**
     * Get current configuration
     */
    getConfig() {
        return {
            maxTradeSize: this.maxTradeSize,
            minTradeSize: this.minTradeSize,
            minProfitThreshold: this.minProfitThreshold,
            minProfitUSD: this.minProfitUSD,
            maxSlippage: this.maxSlippage / 100
        };
    }
}

// Create singleton instance
const simplifiedMEVFinder = new SimplifiedMEVFinder();

module.exports = simplifiedMEVFinder;