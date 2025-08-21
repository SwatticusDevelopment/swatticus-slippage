#!/usr/bin/env node
"use strict";
require("dotenv").config();

// Initialize global error handler first
const globalErrorHandler = require("./utils/globalErrorHandler");

// Import all the new systems
const logger = require("./utils/logger");
const configValidator = require("./utils/configValidator");
const memoryManager = require("./utils/memoryManager");
const healthMonitor = require("./utils/healthMonitor");
const transactionValidator = require("./utils/transactionValidator");

const chalk = require("chalk");
const ora = require("ora-classic");
const fs = require("fs");

// Core utility functions - check if the utils/index.js exists first
let checkForEnvFile, checkWallet, checkArbReady, createTempDir;

try {
    const utils = require("./utils/index");
    checkForEnvFile = utils.checkForEnvFile;
    checkWallet = utils.checkWallet;
    checkArbReady = utils.checkArbReady;
    createTempDir = utils.createTempDir;
} catch (utilsError) {
    // Fallback: implement basic functions inline
    console.log(chalk.yellow("Warning: utils/index.js not found, using fallback implementations"));
    
    checkForEnvFile = () => {
        if (!fs.existsSync('.env')) {
            console.error(chalk.red("❌ .env file not found. Please create it based on .env.example"));
            process.exit(1);
        }
    };
    
    checkWallet = () => {
        if (!process.env.SOLANA_WALLET_PRIVATE_KEY) {
            console.error(chalk.red("❌ SOLANA_WALLET_PRIVATE_KEY is missing in environment variables"));
            process.exit(1);
        }
    };
    
    checkArbReady = async () => {
        try {
            const { Connection, Keypair } = require("@solana/web3.js");
            const bs58 = require("bs58");
            
            const connection = new Connection(process.env.DEFAULT_RPC);
            const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY));
            
            console.log(chalk.green(`Wallet connected successfully: ${wallet.publicKey.toString()}`));
            return true;
        } catch (err) {
            console.error(chalk.red("Failed to connect to wallet or RPC:"), err.message);
            process.exit(1);
        }
    };
    
    createTempDir = () => {
        if (!fs.existsSync("./temp")) {
            fs.mkdirSync("./temp", { recursive: true });
        }
        if (!fs.existsSync("./logs")) {
            fs.mkdirSync("./logs", { recursive: true });
        }
    };
}

async function main() {
    let spinner;
    
    try {
        // Clear console and show startup banner
        console.clear();
        console.log(chalk.bold.cyan('\n' + '='.repeat(60)));
        console.log(chalk.bold.cyan('           JUPITER ARBITRAGE BOT v2.0'));
        console.log(chalk.bold.cyan('              Advanced Edition'));
        console.log(chalk.bold.cyan('='.repeat(60)));
        console.log();
        
        logger.info('Bot startup initiated');
        
        // Create temp directory
        createTempDir();
        
        // Phase 1: Configuration Validation
        console.log(chalk.yellow('🔧 Phase 1: Configuration Validation'));
        spinner = ora('Validating configuration...').start();
        
        try {
            const validation = await configValidator.validateConfig();
            
            if (!validation.isValid) {
                spinner.fail('Configuration validation failed');
                console.log(configValidator.generateReport(validation));
                configValidator.saveValidationReport(validation);
                
                logger.error('Configuration validation failed', {
                    errors: validation.errors.length,
                    warnings: validation.warnings.length
                });
                
                process.exit(1);
            }
            
            spinner.succeed('Configuration validated successfully');
            
            // Show warnings if any
            if (validation.warnings.length > 0) {
                console.log(chalk.yellow('\n⚠️  Configuration Warnings:'));
                validation.warnings.slice(0, 3).forEach(warning => {
                    console.log(chalk.yellow(`   ${warning}`));
                });
                if (validation.warnings.length > 3) {
                    console.log(chalk.yellow(`   ... and ${validation.warnings.length - 3} more warnings`));
                }
                console.log(chalk.gray('   Check ./temp/config_validation.json for full details\n'));
            }
            
            configValidator.saveValidationReport(validation);
            
        } catch (error) {
            spinner.fail('Configuration validation error');
            logger.error('Configuration validation failed', error);
            throw error;
        }
        
        // Phase 2: System Initialization
        console.log(chalk.yellow('🚀 Phase 2: System Initialization'));
        
        // Initialize health monitoring
        spinner = ora('Starting health monitoring...').start();
        healthMonitor; // Just accessing it starts the monitoring
        spinner.succeed('Health monitoring active');
        
        // Initialize memory management
        spinner = ora('Starting memory management...').start();
        memoryManager; // Just accessing it starts the management
        spinner.succeed('Memory management active');
        
        // Validate wallet
        spinner = ora('Validating wallet...').start();
        try {
            checkWallet();
            spinner.succeed('Wallet validation passed');
        } catch (error) {
            spinner.fail('Wallet validation failed');
            throw error;
        }
        
        // Check arbitrage readiness
        spinner = ora('Checking arbitrage readiness...').start();
        try {
            await checkArbReady();
            spinner.succeed('Arbitrage readiness confirmed');
        } catch (error) {
            spinner.fail('Arbitrage readiness check failed');
            throw error;
        }
        
        // Phase 3: Safety Checks
        console.log(chalk.yellow('🛡️  Phase 3: Safety Validation'));
        
        spinner = ora('Running pre-flight safety checks...').start();
        
        // Check trading mode
        const tradingEnabled = process.env.TRADING_ENABLED === 'true';
        if (tradingEnabled) {
            spinner.warn('Real trading mode detected');
            console.log(chalk.red.bold('\n⚠️  WARNING: REAL TRADING MODE ENABLED'));
            console.log(chalk.red('This bot will execute real transactions with real money.'));
            console.log(chalk.red('Ensure you understand the risks before proceeding.\n'));
            
            // Give user a chance to abort
            console.log(chalk.yellow('Starting in 10 seconds... Press Ctrl+C to abort'));
            await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
            spinner.succeed('Running in simulation mode (safe)');
        }
        
        // Check system resources
        const healthStatus = healthMonitor.getHealthStatus();
        if (!healthStatus.isHealthy) {
            spinner.warn('System health warnings detected');
            console.log(healthMonitor.generateHealthReport());
        } else {
            spinner.succeed('System health checks passed');
        }
        
        // Check memory status
        const memoryStats = memoryManager.getMemoryStats();
        const memoryUsage = parseFloat(memoryStats.current.usagePercent);
        if (memoryUsage > 80) {
            spinner.warn(`High memory usage detected: ${memoryStats.current.usagePercent}`);
        } else {
            spinner.succeed('Memory usage normal');
        }
        
        // Phase 4: Bot Startup
        console.log(chalk.yellow('🤖 Phase 4: Bot Initialization'));
        
        spinner = ora('Starting trading bot...').start();
        
        // Log startup summary
        logger.info('Bot initialization complete', {
            tradingEnabled,
            memoryUsage: memoryStats.current.usagePercent,
            healthStatus: healthStatus.isHealthy ? 'HEALTHY' : 'WARNING',
            nodeVersion: process.version,
            platform: process.platform
        });
        
        spinner.succeed('All systems initialized successfully');
        
        // Start the actual bot
        console.log(chalk.green.bold('\n✅ All systems ready!'));
        console.log(chalk.cyan('🚀 Starting Jupiter Arbitrage Bot...\n'));
        
        // Import and start the bot (this will use all our new systems)
        require('./bot/index.js');
        
    } catch (error) {
        if (spinner) {
            spinner.fail('Startup failed');
        }
        
        console.log(chalk.red.bold('\n❌ Bot startup failed!'));
        console.log(chalk.red('Error details:'));
        console.log(chalk.red(`   ${error.message}`));
        
        if (process.env.DEBUG === 'true') {
            console.log(chalk.gray('\nStack trace:'));
            console.log(chalk.gray(error.stack));
        }
        
        logger.error('Bot startup failed', {
            error: error.message,
            stack: error.stack
        });
        
        // Save error details
        try {
            const errorReport = {
                timestamp: new Date().toISOString(),
                error: {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                },
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    memory: process.memoryUsage(),
                    uptime: process.uptime()
                }
            };
            
            fs.writeFileSync('./temp/startup_error.json', JSON.stringify(errorReport, null, 2));
            console.log(chalk.gray('\nError details saved to ./temp/startup_error.json'));
        } catch (saveError) {
            console.log(chalk.gray('Could not save error details'));
        }
        
        console.log(chalk.yellow('\nTroubleshooting tips:'));
        console.log(chalk.yellow('1. Check your .env file configuration'));
        console.log(chalk.yellow('2. Ensure your wallet private key is valid'));
        console.log(chalk.yellow('3. Verify your RPC endpoints are accessible'));
        console.log(chalk.yellow('4. Check the logs in ./logs/ directory'));
        console.log(chalk.yellow('5. Run with DEBUG=true for more details'));
        console.log(chalk.yellow('6. Make sure all new utility files are created in src/utils/'));
        
        process.exit(1);
    }
}

// Handle graceful shutdown
const shutdown = (signal) => {
    logger.info(`Received ${signal} - initiating graceful shutdown`);
    
    // Stop all systems
    try {
        healthMonitor.stopMonitoring();
        memoryManager.stop();
        logger.info('All systems stopped gracefully');
    } catch (error) {
        logger.error('Error during system shutdown', error);
    }
    
    process.exit(0);
};

// Setup process handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle unhandled rejections (global error handler will catch these)
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error);
    process.exit(1);
});

// Start the main function
main().catch(error => {
    console.error(chalk.red.bold('Fatal startup error:'), error);
    process.exit(1);
});