const logger = require('./logger');
const { getQuoteWithRateLimit } = require('./rateLimiter');

class MarketConditionAnalyzer {
    constructor() {
        this.volatilityWindow = 20; // Number of price samples for volatility calculation
        this.liquidityThresholds = {
            high: 1000000, // $1M+ in volume
            medium: 100000, // $100K+ in volume
            low: 10000     // $10K+ in volume
        };
        
        this.marketData = new Map(); // Token address -> market data
        this.priceHistory = new Map(); // Token address -> price history array
        this.volumeHistory = new Map(); // Token address -> volume history array
        
        this.marketConditions = {
            overall: 'UNKNOWN',
            volatility: 'UNKNOWN',
            liquidity: 'UNKNOWN',
            trend: 'UNKNOWN',
            lastUpdate: Date.now()
        };
        
        logger.info('Market Condition Analyzer initialized');
    }

    /**
     * Analyze market conditions for a token pair
     */
    async analyzeMarketConditions(tokenA, tokenB, tradeAmount) {
        try {
            logger.debug(`Analyzing market conditions for ${tokenA.symbol}/${tokenB.symbol}`);
            
            const analysis = {
                timestamp: Date.now(),
                tokenPair: `${tokenA.symbol}/${tokenB.symbol}`,
                tradeAmount,
                conditions: {},
                recommendations: [],
                riskLevel: 'LOW'
            };

            // 1. Analyze liquidity
            analysis.conditions.liquidity = await this.analyzeLiquidity(tokenA, tokenB, tradeAmount);
            
            // 2. Analyze volatility
            analysis.conditions.volatility = await this.analyzeVolatility(tokenA, tokenB);
            
            // 3. Analyze price impact
            analysis.conditions.priceImpact = await this.analyzePriceImpact(tokenA, tokenB, tradeAmount);
            
            // 4. Analyze market depth
            analysis.conditions.marketDepth = await this.analyzeMarketDepth(tokenA, tokenB, tradeAmount);
            
            // 5. Calculate overall market score
            analysis.overallScore = this.calculateMarketScore(analysis.conditions);
            analysis.recommendation = this.generateRecommendation(analysis);
            
            // Update market conditions cache
            this.updateMarketConditions(analysis);
            
            logger.debug(`Market analysis completed`, {
                pair: analysis.tokenPair,
                score: analysis.overallScore,
                riskLevel: analysis.riskLevel
            });
            
            return analysis;
            
        } catch (error) {
            logger.error('Market condition analysis failed', error);
            return {
                timestamp: Date.now(),
                error: error.message,
                conditions: {},
                overallScore: 0,
                recommendation: 'SKIP',
                riskLevel: 'HIGH'
            };
        }
    }

    /**
     * Analyze liquidity conditions
     */
    async analyzeLiquidity(tokenA, tokenB, tradeAmount) {
        try {
            // Test multiple trade sizes to gauge liquidity depth
            const testSizes = [
                tradeAmount,
                tradeAmount * 2,
                tradeAmount * 5,
                tradeAmount * 10
            ];
            
            const liquidityTests = [];
            
            for (const size of testSizes) {
                try {
                    const quote = await getQuoteWithRateLimit(
                        tokenA.address,
                        tokenB.address,
                        size.toString(),
                        100 // 1% slippage
                    );
                    
                    if (quote && quote.outAmount) {
                        const priceImpact = parseFloat(quote.priceImpactPct || 0);
                        liquidityTests.push({
                            size,
                            priceImpact,
                            outAmount: quote.outAmount,
                            successful: true
                        });
                    }
                } catch (error) {
                    liquidityTests.push({
                        size,
                        successful: false,
                        error: error.message
                    });
                }
                
                // Add delay between requests
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Analyze liquidity based on successful tests
            const successfulTests = liquidityTests.filter(test => test.successful);
            
            if (successfulTests.length === 0) {
                return {
                    status: 'POOR',
                    score: 0,
                    message: 'No liquidity available for any test size',
                    tests: liquidityTests
                };
            }
            
            // Check price impact progression
            const maxPriceImpact = Math.max(...successfulTests.map(t => t.priceImpact));
            const avgPriceImpact = successfulTests.reduce((sum, t) => sum + t.priceImpact, 0) / successfulTests.length;
            
            let liquidityStatus, score;
            
            if (maxPriceImpact < 1 && successfulTests.length >= 3) {
                liquidityStatus = 'EXCELLENT';
                score = 10;
            } else if (maxPriceImpact < 3 && successfulTests.length >= 2) {
                liquidityStatus = 'GOOD';
                score = 7;
            } else if (maxPriceImpact < 8 && successfulTests.length >= 1) {
                liquidityStatus = 'MODERATE';
                score = 5;
            } else {
                liquidityStatus = 'POOR';
                score = 2;
            }
            
            return {
                status: liquidityStatus,
                score,
                maxPriceImpact,
                avgPriceImpact,
                successfulTests: successfulTests.length,
                totalTests: liquidityTests.length,
                message: `Liquidity is ${liquidityStatus.toLowerCase()} - max price impact ${maxPriceImpact.toFixed(2)}%`,
                tests: liquidityTests
            };
            
        } catch (error) {
            logger.error('Liquidity analysis failed', error);
            return {
                status: 'UNKNOWN',
                score: 0,
                message: `Liquidity analysis failed: ${error.message}`
            };
        }
    }

    /**
     * Analyze price volatility
     */
    async analyzeVolatility(tokenA, tokenB) {
        try {
            // Get price samples over time
            const priceSamples = await this.collectPriceSamples(tokenA, tokenB, 5);
            
            if (priceSamples.length < 3) {
                return {
                    status: 'UNKNOWN',
                    score: 5,
                    message: 'Insufficient price data for volatility analysis',
                    samples: priceSamples.length
                };
            }
            
            // Calculate price volatility
            const prices = priceSamples.map(sample => sample.price);
            const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
            const variance = prices.reduce((sum, price) => sum + Math.pow(price - avgPrice, 2), 0) / prices.length;
            const volatility = Math.sqrt(variance) / avgPrice * 100; // Coefficient of variation as percentage
            
            let volatilityStatus, score;
            
            if (volatility < 1) {
                volatilityStatus = 'LOW';
                score = 9;
            } else if (volatility < 3) {
                volatilityStatus = 'MODERATE';
                score = 7;
            } else if (volatility < 10) {
                volatilityStatus = 'HIGH';
                score = 4;
            } else {
                volatilityStatus = 'EXTREME';
                score = 1;
            }
            
            return {
                status: volatilityStatus,
                score,
                volatility: volatility.toFixed(2),
                avgPrice,
                samples: priceSamples.length,
                message: `Price volatility is ${volatilityStatus.toLowerCase()} (${volatility.toFixed(2)}%)`
            };
            
        } catch (error) {
            logger.error('Volatility analysis failed', error);
            return {
                status: 'UNKNOWN',
                score: 5,
                message: `Volatility analysis failed: ${error.message}`
            };
        }
    }

    /**
     * Analyze price impact for specific trade size
     */
    async analyzePriceImpact(tokenA, tokenB, tradeAmount) {
        try {
            const quote = await getQuoteWithRateLimit(
                tokenA.address,
                tokenB.address,
                tradeAmount.toString(),
                50 // 0.5% slippage for impact measurement
            );
            
            if (!quote || !quote.priceImpactPct) {
                return {
                    status: 'UNKNOWN',
                    score: 0,
                    message: 'Could not determine price impact'
                };
            }
            
            const priceImpact = Math.abs(parseFloat(quote.priceImpactPct));
            let impactStatus, score;
            
            if (priceImpact < 0.1) {
                impactStatus = 'MINIMAL';
                score = 10;
            } else if (priceImpact < 0.5) {
                impactStatus = 'LOW';
                score = 8;
            } else if (priceImpact < 2) {
                impactStatus = 'MODERATE';
                score = 6;
            } else if (priceImpact < 5) {
                impactStatus = 'HIGH';
                score = 3;
            } else {
                impactStatus = 'SEVERE';
                score = 1;
            }
            
            return {
                status: impactStatus,
                score,
                priceImpact,
                message: `Price impact is ${impactStatus.toLowerCase()} (${priceImpact.toFixed(3)}%)`
            };
            
        } catch (error) {
            logger.error('Price impact analysis failed', error);
            return {
                status: 'UNKNOWN',
                score: 0,
                message: `Price impact analysis failed: ${error.message}`
            };
        }
    }

    /**
     * Analyze market depth
     */
    async analyzeMarketDepth(tokenA, tokenB, tradeAmount) {
        try {
            // Test bid-ask spread by comparing both directions
            const [buyQuote, sellQuote] = await Promise.all([
                getQuoteWithRateLimit(tokenA.address, tokenB.address, tradeAmount.toString(), 50),
                getQuoteWithRateLimit(tokenB.address, tokenA.address, tradeAmount.toString(), 50)
            ]);
            
            if (!buyQuote || !sellQuote) {
                return {
                    status: 'POOR',
                    score: 2,
                    message: 'Could not get quotes for both directions'
                };
            }
            
            // Calculate implied spread
            const buyPrice = parseFloat(buyQuote.outAmount) / parseFloat(buyQuote.inAmount);
            const sellPrice = parseFloat(sellQuote.inAmount) / parseFloat(sellQuote.outAmount);
            const spread = Math.abs((buyPrice - sellPrice) / ((buyPrice + sellPrice) / 2)) * 100;
            
            let depthStatus, score;
            
            if (spread < 0.1) {
                depthStatus = 'EXCELLENT';
                score = 10;
            } else if (spread < 0.5) {
                depthStatus = 'GOOD';
                score = 8;
            } else if (spread < 2) {
                depthStatus = 'MODERATE';
                score = 6;
            } else if (spread < 5) {
                depthStatus = 'POOR';
                score = 3;
            } else {
                depthStatus = 'VERY_POOR';
                score = 1;
            }
            
            return {
                status: depthStatus,
                score,
                spread: spread.toFixed(3),
                buyPrice,
                sellPrice,
                message: `Market depth is ${depthStatus.toLowerCase().replace('_', ' ')} (spread: ${spread.toFixed(3)}%)`
            };
            
        } catch (error) {
            logger.error('Market depth analysis failed', error);
            return {
                status: 'UNKNOWN',
                score: 5,
                message: `Market depth analysis failed: ${error.message}`
            };
        }
    }

    /**
     * Collect price samples over time
     */
    async collectPriceSamples(tokenA, tokenB, sampleCount = 5) {
        const samples = [];
        const sampleInterval = 10000; // 10 seconds between samples
        
        for (let i = 0; i < sampleCount; i++) {
            try {
                const quote = await getQuoteWithRateLimit(
                    tokenA.address,
                    tokenB.address,
                    '1000000', // 1M units for price sampling
                    100
                );
                
                if (quote && quote.outAmount) {
                    const price = parseFloat(quote.outAmount) / 1000000;
                    samples.push({
                        timestamp: Date.now(),
                        price,
                        priceImpact: parseFloat(quote.priceImpactPct || 0)
                    });
                }
                
                // Wait between samples (except for last sample)
                if (i < sampleCount - 1) {
                    await new Promise(resolve => setTimeout(resolve, sampleInterval));
                }
                
            } catch (error) {
                logger.warn(`Price sample ${i + 1} failed:`, error.message);
            }
        }
        
        return samples;
    }

    /**
     * Calculate overall market score
     */
    calculateMarketScore(conditions) {
        const weights = {
            liquidity: 0.3,
            volatility: 0.25,
            priceImpact: 0.25,
            marketDepth: 0.2
        };
        
        let totalScore = 0;
        let totalWeight = 0;
        
        for (const [condition, weight] of Object.entries(weights)) {
            if (conditions[condition] && typeof conditions[condition].score === 'number') {
                totalScore += conditions[condition].score * weight;
                totalWeight += weight;
            }
        }
        
        return totalWeight > 0 ? totalScore / totalWeight : 0;
    }

    /**
     * Generate trading recommendation
     */
    generateRecommendation(analysis) {
        const score = analysis.overallScore;
        const conditions = analysis.conditions;
        
        if (score >= 8) {
            analysis.riskLevel = 'LOW';
            return {
                action: 'PROCEED',
                confidence: 'HIGH',
                message: 'Excellent market conditions for trading'
            };
        } else if (score >= 6) {
            analysis.riskLevel = 'MEDIUM';
            return {
                action: 'PROCEED_CAUTIOUSLY',
                confidence: 'MEDIUM',
                message: 'Good market conditions with some caution needed'
            };
        } else if (score >= 4) {
            analysis.riskLevel = 'HIGH';
            return {
                action: 'PROCEED_WITH_CAUTION',
                confidence: 'LOW',
                message: 'Moderate market conditions - reduce position size'
            };
        } else {
            analysis.riskLevel = 'VERY_HIGH';
            return {
                action: 'AVOID',
                confidence: 'LOW',
                message: 'Poor market conditions - avoid trading'
            };
        }
    }

    /**
     * Update market conditions cache
     */
    updateMarketConditions(analysis) {
        this.marketConditions = {
            overall: analysis.recommendation.action,
            volatility: analysis.conditions.volatility?.status || 'UNKNOWN',
            liquidity: analysis.conditions.liquidity?.status || 'UNKNOWN',
            trend: this.determineTrend(analysis),
            lastUpdate: analysis.timestamp,
            score: analysis.overallScore
        };
    }

    /**
     * Determine market trend
     */
    determineTrend(analysis) {
        // Simple trend determination based on price impact and volatility
        const priceImpact = analysis.conditions.priceImpact?.priceImpact || 0;
        const volatility = parseFloat(analysis.conditions.volatility?.volatility || 0);
        
        if (volatility > 5) return 'VOLATILE';
        if (priceImpact < 0.5) return 'STABLE';
        if (priceImpact > 3) return 'UNSTABLE';
        return 'NEUTRAL';
    }

    /**
     * Get current market conditions
     */
    getCurrentMarketConditions() {
        return {
            ...this.marketConditions,
            age: Date.now() - this.marketConditions.lastUpdate
        };
    }

    /**
     * Check if market conditions are suitable for trading
     */
    isSuitableForTrading(minScore = 5) {
        const conditions = this.getCurrentMarketConditions();
        return conditions.score >= minScore && conditions.overall !== 'AVOID';
    }

    /**
     * Generate market report
     */
    generateMarketReport(analysis) {
        if (!analysis || !analysis.conditions) {
            return 'No market analysis data available';
        }
        
        let report = '\n';
        report += '='.repeat(50) + '\n';
        report += '         MARKET CONDITION REPORT\n';
        report += '='.repeat(50) + '\n\n';
        
        report += `Token Pair: ${analysis.tokenPair}\n`;
        report += `Overall Score: ${analysis.overallScore.toFixed(1)}/10\n`;
        report += `Risk Level: ${analysis.riskLevel}\n`;
        report += `Recommendation: ${analysis.recommendation.action}\n\n`;
        
        // Condition details
        for (const [name, condition] of Object.entries(analysis.conditions)) {
            if (condition && condition.status) {
                report += `${name.toUpperCase()}:\n`;
                report += `   Status: ${condition.status}\n`;
                report += `   Score: ${condition.score}/10\n`;
                report += `   ${condition.message}\n\n`;
            }
        }
        
        report += '='.repeat(50) + '\n';
        
        return report;
    }
}

// Create singleton instance
const marketAnalyzer = new MarketConditionAnalyzer();

module.exports = marketAnalyzer;