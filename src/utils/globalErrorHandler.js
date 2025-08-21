const chalk = require("chalk");
const fs = require("fs");
const cache = require("../bot/cache");
const logger = require("./logger");

class GlobalErrorHandler {
    constructor() {
        this.isShuttingDown = false;
        this.errorCount = 0;
        this.lastErrorTime = 0;
        this.maxErrorsPerMinute = 10;
        this.setupHandlers();
    }

    setupHandlers() {
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception:', error);
            this.handleCriticalError(error, 'uncaughtException');
        });

        // Handle unhandled promise rejections - ENHANCED
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
            
            // Enhanced handling for specific rejection types
            if (reason && typeof reason === 'object') {
                if (reason.message && reason.message.includes('Jupiter')) {
                    logger.warn('Jupiter API related unhandled rejection detected');
                    this.handleJupiterError(reason, 'unhandledRejection');
                    return;
                }
                
                if (reason.code === 'ECONNRESET' || reason.code === 'ETIMEDOUT') {
                    logger.warn('Network related unhandled rejection detected');
                    this.handleNetworkError(reason, 'unhandledRejection');
                    return;
                }
            }
            
            this.handleCriticalError(reason, 'unhandledRejection');
        });

        // Handle SIGINT (Ctrl+C)
        process.on('SIGINT', () => {
            logger.info('Received SIGINT (Ctrl+C)');
            this.gracefulShutdown('SIGINT');
        });

        // Handle SIGTERM
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM');
            this.gracefulShutdown('SIGTERM');
        });

        // Handle warning events
        process.on('warning', (warning) => {
            logger.warn('Process Warning:', {
                name: warning.name,
                message: warning.message,
                stack: warning.stack
            });
        });

        // Handle exit event
        process.on('exit', (code) => {
            logger.info(`Process exiting with code: ${code}`);
        });
    }

    handleJupiterError(error, type) {
        this.errorCount++;
        
        logger.warn(`Jupiter API error (${type}):`, {
            message: error.message,
            count: this.errorCount,
            timestamp: new Date().toISOString()
        });
        
        // If too many Jupiter errors in short time, consider temporary pause
        if (this.errorCount > 5) {
            logger.warn('Multiple Jupiter API errors detected - implementing cooling period');
            
            // Set a flag to slow down requests temporarily
            if (cache) {
                cache.jupiterCooldown = Date.now() + 60000; // 1 minute cooldown
            }
        }
        
        // Don't shutdown for Jupiter API errors - let retry logic handle them
        return;
    }

    handleNetworkError(error, type) {
        logger.warn(`Network error (${type}):`, {
            message: error.message,
            code: error.code,
            timestamp: new Date().toISOString()
        });
        
        // Don't shutdown for network errors - they're usually temporary
        return;
    }

    handleCriticalError(error, type) {
        if (this.isShuttingDown) {
            return; // Prevent recursive error handling
        }

        const now = Date.now();
        
        // Reset error count if more than a minute has passed
        if (now - this.lastErrorTime > 60000) {
            this.errorCount = 0;
        }
        
        this.errorCount++;
        this.lastErrorTime = now;

        try {
            // Enhanced error logging with more context
            logger.error(`Critical ${type} detected:`, {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString(),
                errorCount: this.errorCount,
                botIteration: cache?.iteration || 0,
                currentToken: cache?.currentRotationToken?.symbol || 'unknown',
                swappingNow: cache?.swappingRightNow || false,
                tradingEnabled: cache?.tradingEnabled || false
            });

            // Don't shutdown immediately for certain error types
            if (this.shouldIgnoreError(error)) {
                logger.info('Error type ignored - continuing operation');
                return;
            }

            // Only shutdown if we have too many critical errors
            if (this.errorCount >= 3) {
                logger.error(`Too many critical errors (${this.errorCount}) - initiating shutdown`);
                
                // Save current state before shutdown
                this.saveEmergencyState(error, type);
                
                // Force shutdown after saving state
                this.emergencyShutdown(type);
            } else {
                logger.warn(`Critical error ${this.errorCount}/3 - continuing with caution`);
                this.saveErrorState(error, type);
            }
            
        } catch (saveError) {
            console.error('Failed to handle critical error:', saveError);
            process.exit(1);
        }
    }

    shouldIgnoreError(error) {
        if (!error || !error.message) return false;
        
        const ignorableErrors = [
            'Jupiter API error',
            'ECONNRESET',
            'ETIMEDOUT',
            'ENOTFOUND',
            'timeout',
            'Rate limit',
            'Network request failed'
        ];
        
        return ignorableErrors.some(ignorable => 
            error.message.toLowerCase().includes(ignorable.toLowerCase())
        );
    }

    saveErrorState(error, type) {
        try {
            const errorData = {
                timestamp: new Date().toISOString(),
                errorType: type,
                errorCount: this.errorCount,
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                },
                botState: {
                    iteration: cache?.iteration || 0,
                    tradingEnabled: cache?.tradingEnabled || false,
                    swappingRightNow: cache?.swappingRightNow || false,
                    currentBalance: cache?.currentBalance || {},
                    tradeCounter: cache?.tradeCounter || {},
                    currentRotationToken: cache?.currentRotationToken?.symbol || 'unknown'
                }
            };

            // Ensure temp directory exists
            if (!fs.existsSync('./temp')) {
                fs.mkdirSync('./temp', { recursive: true });
            }

            // Save error state (not emergency - just logging)
            const errorFile = `./temp/error_${Date.now()}.json`;
            fs.writeFileSync(errorFile, JSON.stringify(errorData, null, 2));
            
            logger.info(`Error state saved to: ${errorFile}`);

        } catch (error) {
            console.error('Failed to save error state:', error);
        }
    }

    saveEmergencyState(error, type) {
        try {
            const emergencyData = {
                timestamp: new Date().toISOString(),
                errorType: type,
                errorCount: this.errorCount,
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                },
                botState: {
                    tradingEnabled: cache?.tradingEnabled || false,
                    swappingRightNow: cache?.swappingRightNow || false,
                    iteration: cache?.iteration || 0,
                    currentBalance: cache?.currentBalance || {},
                    tradeCounter: cache?.tradeCounter || {},
                    currentRotationToken: cache?.currentRotationToken?.symbol || 'unknown',
                    maxProfitSpotted: cache?.maxProfitSpotted || {},
                    tradeHistory: cache?.tradeHistory?.slice(-10) || [] // Last 10 trades
                },
                processInfo: {
                    pid: process.pid,
                    platform: process.platform,
                    nodeVersion: process.version,
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage()
                }
            };

            // Ensure temp directory exists
            if (!fs.existsSync('./temp')) {
                fs.mkdirSync('./temp', { recursive: true });
            }

            // Save emergency state
            const emergencyFile = `./temp/emergency_shutdown_${Date.now()}.json`;
            fs.writeFileSync(emergencyFile, JSON.stringify(emergencyData, null, 2));
            
            logger.info(`Emergency state saved to: ${emergencyFile}`);

            // Also save cache and trade history if possible
            try {
                if (cache) {
                    fs.writeFileSync("./temp/emergency_cache.json", JSON.stringify(cache, null, 2));
                    if (cache.tradeHistory) {
                        fs.writeFileSync("./temp/emergency_trade_history.json", JSON.stringify(cache.tradeHistory, null, 2));
                    }
                }
            } catch (cacheError) {
                logger.warn('Failed to save cache during emergency:', cacheError.message);
            }

        } catch (error) {
            console.error('Failed to save emergency state:', error);
        }
    }

    gracefulShutdown(signal) {
        if (this.isShuttingDown) {
            logger.warn('Shutdown already in progress...');
            return;
        }

        this.isShuttingDown = true;
        logger.info(`Starting graceful shutdown due to ${signal}...`);

        // Set timeout for forced shutdown
        const forceShutdownTimer = setTimeout(() => {
            logger.error('Graceful shutdown timeout - forcing exit');
            process.exit(1);
        }, 30000); // 30 seconds timeout

        this.performGracefulShutdown()
            .then(() => {
                clearTimeout(forceShutdownTimer);
                logger.info('Graceful shutdown completed');
                process.exit(0);
            })
            .catch((error) => {
                clearTimeout(forceShutdownTimer);
                logger.error('Error during graceful shutdown:', error);
                process.exit(1);
            });
    }

    async performGracefulShutdown() {
        try {
            logger.info('Performing graceful shutdown...');

            // Stop trading immediately
            if (cache) {
                cache.tradingEnabled = false;
                logger.info('Trading disabled');
            }

            // Wait for any ongoing swaps to complete
            if (cache && cache.swappingRightNow) {
                logger.info('Waiting for ongoing swap to complete...');
                let waitTime = 0;
                while (cache.swappingRightNow && waitTime < 15000) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    waitTime += 1000;
                }
                
                if (cache.swappingRightNow) {
                    logger.warn('Swap still in progress after 15s - continuing shutdown');
                }
            }

            // Clear any running intervals
            if (global.botInterval) {
                clearInterval(global.botInterval);
                logger.info('Bot interval cleared');
            }

            if (global.tokenRotationInterval) {
                clearInterval(global.tokenRotationInterval);
                logger.info('Token rotation interval cleared');
            }

            // Save final state
            await this.saveFinalState();

            logger.info('Graceful shutdown preparations complete');
        } catch (error) {
            logger.error('Error during graceful shutdown:', error);
            throw error;
        }
    }

    async saveFinalState() {
        try {
            // Ensure temp directory exists
            if (!fs.existsSync('./temp')) {
                fs.mkdirSync('./temp', { recursive: true });
            }

            // Save cache
            if (cache) {
                fs.writeFileSync("./temp/cache.json", JSON.stringify(cache, null, 2));
                logger.info('Cache saved successfully');

                // Save trade history
                if (cache.tradeHistory && cache.tradeHistory.length > 0) {
                    fs.writeFileSync("./temp/tradeHistory.json", JSON.stringify(cache.tradeHistory, null, 2));
                    logger.info('Trade history saved successfully');
                }
            }

            // Save shutdown report
            const shutdownReport = {
                timestamp: new Date().toISOString(),
                type: 'graceful_shutdown',
                statistics: {
                    totalIterations: cache?.iteration || 0,
                    successfulTrades: (cache?.tradeCounter?.buy?.success || 0) + (cache?.tradeCounter?.sell?.success || 0),
                    failedTrades: (cache?.tradeCounter?.buy?.fail || 0) + (cache?.tradeCounter?.sell?.fail || 0),
                    totalProfit: cache?.currentProfit || {},
                    uptime: process.uptime(),
                    errorCount: this.errorCount
                },
                finalState: {
                    tradingEnabled: cache?.tradingEnabled || false,
                    currentBalance: cache?.currentBalance || {},
                    currentToken: cache?.currentRotationToken?.symbol || 'unknown'
                }
            };

            fs.writeFileSync('./temp/shutdown_report.json', JSON.stringify(shutdownReport, null, 2));
            logger.info('Shutdown report saved');

        } catch (error) {
            logger.warn('Failed to save final state:', error.message);
        }
    }

    emergencyShutdown(type) {
        console.error(chalk.red.bold(`\n⚠️  EMERGENCY SHUTDOWN - ${type.toUpperCase()} ⚠️`));
        console.error(chalk.red('Bot state has been saved to ./temp/ directory'));
        console.error(chalk.red('Check the emergency shutdown file for details'));
        console.error(chalk.red('Exiting in 3 seconds...\n'));

        setTimeout(() => {
            process.exit(1);
        }, 3000);
    }

    // Method to manually trigger graceful shutdown
    triggerShutdown(reason = 'manual') {
        logger.info(`Manual shutdown triggered: ${reason}`);
        this.gracefulShutdown(`MANUAL_${reason.toUpperCase()}`);
    }

    // Reset error count (useful for recovery)
    resetErrorCount() {
        this.errorCount = 0;
        this.lastErrorTime = 0;
        logger.info('Error count reset');
    }

    // Get current error status
    getErrorStatus() {
        return {
            errorCount: this.errorCount,
            lastErrorTime: this.lastErrorTime,
            isShuttingDown: this.isShuttingDown,
            maxErrorsPerMinute: this.maxErrorsPerMinute
        };
    }
}

// Singleton instance
const globalErrorHandler = new GlobalErrorHandler();

module.exports = globalErrorHandler;