const logger = require('./logger');
const axios = require('axios');

class MEVProtector {
    constructor() {
        this.enabled = process.env.ENABLE_MEV_PROTECTION === 'true';
        this.useJitoBundles = process.env.USE_JITO_BUNDLES === 'true';
        this.randomizeGas = process.env.RANDOMIZE_GAS === 'true';
        this.usePrivateMempool = process.env.USE_PRIVATE_MEMPOOL === 'true';
        this.maxMEVLoss = parseFloat(process.env.MAX_MEV_LOSS_PERCENT) || 0.2;
        
        // MEV tracking
        this.detectedMEV = new Map(); // txHash -> MEV data
        this.protectionStats = {
            totalTrades: 0,
            protectedTrades: 0,
            mevSaved: 0,
            bundleSuccessRate: 0
        };
        
        // Jito bundle endpoints
        this.jitoBundleEndpoints = [
            'https://mainnet.block-engine.jito.wtf',
            'https://amsterdam.mainnet.block-engine.jito.wtf',
            'https://frankfurt.mainnet.block-engine.jito.wtf',
            'https://ny.mainnet.block-engine.jito.wtf',
            'https://tokyo.mainnet.block-engine.jito.wtf'
        ];
        
        logger.info('MEV Protector initialized', {
            enabled: this.enabled,
            jitoBundles: this.useJitoBundles,
            randomizeGas: this.randomizeGas,
            privateMempool: this.usePrivateMempool
        });
    }

    /**
     * Apply MEV protection to transaction parameters
     */
    async applyMEVProtection(transactionParams, tradeSize, expectedProfit) {
        if (!this.enabled) {
            return transactionParams;
        }

        try {
            logger.debug('🛡️ Applying MEV protection strategies');
            
            const protectedParams = { ...transactionParams };
            
            // 1. Randomize gas price to avoid pattern detection
            if (this.randomizeGas) {
                protectedParams.priority = this.randomizeGasPrice(protectedParams.priority || 100000);
            }
            
            // 2. Add timing randomization
            protectedParams.sendDelay = this.getRandomDelay();
            
            // 3. Calculate optimal bundle configuration
            if (this.useJitoBundles) {
                protectedParams.bundleConfig = await this.prepareBundleConfig(tradeSize, expectedProfit);
            }
            
            // 4. Add MEV monitoring hooks
            protectedParams.mevMonitoring = {
                enabled: true,
                expectedProfit,
                tradeSize,
                protectionLevel: this.calculateProtectionLevel(tradeSize, expectedProfit)
            };
            
            this.protectionStats.totalTrades++;
            this.protectionStats.protectedTrades++;
            
            logger.debug('✅ MEV protection applied', {
                randomizedGas: this.randomizeGas ? protectedParams.priority : 'disabled',
                sendDelay: protectedParams.sendDelay,
                bundleEnabled: !!protectedParams.bundleConfig,
                protectionLevel: protectedParams.mevMonitoring.protectionLevel
            });
            
            return protectedParams;
            
        } catch (error) {
            logger.error('Error applying MEV protection:', error);
            // Return original params if protection fails
            return transactionParams;
        }
    }

    /**
     * Randomize gas price to avoid MEV targeting
     */
    randomizeGasPrice(basePrice) {
        // Randomize ±20% around base price
        const randomFactor = 0.8 + (Math.random() * 0.4);
        const randomizedPrice = Math.floor(basePrice * randomFactor);
        
        // Ensure minimum gas price
        return Math.max(randomizedPrice, 50000);
    }

    /**
     * Get random delay for transaction submission
     */
    getRandomDelay() {
        // Random delay between 0-2000ms to avoid predictable timing
        return Math.floor(Math.random() * 2000);
    }

    /**
     * Prepare Jito bundle configuration
     */
    async prepareBundleConfig(tradeSize, expectedProfit) {
        try {
            // Calculate bundle tip based on expected profit
            const profitUSD = expectedProfit * tradeSize * 100; // Rough USD estimate
            const bundleTip = Math.max(0.001, Math.min(0.01, profitUSD * 0.1)); // 10% of profit, capped
            
            // Select best Jito endpoint
            const endpoint = await this.selectBestJitoEndpoint();
            
            return {
                endpoint,
                tip: bundleTip,
                maxRetries: 3,
                timeout: 30000
            };
            
        } catch (error) {
            logger.warn('Error preparing bundle config:', error.message);
            return null;
        }
    }

    /**
     * Select the best performing Jito endpoint
     */
    async selectBestJitoEndpoint() {
        // For now, return a random endpoint
        // TODO: Implement latency testing and endpoint selection
        const randomIndex = Math.floor(Math.random() * this.jitoBundleEndpoints.length);
        return this.jitoBundleEndpoints[randomIndex];
    }

    /**
     * Calculate protection level based on trade parameters
     */
    calculateProtectionLevel(tradeSize, expectedProfit) {
        // Higher trade size and profit = higher MEV risk = higher protection level
        const sizeScore = Math.min(1, tradeSize / 1.0); // Normalize to 1 SOL max
        const profitScore = Math.min(1, expectedProfit / 5.0); // Normalize to 5% max
        
        const riskScore = (sizeScore * 0.6) + (profitScore * 0.4);
        
        if (riskScore > 0.8) return 'HIGH';
        if (riskScore > 0.5) return 'MEDIUM';
        return 'LOW';
    }

    /**
     * Execute transaction with MEV protection
     */
    async executeProtectedTransaction(signedTransaction, protectionParams) {
        if (!this.enabled || !protectionParams.mevMonitoring) {
            // Standard execution
            return await this.standardExecution(signedTransaction);
        }

        const protectionLevel = protectionParams.mevMonitoring.protectionLevel;
        
        try {
            logger.info(`🛡️ Executing transaction with ${protectionLevel} MEV protection`);
            
            // Apply send delay
            if (protectionParams.sendDelay > 0) {
                logger.debug(`⏳ Applying MEV protection delay: ${protectionParams.sendDelay}ms`);
                await new Promise(resolve => setTimeout(resolve, protectionParams.sendDelay));
            }
            
            let txResult;
            
            // Try Jito bundle first if enabled
            if (this.useJitoBundles && protectionParams.bundleConfig) {
                logger.debug('📦 Attempting Jito bundle submission');
                txResult = await this.executeJitoBundle(signedTransaction, protectionParams.bundleConfig);
                
                if (txResult && txResult.success) {
                    logger.info('✅ Transaction executed via Jito bundle');
                    this.protectionStats.bundleSuccessRate++;
                    return txResult;
                } else {
                    logger.warn('⚠️ Jito bundle failed, falling back to standard execution');
                }
            }
            
            // Fallback to private mempool if available
            if (this.usePrivateMempool && protectionLevel === 'HIGH') {
                logger.debug('🔒 Attempting private mempool submission');
                txResult = await this.executePrivateMempool(signedTransaction);
                
                if (txResult && txResult.success) {
                    logger.info('✅ Transaction executed via private mempool');
                    return txResult;
                }
            }
            
            // Standard execution as final fallback
            logger.debug('📡 Executing via standard RPC');
            return await this.standardExecution(signedTransaction);
            
        } catch (error) {
            logger.error('Error in protected transaction execution:', error);
            // Final fallback to standard execution
            return await this.standardExecution(signedTransaction);
        }
    }

    /**
     * Execute transaction via Jito bundle
     */
    async executeJitoBundle(signedTransaction, bundleConfig) {
        try {
            const bundleEndpoint = `${bundleConfig.endpoint}/api/v1/bundles`;
            
            const bundle = {
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [
                    [signedTransaction.serialize({ verifySignatures: false }).toString('base64')]
                ]
            };
            
            const response = await axios.post(bundleEndpoint, bundle, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: bundleConfig.timeout
            });
            
            if (response.data && response.data.result) {
                return {
                    success: true,
                    txid: response.data.result,
                    method: 'jito_bundle'
                };
            } else {
                throw new Error('Invalid bundle response');
            }
            
        } catch (error) {
            logger.debug('Jito bundle execution failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Execute transaction via private mempool (placeholder for future implementation)
     */
    async executePrivateMempool(signedTransaction) {
        try {
            // TODO: Implement actual private mempool submission
            // This could integrate with services like Flashbots, Eden, etc.
            
            logger.debug('Private mempool execution not yet implemented, using standard');
            return await this.standardExecution(signedTransaction);
            
        } catch (error) {
            logger.debug('Private mempool execution failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Standard transaction execution
     */
    async standardExecution(signedTransaction) {
        try {
            const { Connection } = require('@solana/web3.js');
            const connection = new Connection(process.env.DEFAULT_RPC);
            
            const txid = await connection.sendRawTransaction(signedTransaction.serialize(), {
                skipPreflight: false,
                maxRetries: 3
            });
            
            return {
                success: true,
                txid,
                method: 'standard_rpc'
            };
            
        } catch (error) {
            logger.error('Standard execution failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Monitor for MEV attacks after transaction
     */
    async monitorMEVAttack(txid, expectedProfit, tradeSize) {
        if (!this.enabled) return null;
        
        try {
            // Wait a bit for transaction to be processed
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // TODO: Implement actual MEV detection logic
            // This could analyze:
            // 1. Transaction ordering in the block
            // 2. Similar transactions executed before/after
            // 3. Actual vs expected profit
            // 4. Price impact differences
            
            const mevData = {
                txid,
                timestamp: Date.now(),
                expectedProfit,
                tradeSize,
                mevDetected: false, // Placeholder
                estimatedMEVLoss: 0,
                blockPosition: null
            };
            
            this.detectedMEV.set(txid, mevData);
            
            return mevData;
            
        } catch (error) {
            logger.error('Error monitoring MEV:', error);
            return null;
        }
    }

    /**
     * Get MEV protection statistics
     */
    getProtectionStats() {
        const totalMEVSaved = Array.from(this.detectedMEV.values())
            .reduce((total, data) => total + (data.estimatedMEVLoss || 0), 0);
        
        return {
            ...this.protectionStats,
            totalMEVSaved: totalMEVSaved,
            protectionRate: this.protectionStats.totalTrades > 0 ? 
                (this.protectionStats.protectedTrades / this.protectionStats.totalTrades) : 0,
            averageMEVSaved: this.protectionStats.protectedTrades > 0 ?
                (totalMEVSaved / this.protectionStats.protectedTrades) : 0,
            detectedAttacks: this.detectedMEV.size
        };
    }

    /**
     * Generate MEV protection report
     */
    generateProtectionReport() {
        const stats = this.getProtectionStats();
        
        let report = '\n';
        report += '='.repeat(60) + '\n';
        report += '           MEV PROTECTION REPORT\n';
        report += '='.repeat(60) + '\n\n';
        
        report += `🛡️ PROTECTION STATUS: ${this.enabled ? 'ENABLED' : 'DISABLED'}\n\n`;
        
        if (this.enabled) {
            report += `📊 PROTECTION STATISTICS:\n`;
            report += `   Total Trades: ${stats.totalTrades}\n`;
            report += `   Protected Trades: ${stats.protectedTrades}\n`;
            report += `   Protection Rate: ${(stats.protectionRate * 100).toFixed(1)}%\n`;
            report += `   Bundle Success Rate: ${(stats.bundleSuccessRate * 100).toFixed(1)}%\n`;
            report += `   Total MEV Saved: ${stats.totalMEVSaved.toFixed(2)}\n`;
            report += `   Average MEV Saved: ${stats.averageMEVSaved.toFixed(4)} per trade\n\n`;
            
            report += `🔧 ACTIVE PROTECTIONS:\n`;
            report += `   Jito Bundles: ${this.useJitoBundles ? 'ENABLED' : 'DISABLED'}\n`;
            report += `   Gas Randomization: ${this.randomizeGas ? 'ENABLED' : 'DISABLED'}\n`;
            report += `   Private Mempool: ${this.usePrivateMempool ? 'ENABLED' : 'DISABLED'}\n`;
            report += `   Max MEV Loss: ${this.maxMEVLoss}%\n\n`;
            
            if (stats.detectedAttacks > 0) {
                report += `⚠️ DETECTED MEV ATTACKS: ${stats.detectedAttacks}\n`;
                report += `   Check logs for detailed attack analysis\n\n`;
            }
        } else {
            report += `⚠️ MEV protection is DISABLED\n`;
            report += `   Enable with ENABLE_MEV_PROTECTION=true in .env\n\n`;
        }
        
        report += '='.repeat(60) + '\n';
        
        return report;
    }

    /**
     * Clean up old MEV data
     */
    cleanupOldData() {
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
        
        for (const [txid, data] of this.detectedMEV) {
            if (data.timestamp < cutoffTime) {
                this.detectedMEV.delete(txid);
            }
        }
        
        logger.debug('Cleaned up old MEV protection data');
    }

    /**
     * Update protection settings dynamically
     */
    updateSettings(newSettings) {
        if (newSettings.hasOwnProperty('enabled')) {
            this.enabled = newSettings.enabled;
        }
        if (newSettings.hasOwnProperty('useJitoBundles')) {
            this.useJitoBundles = newSettings.useJitoBundles;
        }
        if (newSettings.hasOwnProperty('randomizeGas')) {
            this.randomizeGas = newSettings.randomizeGas;
        }
        if (newSettings.hasOwnProperty('maxMEVLoss')) {
            this.maxMEVLoss = newSettings.maxMEVLoss;
        }
        
        logger.info('MEV protection settings updated', newSettings);
    }
}

// Create singleton instance
const mevProtector = new MEVProtector();

module.exports = mevProtector;