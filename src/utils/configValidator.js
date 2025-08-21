const fs = require("fs");
const chalk = require("chalk");
const { PublicKey, Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const logger = require("./logger");

class ConfigValidator {
    constructor() {
        this.requiredEnvVars = [
            'SOLANA_WALLET_PRIVATE_KEY',
            'DEFAULT_RPC'
        ];
        
        this.optionalEnvVars = {
            'ALT_RPC_LIST': '',
            'TRADE_SIZE_SOL': '0.1',
            'TRADE_SIZE_STRATEGY': 'fixed',
            'MIN_PROFIT_THRESHOLD': '0.5',
            'MAX_SLIPPAGE_PERCENT': '1.0',
            'PRIORITY': '100',
            'MIN_INTERVAL_MS': '5000',
            'UPDATE_INTERVAL': '10000',
            'TOKEN_ROTATION_INTERVAL_MINUTES': '5',
            'TRADING_ENABLED': 'false',
            'WRAP_UNWRAP_SOL': 'true',
            'AUTO_RETRY_FAILED': 'true',
            'RETRY_DELAY_MS': '5000',
            'MAX_RETRY_ATTEMPTS': '3',
            'ADAPTIVE_SLIPPAGE': 'false',
            'DEBUG': 'false',
            'UI_COLOR': 'cyan',
            'LOG_LEVEL': 'info',
            'NODE_ENV': 'production',
            'NETWORK': 'mainnet-beta'
        };
        
        this.validationRules = {
            'TRADE_SIZE_SOL': { type: 'number', min: 0.001, max: 100 },
            'MIN_PROFIT_THRESHOLD': { type: 'number', min: 0, max: 100 },
            'MAX_SLIPPAGE_PERCENT': { type: 'number', min: 0.1, max: 50 },
            'PRIORITY': { type: 'integer', min: 1, max: 1000000 },
            'MIN_INTERVAL_MS': { type: 'integer', min: 100, max: 3600000 },
            'UPDATE_INTERVAL': { type: 'integer', min: 1000, max: 3600000 },
            'TOKEN_ROTATION_INTERVAL_MINUTES': { type: 'integer', min: 1, max: 1440 },
            'RETRY_DELAY_MS': { type: 'integer', min: 1000, max: 60000 },
            'MAX_RETRY_ATTEMPTS': { type: 'integer', min: 1, max: 10 },
            'TRADING_ENABLED': { type: 'boolean' },
            'WRAP_UNWRAP_SOL': { type: 'boolean' },
            'AUTO_RETRY_FAILED': { type: 'boolean' },
            'ADAPTIVE_SLIPPAGE': { type: 'boolean' },
            'DEBUG': { type: 'boolean' },
            'TRADE_SIZE_STRATEGY': { type: 'enum', values: ['fixed', 'cumulative'] },
            'UI_COLOR': { type: 'enum', values: ['cyan', 'green', 'yellow', 'blue', 'magenta', 'red', 'white'] },
            'LOG_LEVEL': { type: 'enum', values: ['error', 'warn', 'info', 'debug'] },
            'NETWORK': { type: 'enum', values: ['mainnet-beta', 'devnet', 'testnet'] }
        };
    }

    /**
     * Validate all configuration
     */
    async validateConfig() {
        logger.info('Starting configuration validation...');
        
        const validation = {
            isValid: true,
            errors: [],
            warnings: [],
            info: [],
            config: {}
        };

        try {
            // 1. Check if .env file exists
            if (!fs.existsSync('.env')) {
                validation.errors.push('❌ .env file not found. Please create it based on .env.example');
                validation.isValid = false;
                return validation;
            }

            // 2. Load and validate environment variables
            require('dotenv').config();
            
            // 3. Validate required variables
            for (const varName of this.requiredEnvVars) {
                if (!process.env[varName]) {
                    validation.errors.push(`❌ Required environment variable missing: ${varName}`);
                    validation.isValid = false;
                } else {
                    validation.config[varName] = process.env[varName];
                }
            }

            // 4. Set defaults for optional variables and validate
            for (const [varName, defaultValue] of Object.entries(this.optionalEnvVars)) {
                const value = process.env[varName] || defaultValue;
                validation.config[varName] = value;
                
                if (!process.env[varName] && defaultValue) {
                    validation.info.push(`ℹ️ Using default value for ${varName}: ${defaultValue}`);
                }
            }

            // 5. Validate specific field formats and values
            await this.validateSpecificFields(validation);

            // 6. Validate wallet
            await this.validateWallet(validation);

            // 7. Validate RPC endpoints
            await this.validateRPCEndpoints(validation);

            // 8. Check for security issues
            this.validateSecurity(validation);

            // 9. Validate trading parameters
            this.validateTradingParameters(validation);

            // 10. Performance and safety checks
            this.validatePerformanceSettings(validation);

        } catch (error) {
            validation.errors.push(`❌ Configuration validation error: ${error.message}`);
            validation.isValid = false;
        }

        // Summary
        logger.info(`Configuration validation complete:`);
        logger.info(`- Errors: ${validation.errors.length}`);
        logger.info(`- Warnings: ${validation.warnings.length}`);
        logger.info(`- Info: ${validation.info.length}`);

        return validation;
    }

    /**
     * Validate specific fields according to rules
     */
    async validateSpecificFields(validation) {
        for (const [fieldName, rules] of Object.entries(this.validationRules)) {
            const value = validation.config[fieldName];
            
            if (!value) continue;

            try {
                switch (rules.type) {
                    case 'number':
                        const numValue = parseFloat(value);
                        if (isNaN(numValue)) {
                            validation.errors.push(`❌ ${fieldName} must be a valid number, got: ${value}`);
                        } else if (rules.min && numValue < rules.min) {
                            validation.errors.push(`❌ ${fieldName} must be >= ${rules.min}, got: ${numValue}`);
                        } else if (rules.max && numValue > rules.max) {
                            validation.errors.push(`❌ ${fieldName} must be <= ${rules.max}, got: ${numValue}`);
                        }
                        break;

                    case 'integer':
                        const intValue = parseInt(value);
                        if (isNaN(intValue) || !Number.isInteger(parseFloat(value))) {
                            validation.errors.push(`❌ ${fieldName} must be a valid integer, got: ${value}`);
                        } else if (rules.min && intValue < rules.min) {
                            validation.errors.push(`❌ ${fieldName} must be >= ${rules.min}, got: ${intValue}`);
                        } else if (rules.max && intValue > rules.max) {
                            validation.errors.push(`❌ ${fieldName} must be <= ${rules.max}, got: ${intValue}`);
                        }
                        break;

                    case 'boolean':
                        if (!['true', 'false'].includes(value.toLowerCase())) {
                            validation.errors.push(`❌ ${fieldName} must be 'true' or 'false', got: ${value}`);
                        }
                        break;

                    case 'enum':
                        if (!rules.values.includes(value)) {
                            validation.errors.push(`❌ ${fieldName} must be one of [${rules.values.join(', ')}], got: ${value}`);
                        }
                        break;
                }
            } catch (error) {
                validation.errors.push(`❌ Error validating ${fieldName}: ${error.message}`);
            }
        }
    }

    /**
     * Validate wallet configuration
     */
    async validateWallet(validation) {
        try {
            const privateKey = validation.config.SOLANA_WALLET_PRIVATE_KEY;
            
            if (!privateKey) {
                return; // Already caught in required fields
            }

            // Check private key format
            try {
                const decodedKey = bs58.decode(privateKey);
                if (decodedKey.length !== 64) {
                    validation.errors.push(`❌ Invalid private key length: expected 64 bytes, got ${decodedKey.length}`);
                    validation.isValid = false;
                    return;
                }

                // Test wallet creation
                const { Keypair } = require("@solana/web3.js");
                const wallet = Keypair.fromSecretKey(decodedKey);
                
                validation.info.push(`✅ Wallet validated: ${wallet.publicKey.toString()}`);
                
                // Security warning for mainnet
                if (validation.config.NETWORK === 'mainnet-beta') {
                    validation.warnings.push(`⚠️ Using mainnet - ensure this wallet is secure and has limited funds for testing`);
                }

            } catch (error) {
                validation.errors.push(`❌ Invalid private key format: ${error.message}`);
                validation.isValid = false;
            }

        } catch (error) {
            validation.errors.push(`❌ Wallet validation error: ${error.message}`);
        }
    }

    /**
     * Validate RPC endpoints
     */
    async validateRPCEndpoints(validation) {
        const primaryRpc = validation.config.DEFAULT_RPC;
        const altRpcs = validation.config.ALT_RPC_LIST ? validation.config.ALT_RPC_LIST.split(',') : [];
        
        // Validate primary RPC
        if (!this.isValidURL(primaryRpc)) {
            validation.errors.push(`❌ Invalid DEFAULT_RPC URL: ${primaryRpc}`);
            validation.isValid = false;
            return;
        }

        // Test primary RPC connection
        try {
            const connection = new Connection(primaryRpc, { commitment: 'confirmed' });
            const version = await connection.getVersion();
            validation.info.push(`✅ Primary RPC connected: ${primaryRpc} (Solana ${version['solana-core']})`);
        } catch (error) {
            validation.warnings.push(`⚠️ Could not connect to primary RPC ${primaryRpc}: ${error.message}`);
        }

        // Validate alternative RPCs
        for (const rpc of altRpcs) {
            const trimmedRpc = rpc.trim();
            if (!trimmedRpc) continue;
            
            if (!this.isValidURL(trimmedRpc)) {
                validation.warnings.push(`⚠️ Invalid ALT_RPC URL: ${trimmedRpc}`);
                continue;
            }

            try {
                const connection = new Connection(trimmedRpc, { commitment: 'confirmed' });
                const version = await connection.getVersion();
                validation.info.push(`✅ Alt RPC connected: ${trimmedRpc}`);
            } catch (error) {
                validation.warnings.push(`⚠️ Could not connect to alt RPC ${trimmedRpc}: ${error.message}`);
            }
        }
    }

    /**
     * Validate security settings
     */
    validateSecurity(validation) {
        // Check for common security issues
        
        // 1. Trading enabled in production
        if (validation.config.TRADING_ENABLED === 'true' && validation.config.NODE_ENV === 'production') {
            validation.warnings.push(`⚠️ Trading is ENABLED in production mode - ensure this is intentional`);
        }

        // 2. Large trade sizes
        const tradeSize = parseFloat(validation.config.TRADE_SIZE_SOL);
        if (tradeSize > 1.0) {
            validation.warnings.push(`⚠️ Large trade size detected: ${tradeSize} SOL - ensure you can afford potential losses`);
        }

        // 3. High slippage tolerance
        const slippage = parseFloat(validation.config.MAX_SLIPPAGE_PERCENT);
        if (slippage > 5.0) {
            validation.warnings.push(`⚠️ High slippage tolerance: ${slippage}% - this may result in significant losses`);
        }

        // 4. Debug mode in production
        if (validation.config.DEBUG === 'true' && validation.config.NODE_ENV === 'production') {
            validation.warnings.push(`⚠️ Debug mode enabled in production - may impact performance`);
        }

        // 5. Very low profit thresholds
        const profitThreshold = parseFloat(validation.config.MIN_PROFIT_THRESHOLD);
        if (profitThreshold < 0.1) {
            validation.warnings.push(`⚠️ Very low profit threshold: ${profitThreshold}% - may result in frequent unprofitable trades`);
        }
    }

    /**
     * Validate trading parameters
     */
    validateTradingParameters(validation) {
        const tradeSize = parseFloat(validation.config.TRADE_SIZE_SOL);
        const profitThreshold = parseFloat(validation.config.MIN_PROFIT_THRESHOLD);
        const slippage = parseFloat(validation.config.MAX_SLIPPAGE_PERCENT);

        // Check if profit threshold makes sense with slippage
        if (profitThreshold < slippage) {
            validation.warnings.push(`⚠️ Profit threshold (${profitThreshold}%) is lower than max slippage (${slippage}%) - trades may be unprofitable`);
        }

        // Check reasonable trade size for arbitrage
        if (tradeSize < 0.01) {
            validation.warnings.push(`⚠️ Very small trade size: ${tradeSize} SOL - may not cover transaction fees`);
        }

        // Check rotation interval vs update interval
        const updateInterval = parseInt(validation.config.UPDATE_INTERVAL);
        const rotationInterval = parseInt(validation.config.TOKEN_ROTATION_INTERVAL_MINUTES) * 60000;
        
        if (rotationInterval < updateInterval * 10) {
            validation.warnings.push(`⚠️ Token rotation too frequent compared to update interval - may not allow sufficient opportunity analysis`);
        }
    }

    /**
     * Validate performance settings
     */
    validatePerformanceSettings(validation) {
        const minInterval = parseInt(validation.config.MIN_INTERVAL_MS);
        const updateInterval = parseInt(validation.config.UPDATE_INTERVAL);

        // Check for too aggressive intervals
        if (minInterval < 1000) {
            validation.warnings.push(`⚠️ Very aggressive MIN_INTERVAL_MS: ${minInterval}ms - may hit rate limits frequently`);
        }

        if (updateInterval < 5000) {
            validation.warnings.push(`⚠️ Very aggressive UPDATE_INTERVAL: ${updateInterval}ms - may hit rate limits frequently`);
        }

        // Check retry settings
        const maxRetries = parseInt(validation.config.MAX_RETRY_ATTEMPTS);
        const retryDelay = parseInt(validation.config.RETRY_DELAY_MS);

        if (maxRetries > 5) {
            validation.warnings.push(`⚠️ High retry attempts: ${maxRetries} - may cause delays during network issues`);
        }

        if (retryDelay < 2000) {
            validation.warnings.push(`⚠️ Short retry delay: ${retryDelay}ms - may not be sufficient for rate limit recovery`);
        }
    }

    /**
     * Check if URL is valid
     */
    isValidURL(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    /**
     * Generate configuration report
     */
    generateReport(validation) {
        let report = '\n';
        report += chalk.bold.cyan('='.repeat(60)) + '\n';
        report += chalk.bold.cyan('           CONFIGURATION VALIDATION REPORT') + '\n';
        report += chalk.bold.cyan('='.repeat(60)) + '\n\n';

        // Summary
        if (validation.isValid) {
            report += chalk.green.bold('✅ CONFIGURATION VALID') + '\n\n';
        } else {
            report += chalk.red.bold('❌ CONFIGURATION INVALID') + '\n\n';
        }

        // Errors
        if (validation.errors.length > 0) {
            report += chalk.red.bold('🔴 ERRORS:\n');
            validation.errors.forEach(error => {
                report += chalk.red(`   ${error}\n`);
            });
            report += '\n';
        }

        // Warnings
        if (validation.warnings.length > 0) {
            report += chalk.yellow.bold('🟡 WARNINGS:\n');
            validation.warnings.forEach(warning => {
                report += chalk.yellow(`   ${warning}\n`);
            });
            report += '\n';
        }

        // Info
        if (validation.info.length > 0) {
            report += chalk.green.bold('🟢 INFO:\n');
            validation.info.forEach(info => {
                report += chalk.green(`   ${info}\n`);
            });
            report += '\n';
        }

        // Recommendations
        report += chalk.cyan.bold('💡 RECOMMENDATIONS:\n');
        if (!validation.isValid) {
            report += chalk.cyan('   - Fix all errors before starting the bot\n');
        }
        if (validation.warnings.length > 0) {
            report += chalk.cyan('   - Review and address warnings for optimal performance\n');
        }
        if (validation.config.TRADING_ENABLED === 'true') {
            report += chalk.cyan('   - Start with small trade sizes for testing\n');
            report += chalk.cyan('   - Monitor the bot closely during initial runs\n');
        } else {
            report += chalk.cyan('   - Bot is in simulation mode - safe for testing\n');
        }

        report += chalk.bold.cyan('\n' + '='.repeat(60)) + '\n';

        return report;
    }

    /**
     * Save validation report to file
     */
    saveValidationReport(validation) {
        try {
            const report = {
                timestamp: new Date().toISOString(),
                isValid: validation.isValid,
                errors: validation.errors,
                warnings: validation.warnings,
                info: validation.info,
                config: validation.config
            };

            if (!fs.existsSync('./temp')) {
                fs.mkdirSync('./temp', { recursive: true });
            }

            fs.writeFileSync('./temp/config_validation.json', JSON.stringify(report, null, 2));
            logger.info('Configuration validation report saved to ./temp/config_validation.json');
        } catch (error) {
            logger.warn(`Could not save validation report: ${error.message}`);
        }
    }
}

// Export singleton
const configValidator = new ConfigValidator();

module.exports = configValidator;