const logger = require('./logger');
const { getQuote } = require('./jupiterApiClient');
const { toDecimal, toNumber } = require('./index');

class DynamicTradeSizer {
    constructor() {
        this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1;
        this.minTradeSize = parseFloat(process.env.MIN_TRADE_SIZE_SOL) || 0.005;
        this.strategy = process.env.TRADE_SIZE_STRATEGY || 'optimal';
        this.testCount = parseInt(process.env.TRADE_SIZE_TESTS) || 5;
        this.minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.3;
        this.minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD) || 0.50;
        this.maxPriceImpact = parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT) || 2.0;
        this.sizeTestDelay = parseInt(process.env.SIZE_TEST_DELAY_MS) || 500;
        this.logTests = process.env.LOG_SIZE_TESTS === 'true';
        
        // Performance tracking
        this.performanceHistory = new Map(); // tokenPair -> performance data
        this.lastOptimalSizes = new Map(); // tokenPair -> last optimal size
        
        logger.info('Dynamic Trade Sizer initialized', {
            maxSize: this.maxTradeSize,
            minSize: this.minTradeSize,
            strategy: this.strategy,
            testCount: this.testCount
        });
    }

    /**
     * Find optimal trade size for maximum MEV capture
     */
    async findOptimalTradeSize(tokenA, tokenB, solPriceUSD = 100) {
        const tokenPair = `${tokenA.symbol}-${tokenB.symbol}`;
        
        try {
            logger.debug(`🔍 Finding optimal trade size for ${tokenPair}`);
            
            // Generate test sizes based on strategy
            const testSizes = this.generateTestSizes();
            const results = [];
            
            logger.info(`📊 Testing ${testSizes.length} different trade sizes (${this.minTradeSize} - ${this.maxTradeSize} SOL)`);
            
            // Test each size for profitability
            for (let i = 0; i < testSizes.length; i++) {
                const sizeSOL = testSizes[i];
                const sizeRaw = toNumber(sizeSOL, tokenA.decimals);
                
                try {
                    if (this.logTests) {
                        logger.debug(`Testing size ${i + 1}/${testSizes.length}: ${sizeSOL} SOL`);
                    }
                    
                    // Test triangular route at this size
                    const result = await this.testTriangularRoute(tokenA, tokenB, sizeRaw, sizeSOL, solPriceUSD);
                    
                    if (result.success) {
                        results.push(result);
                        
                        if (this.logTests) {
                            logger.debug(`✅ Size ${sizeSOL} SOL: ${result.profitPercent.toFixed(4)}% profit, ${result.profitUSD.toFixed(2)} USD`);
                        }
                    } else {
                        if (this.logTests) {
                            logger.debug(`❌ Size ${sizeSOL} SOL: ${result.error}`);
                        }
                    }
                    
                    // Add small delay between tests to avoid rate limits
                    if (i < testSizes.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, this.sizeTestDelay));
                    }
                    
                } catch (testError) {
                    logger.warn(`Error testing size ${sizeSOL}: ${testError.message}`);
                }
            }
            
            // Analyze results and find optimal size
            const optimal = this.analyzeResults(results, tokenPair, solPriceUSD);
            
            if (optimal) {
                logger.info(`🎯 OPTIMAL SIZE FOUND: ${optimal.sizeSOL} SOL`);
                logger.info(`💰 Expected Profit: ${optimal.profitPercent.toFixed(4)}% (${optimal.profitUSD.toFixed(2)} USD)`);
                logger.info(`📊 Total Value: ${optimal.totalValue.toFixed(2)} USD`);
                logger.info(`⚡ Price Impact: ${optimal.totalPriceImpact.toFixed(4)}%`);
                
                // Store for future optimization
                this.storePerformanceData(tokenPair, optimal);
                
                return optimal;
            } else {
                logger.warn(`❌ No profitable size found for ${tokenPair}`);
                return null;
            }
            
        } catch (error) {
            logger.error(`Error finding optimal trade size for ${tokenPair}:`, error);
            return null;
        }
    }

    /**
     * Generate test sizes based on strategy
     */
    generateTestSizes() {
        const sizes = [];
        
        if (this.strategy === 'stepped') {
            // Even steps between min and max
            const step = (this.maxTradeSize - this.minTradeSize) / (this.testCount - 1);
            for (let i = 0; i < this.testCount; i++) {
                sizes.push(this.minTradeSize + (step * i));
            }
        } else if (this.strategy === 'optimal') {
            // Smart distribution focusing on likely optimal ranges
            const preferredPercentages = process.env.PREFERRED_SIZE_PERCENTAGES?.split(',').map(p => parseInt(p)) || [10, 25, 50, 75, 90];
            
            // Add minimum size
            sizes.push(this.minTradeSize);
            
            // Add percentage-based sizes
            for (const percentage of preferredPercentages.slice(0, this.testCount - 2)) {
                const size = this.minTradeSize + ((this.maxTradeSize - this.minTradeSize) * (percentage / 100));
                sizes.push(size);
            }
            
            // Add maximum size
            sizes.push(this.maxTradeSize);
            
            // Remove duplicates and sort
            const uniqueSizes = [...new Set(sizes)].sort((a, b) => a - b);
            return uniqueSizes.slice(0, this.testCount);
        }
        
        return sizes.map(size => Math.round(size * 10000) / 10000); // Round to 4 decimals
    }

    /**
     * Test triangular arbitrage route at specific size
     */
    async testTriangularRoute(tokenA, tokenB, sizeRaw, sizeSOL, solPriceUSD) {
        try {
            // Step 1: SOL → Intermediate Token
            const route1 = await getQuote(
                tokenA.address, 
                tokenB.address, 
                sizeRaw.toString(), 
                parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 100
            );
            
            if (!route1 || !route1.outAmount) {
                return { success: false, error: 'No route1 available' };
            }
            
            // Small delay between quotes
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Step 2: Intermediate Token → SOL  
            const route2 = await getQuote(
                tokenB.address, 
                tokenA.address, 
                route1.outAmount, 
                parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 100
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
            
            // Check if this meets our criteria
            const meetsPercentThreshold = profitPercent >= this.minProfitThreshold;
            const meetsUSDThreshold = profitUSD >= this.minProfitUSD;
            const acceptablePriceImpact = totalPriceImpact <= this.maxPriceImpact;
            
            const success = meetsPercentThreshold && meetsUSDThreshold && acceptablePriceImpact;
            
            return {
                success,
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
                outputAmount: Number(outputAmount),
                meetsPercentThreshold,
                meetsUSDThreshold,
                acceptablePriceImpact
            };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Analyze results to find the optimal trade size
     */
    analyzeResults(results, tokenPair, solPriceUSD) {
        if (results.length === 0) {
            return null;
        }
        
        // Sort by different criteria and score them
        const scoredResults = results.map(result => {
            let score = 0;
            
            // Profit USD weight (40%)
            score += (result.profitUSD / this.minProfitUSD) * 0.4;
            
            // Profit percentage weight (30%)
            score += (result.profitPercent / this.minProfitThreshold) * 0.3;
            
            // Total value weight (20%) - bigger trades are better if profitable
            score += (result.totalValue / (this.maxTradeSize * solPriceUSD)) * 0.2;
            
            // Price impact penalty (10%) - lower impact is better
            const impactPenalty = Math.max(0, 1 - (result.totalPriceImpact / this.maxPriceImpact));
            score += impactPenalty * 0.1;
            
            return { ...result, score };
        });
        
        // Sort by score (highest first)
        scoredResults.sort((a, b) => b.score - a.score);
        
        // Log top candidates
        logger.info(`📊 Top 3 candidates for ${tokenPair}:`);
        scoredResults.slice(0, 3).forEach((result, index) => {
            logger.info(`  ${index + 1}. ${result.sizeSOL} SOL: ${result.profitPercent.toFixed(4)}% (${result.profitUSD.toFixed(2)} USD) - Score: ${result.score.toFixed(3)}`);
        });
        
        // Return the best result
        return scoredResults[0];
    }

    /**
     * Store performance data for future optimization
     */
    storePerformanceData(tokenPair, result) {
        if (!this.performanceHistory.has(tokenPair)) {
            this.performanceHistory.set(tokenPair, {
                results: [],
                bestSize: result.sizeSOL,
                bestProfit: result.profitPercent,
                totalTrades: 0,
                successfulTrades: 0
            });
        }
        
        const history = this.performanceHistory.get(tokenPair);
        history.results.push({
            timestamp: Date.now(),
            size: result.sizeSOL,
            profit: result.profitPercent,
            profitUSD: result.profitUSD
        });
        
        // Keep only recent results (last 100)
        if (history.results.length > 100) {
            history.results = history.results.slice(-100);
        }
        
        // Update best performers
        if (result.profitPercent > history.bestProfit) {
            history.bestSize = result.sizeSOL;
            history.bestProfit = result.profitPercent;
        }
        
        this.lastOptimalSizes.set(tokenPair, result.sizeSOL);
    }

    /**
     * Get historical optimal size for a token pair (for faster subsequent trades)
     */
    getHistoricalOptimalSize(tokenPair) {
        return this.lastOptimalSizes.get(tokenPair) || null;
    }

    /**
     * Quick size estimation based on historical data
     */
    getEstimatedOptimalSize(tokenPair) {
        const historical = this.getHistoricalOptimalSize(tokenPair);
        if (historical) {
            // Use historical but add some randomization to avoid pattern detection
            const randomFactor = 0.8 + (Math.random() * 0.4); // 80% - 120%
            const estimated = Math.min(this.maxTradeSize, Math.max(this.minTradeSize, historical * randomFactor));
            return Math.round(estimated * 10000) / 10000;
        }
        
        // If no historical data, start with middle range
        return Math.round(((this.minTradeSize + this.maxTradeSize) / 2) * 10000) / 10000;
    }

    /**
     * Update performance after actual trade execution
     */
    updateActualPerformance(tokenPair, actualSize, actualProfit, successful) {
        if (this.performanceHistory.has(tokenPair)) {
            const history = this.performanceHistory.get(tokenPair);
            history.totalTrades++;
            if (successful) {
                history.successfulTrades++;
            }
            
            // Store actual vs predicted performance
            history.results.push({
                timestamp: Date.now(),
                size: actualSize,
                profit: actualProfit,
                actual: true,
                successful
            });
        }
    }

    /**
     * Get performance statistics
     */
    getPerformanceStats() {
        const stats = {
            totalPairs: this.performanceHistory.size,
            bestPerformers: [],
            averageOptimalSize: 0,
            successRate: 0
        };
        
        let totalSize = 0;
        let totalTrades = 0;
        let totalSuccessful = 0;
        
        for (const [pair, history] of this.performanceHistory) {
            totalSize += history.bestSize;
            totalTrades += history.totalTrades;
            totalSuccessful += history.successfulTrades;
            
            stats.bestPerformers.push({
                pair,
                bestSize: history.bestSize,
                bestProfit: history.bestProfit,
                totalTrades: history.totalTrades,
                successRate: history.totalTrades > 0 ? (history.successfulTrades / history.totalTrades) : 0
            });
        }
        
        stats.averageOptimalSize = totalSize / Math.max(1, this.performanceHistory.size);
        stats.successRate = totalTrades > 0 ? (totalSuccessful / totalTrades) : 0;
        
        // Sort by best profit
        stats.bestPerformers.sort((a, b) => b.bestProfit - a.bestProfit);
        
        return stats;
    }

    /**
     * Clear old performance data
     */
    cleanupOldData() {
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
        
        for (const [pair, history] of this.performanceHistory) {
            history.results = history.results.filter(result => result.timestamp > cutoffTime);
            
            if (history.results.length === 0) {
                this.performanceHistory.delete(pair);
                this.lastOptimalSizes.delete(pair);
            }
        }
        
        logger.debug('Cleaned up old performance data');
    }
}

// Create singleton instance
const dynamicTradeSizer = new DynamicTradeSizer();

module.exports = dynamicTradeSizer;