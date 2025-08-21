
console.clear();

require("dotenv").config();
const {clearInterval} = require("timers");
const {PublicKey} = require("@solana/web3.js");
const BN = require('bn.js');

const {
	calculateProfit,
	toDecimal,
	toNumber,
	updateIterationsPerMin,
	checkRoutesResponse,
	checkArbReady,
} = require("../utils");

// Import new systems
const logger = require("../utils/logger");
const transactionValidator = require("../utils/transactionValidator");
const healthMonitor = require("../utils/healthMonitor");
const memoryManager = require("../utils/memoryManager");
const marketAnalyzer = require("../utils/marketConditionAnalyzer");
const {rateLimiter} = require("../utils/rateLimiter");

const {handleExit,logExit} = require("./exit");
const cache = require("./cache");
const {setup, createTokenRotationFunction} = require("./setup");
const {printToConsole} = require("./ui/");
const {swap,failedSwapHandler,successSwapHandler} = require("./swap");
const chalk = require('chalk');

// Add this RIGHT AFTER the require statements - FIXED VERSION
process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 CAUGHT unhandledRejection:', reason);
    console.error('Promise:', promise);
    
    // Don't crash - just log and continue
    logger.error('Unhandled rejection caught and handled', {
        reason: reason?.message || reason,
        stack: reason?.stack
    });
    
    // Reset swap flag if it was set
    if (cache) {
        cache.swappingRightNow = false;
    }
});

// Force disable intro animation by setting environment variable
process.env.SKIP_INTRO = "true";

// Create token rotation function to avoid circular dependency
const rotateToNextToken = createTokenRotationFunction();

// Intermediate tokens for triangular arbitrage
const INTERMEDIATE_TOKENS = [
	{
		address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
		symbol: "USDC",
		decimals: 6
	},
	{
		address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
		symbol: "USDT", 
		decimals: 6
	},
	{
		address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH
		symbol: "ETH",
		decimals: 8
	}
];

// FIXED waitabit function - use regular setTimeout, not timers/promises
const waitabit = async (ms) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms); // Regular setTimeout, not the one from timers/promises
	});
};

function getRandomAmt(runtime) {
	const min = Math.ceil((runtime * 10000) * 0.99);
	const max = Math.floor((runtime * 10000) * 1.01);
	return ((Math.floor(Math.random() * (max - min + 1)) + min) / 10000);
}

const safeToNumber = (value) => {
	try {
		if(typeof value === 'number') return value;
		if(value && typeof value.toNumber === 'function') {
			return value.toNumber();
		}
		return new BN(value).toNumber();
	} catch(error) {
		logger.error('Error converting value to number:', error);
		return 0;
	}
};

// Function to watch for arbitrage opportunities
const watcher = async (jupiter, tokenA, tokenB) => {
	logger.info(`🔍 TRIANGULAR ARBITRAGE SCAN: ${tokenA.symbol} → [INTERMEDIATE] → ${tokenA.symbol}`);

	try {
		// Check for manual rotation request
		if(cache.manualRotation) {
			logger.info("Manual token rotation requested...");
			cache.manualRotation = false;

			const newTokenB = rotateToNextToken();
			if(newTokenB) {
				tokenB = newTokenB;
				logger.rotation(tokenA.symbol, tokenB.symbol, 'triangular_arbitrage');
				cache.iteration = 0;
			}
		}

		// Try triangular arbitrage with different intermediate tokens
		await triangularArbitrageStrategy(jupiter, tokenA, tokenB);
	} catch(error) {
		logger.error("Error in watcher:", error);
		healthMonitor.recordError();
	}
};

// CORRECTED triangularArbitrageStrategy function with proper delay handling
const triangularArbitrageStrategy = async (jupiter, tokenA, tokenB) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;

	logger.debug('Starting TRIANGULAR arbitrage strategy', {
		iteration: i,
		tokenPair: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`
	});

	try {
		// Calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Use the EXACT trade size from environment variables
		const envTradeSize = parseFloat(process.env.TRADE_SIZE_SOL) || 0.1;
		const amountToTrade = toNumber(envTradeSize, tokenA.decimals);
		
		logger.info(`🎯 TRIANGULAR ARBITRAGE: ${envTradeSize} SOL → ${tokenB.symbol} → SOL`);

		// Get minimum profit threshold from env
		const minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.25;
		const slippage = parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 300; // 3% default

		// STEP 1: SOL → Intermediate Token (tokenB) - WITH ENHANCED ERROR HANDLING
		logger.info(`📊 Step 1: ${tokenA.symbol} → ${tokenB.symbol}`);
		
		const { getQuote } = require("../utils/jupiterApiClient");
		let route1, route2, intermediateAmount, finalAmount;
		
		// Step 1 with comprehensive error handling
		try {
			logger.debug('Requesting Step 1 quote...');
			route1 = await Promise.race([
				getQuote(tokenA.address, tokenB.address, amountToTrade.toString(), slippage),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Step 1 timeout')), 15000))
			]);
			
			if (!route1 || !route1.outAmount) {
				throw new Error('Invalid route1 response - missing outAmount');
			}
			
			intermediateAmount = route1.outAmount;
			logger.info(`✅ Step 1 result: ${toDecimal(amountToTrade, tokenA.decimals)} ${tokenA.symbol} → ${toDecimal(intermediateAmount, tokenB.decimals)} ${tokenB.symbol}`);
			
		} catch (step1Error) {
			logger.error(`❌ Step 1 failed: ${step1Error.message}`);
			cache.queue[i] = 0;
			return; // Exit gracefully
		}

		// CORRECTED: Add delay with proper error handling using the fixed waitabit function
		try {
			logger.debug('Adding delay before Step 2...');
			await waitabit(3000); // Use the corrected waitabit function
			logger.debug('Delay completed, proceeding to Step 2...');
		} catch (delayError) {
			logger.error(`❌ Delay failed: ${delayError.message}`);
			cache.queue[i] = 0;
			return;
		}

		// STEP 2: Intermediate Token → SOL - WITH ENHANCED ERROR HANDLING
		logger.info(`📊 Step 2: ${tokenB.symbol} → ${tokenA.symbol}`);
		
		try {
			logger.debug('Requesting Step 2 quote...');
			route2 = await Promise.race([
				getQuote(tokenB.address, tokenA.address, intermediateAmount, slippage),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Step 2 timeout')), 15000))
			]);
			
			if (!route2 || !route2.outAmount) {
				throw new Error('Invalid route2 response - missing outAmount');
			}
			
			finalAmount = route2.outAmount;
			logger.info(`✅ Step 2 result: ${toDecimal(intermediateAmount, tokenB.decimals)} ${tokenB.symbol} → ${toDecimal(finalAmount, tokenA.decimals)} ${tokenA.symbol}`);
			
		} catch (step2Error) {
			logger.error(`❌ Step 2 failed: ${step2Error.message}`);
			cache.queue[i] = 0;
			return; // Exit gracefully
		}

		// Only proceed with calculations if both steps completed successfully
		if (!route1 || !route2 || !intermediateAmount || !finalAmount) {
			logger.error('❌ Incomplete route data - aborting arbitrage calculation');
			cache.queue[i] = 0;
			return;
		}

		// Calculate triangular arbitrage profit - WITH SAFE PARSING
		let inputAmount, outputAmount, profitAmount, simulatedProfit;
		
		try {
			inputAmount = BigInt(amountToTrade.toString());
			outputAmount = BigInt(finalAmount.toString());
			profitAmount = outputAmount - inputAmount;
			simulatedProfit = inputAmount > 0 ? 
				Number(profitAmount * BigInt(10000) / inputAmount) / 100 : -100;
		} catch (calculationError) {
			logger.error(`❌ Profit calculation failed: ${calculationError.message}`);
			cache.queue[i] = 0;
			return;
		}

		const minPercProfitRnd = getRandomAmt(minProfitThreshold);

		// Update performance tracking
		cache.availableRoutes["buy"] = 2; // Two-step route
		cache.queue[i] = 0;

		logger.info('═'.repeat(60));
		logger.info('🎯 TRIANGULAR ARBITRAGE ANALYSIS');
		logger.info('═'.repeat(60));
		logger.info(`🔄 Route: ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);
		logger.info(`💰 Input: ${toDecimal(inputAmount, tokenA.decimals)} ${tokenA.symbol}`);
		logger.info(`💰 Output: ${toDecimal(outputAmount, tokenA.decimals)} ${tokenA.symbol}`);
		logger.info(`📈 Profit: ${simulatedProfit > 0 ? '+' : ''}${simulatedProfit.toFixed(4)}%`);
		logger.info(`🎯 Target: ${minPercProfitRnd.toFixed(4)}%`);
		logger.info(`✅ Profitable: ${simulatedProfit >= minPercProfitRnd ? 'YES' : 'NO'}`);

		// Show detailed route breakdown
		logger.info(`\n🛣️ ARBITRAGE ROUTE BREAKDOWN:`);
		logger.info(`  1. ${tokenA.symbol} → ${tokenB.symbol}: ${toDecimal(amountToTrade, tokenA.decimals)} → ${toDecimal(intermediateAmount, tokenB.decimals)}`);
		logger.info(`  2. ${tokenB.symbol} → ${tokenA.symbol}: ${toDecimal(intermediateAmount, tokenB.decimals)} → ${toDecimal(finalAmount, tokenA.decimals)}`);
		
		// Calculate price impact for each step - WITH SAFE PARSING
		let priceImpact1 = 0, priceImpact2 = 0, totalPriceImpact = 0;
		try {
			priceImpact1 = parseFloat(route1.priceImpactPct || 0);
			priceImpact2 = parseFloat(route2.priceImpactPct || 0);
			totalPriceImpact = priceImpact1 + priceImpact2;
		} catch (impactError) {
			logger.warn(`Price impact calculation failed: ${impactError.message}`);
		}
		
		logger.info(`\n📊 PRICE IMPACT ANALYSIS:`);
		logger.info(`  Step 1 impact: ${priceImpact1.toFixed(4)}%`);
		logger.info(`  Step 2 impact: ${priceImpact2.toFixed(4)}%`);
		logger.info(`  Total impact: ${totalPriceImpact.toFixed(4)}%`);

		// Store max profit spotted
		if(simulatedProfit > (cache.maxProfitSpotted["buy"] || 0)) {
			cache.maxProfitSpotted["buy"] = simulatedProfit;
		}

		// Execute trade if profitable - WITH ENHANCED SAFETY CHECKS
		if(
			!cache.swappingRightNow &&
			(cache.hotkeys?.e ||
				cache.hotkeys?.r ||
				simulatedProfit >= minPercProfitRnd)
		) {
			// Hotkeys
			if(cache.hotkeys?.e) {
				logger.info("🔥 [E] PRESSED - FORCED EXECUTION!");
				cache.hotkeys.e = false;
			}
			if(cache.hotkeys?.r) {
				logger.info("↩️ [R] PRESSED - REVERT TRADE!");
			}

			if(cache.tradingEnabled || cache.hotkeys?.r) {
				cache.swappingRightNow = true;
				
				try {
					logger.info('🚀 EXECUTING TRIANGULAR ARBITRAGE TRADE');
					logger.info(`💰 Amount: ${envTradeSize} ${tokenA.symbol}`);
					logger.info(`📈 Expected Profit: ${simulatedProfit.toFixed(4)}%`);
					logger.info(`🔄 Route: ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);

					// Simulate the trade execution (safe simulation)
					const simulatedTx = {
						txid: `triangular_arb_${Date.now()}`,
						inputAmount: amountToTrade,
						outputAmount: finalAmount,
						success: true,
						simulatedProfit: simulatedProfit,
						route: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`
					};

					// Record transaction performance
					logger.performance('triangular_arbitrage_execution', 1000, {
						success: true,
						profit: simulatedProfit,
						route: `${tokenA.symbol}-${tokenB.symbol}-${tokenA.symbol}`,
						txid: simulatedTx.txid
					});

					// Store trade to the history - WITH SAFE OBJECT CREATION
					const tradeEntry = {
						date: date.toLocaleString(),
						buy: true,
						inputToken: tokenA.symbol,
						outputToken: tokenA.symbol,
						intermediateToken: tokenB.symbol,
						inAmount: toDecimal(amountToTrade, tokenA.decimals),
						expectedOutAmount: toDecimal(finalAmount, tokenA.decimals),
						expectedProfit: simulatedProfit,
						actualProfit: simulatedProfit, // In simulation
						slippage: slippage / 100,
						tradeType: 'TRIANGULAR_ARBITRAGE',
						route: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`,
						priceImpact: totalPriceImpact,
						txid: simulatedTx.txid
					};

					// Add to trade history safely
					if (!cache.tradeHistory) cache.tradeHistory = [];
					cache.tradeHistory.push(tradeEntry);

					// Update counters safely
					if (!cache.tradeCounter) {
						cache.tradeCounter = { buy: { success: 0, fail: 0 }, sell: { success: 0, fail: 0 } };
					}
					cache.tradeCounter.buy.success++;

					logger.info('✅ TRIANGULAR ARBITRAGE TRADE SIMULATED SUCCESSFULLY');
					logger.info(`📈 Profit Achieved: ${simulatedProfit.toFixed(4)}%`);
					logger.info(`💰 Profit Amount: ${toDecimal(profitAmount, tokenA.decimals)} ${tokenA.symbol}`);
					logger.info(`🆔 Transaction ID: ${simulatedTx.txid}`);

				} catch (tradeExecutionError) {
					logger.error(`❌ Trade execution failed: ${tradeExecutionError.message}`);
				}

			} else {
				logger.info('💡 SIMULATION MODE - Would execute profitable triangular arbitrage', {
					profit: simulatedProfit.toFixed(4) + '%',
					amount: envTradeSize + ' ' + tokenA.symbol,
					route: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`
				});
			}
		} else {
			if (cache.swappingRightNow) {
				logger.debug('⏳ Skipping - swap already in progress');
			} else {
				logger.debug('📉 Profit threshold not met', {
					simulatedProfit: simulatedProfit.toFixed(4) + '%',
					required: minPercProfitRnd.toFixed(4) + '%',
					difference: (simulatedProfit - minPercProfitRnd).toFixed(4) + '%',
					route: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`
				});
			}
		}

	} catch(error) {
		logger.error("CRITICAL: Error in triangular arbitrage strategy:", {
			message: error.message,
			stack: error.stack,
			iteration: i,
			tokenPair: `${tokenA.symbol} → ${tokenB.symbol}`
		});
		
		// Record error for monitoring
		if (healthMonitor && healthMonitor.recordError) {
			healthMonitor.recordError();
		}
		
		// Ensure we clean up properly
		cache.queue[i] = 0;
		
	} finally {
		// CRITICAL: Always clean up, regardless of what happened
		try {
			cache.swappingRightNow = false;
			
			if (cache.queue && cache.queue[i] !== undefined) {
				delete cache.queue[i];
			}
			
			// Clean up memory if needed
			if (cache.iteration && cache.iteration % 50 === 0) {
				if (memoryManager && memoryManager.performGarbageCollection) {
					memoryManager.performGarbageCollection();
				}
			}
		} catch (cleanupError) {
			logger.error('Cleanup error (non-critical):', cleanupError.message);
		}
	}
};

const run = async () => {
	try {
		logger.info("🚀 Starting Jupiter TRIANGULAR Arbitrage Bot...");

		// Log trading configuration from environment
		const envConfig = {
			tradingEnabled: process.env.TRADING_ENABLED === 'true',
			tradeSize: parseFloat(process.env.TRADE_SIZE_SOL) || 0.1,
			minProfit: parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.25,
			maxSlippage: parseFloat(process.env.MAX_SLIPPAGE_PERCENT) || 3.0,
			updateInterval: parseInt(process.env.MIN_INTERVAL_MS) || 10000
		};

		logger.info("📊 TRIANGULAR ARBITRAGE CONFIGURATION:", envConfig);

		// Are they ARB ready and part of the community?
		await checkArbReady();

		// Set everything up
		logger.info("Setting up Jupiter client and wallet...");
		let result = await setup();
		let {jupiter, tokenA, tokenB, wallet} = result;

		logger.info("🎯 TRIANGULAR ARBITRAGE MODE ACTIVATED");
		logger.info(`Base Token: ${tokenA.symbol} (${tokenA.address})`);
		logger.info(`Current Intermediate: ${tokenB.symbol} (${tokenB.address})`);
		logger.info(`Strategy: ${tokenA.symbol} → [INTERMEDIATE] → ${tokenA.symbol} arbitrage`);

		// Set pubkey display
		const walpubkeyfull = wallet.publicKey.toString();
		logger.info("Wallet:", walpubkeyfull);
		cache.walletpubkeyfull = walpubkeyfull;
		cache.walletpubkey = walpubkeyfull.slice(0, 5) + '...' + walpubkeyfull.slice(walpubkeyfull.length - 3);

		// Configure balance for arbitrage strategy using EXACT env values
		cache.initialBalance.tokenA = toNumber(envConfig.tradeSize, tokenA.decimals);
		cache.currentBalance.tokenA = cache.initialBalance.tokenA;
		cache.lastBalance.tokenA = cache.initialBalance.tokenA;

		logger.info(`💰 Trade Size Set: ${envConfig.tradeSize} ${tokenA.symbol}`);
		logger.info(`🎯 Min Profit: ${envConfig.minProfit}%`);
		logger.info(`⚙️ Max Slippage: ${envConfig.maxSlippage}%`);

		// Check wallet balance
		logger.info("Checking wallet balance...");
		const { checkTokenABalance } = require("./setup");
		const realBalanceTokenA = await checkTokenABalance(tokenA, cache.initialBalance.tokenA);

		if(realBalanceTokenA < cache.initialBalance.tokenA && realBalanceTokenA > 0) {
			logger.warn('⚠️ Insufficient balance for desired trade size', {
				available: toDecimal(realBalanceTokenA, tokenA.decimals),
				required: toDecimal(cache.initialBalance.tokenA, tokenA.decimals),
				token: tokenA.symbol
			});
			
			// Adjust trade size to available balance
			const maxSafeTradeSize = Math.floor(realBalanceTokenA * 0.9); // Use 90% of available
			cache.initialBalance.tokenA = maxSafeTradeSize;
			cache.currentBalance.tokenA = maxSafeTradeSize;
			
			logger.warn(`🔧 Adjusted trade size to: ${toDecimal(maxSafeTradeSize, tokenA.decimals)} ${tokenA.symbol}`);
		} else if (realBalanceTokenA === 0) {
			logger.warn('❌ Zero balance detected - forcing simulation mode');
			cache.tradingEnabled = false;
		} else {
			logger.info("✅ Wallet balance sufficient", {
				available: toDecimal(realBalanceTokenA, tokenA.decimals) + " " + tokenA.symbol
			});
		}

		// Set up token rotation for intermediate tokens
		const rotateIntermediateToken = async () => {
			const currentIndex = INTERMEDIATE_TOKENS.findIndex(token => token.address === tokenB.address);
			const nextIndex = (currentIndex + 1) % INTERMEDIATE_TOKENS.length;
			tokenB = INTERMEDIATE_TOKENS[nextIndex];
			
			logger.rotation(tokenA.symbol, tokenB.symbol, 'intermediate_rotation');
			logger.info(`🔄 Rotated to intermediate token: ${tokenB.symbol}`);
		};

		// Schedule intermediate token rotation every 5 minutes
		global.tokenRotationInterval = setInterval(rotateIntermediateToken, 5 * 60 * 1000);

		logger.info("🚀 Starting TRIANGULAR arbitrage monitor...");
		logger.info(`⏱️ Update interval: ${envConfig.updateInterval}ms`);
		logger.info(`🎯 Target profit: ${envConfig.minProfit}%+`);
		logger.info(`⚙️ Trading: ${envConfig.tradingEnabled ? 'ENABLED' : 'SIMULATION'}`);
		logger.info(`🔄 Intermediate tokens: ${INTERMEDIATE_TOKENS.map(t => t.symbol).join(', ')}`);

		logger.info("💻 TRIANGULAR ARBITRAGE ACTIVE - PRESS [CTRL+C] TO EXIT");

		// Start the watcher with TRIANGULAR arbitrage
		global.botInterval = setInterval(
			() => watcher(jupiter, tokenA, tokenB),
			envConfig.updateInterval
		);

	} catch(error) {
		logger.error("Error during bot initialization:", error);
		logExit(1, error);
		process.exitCode = 1;
		process.exit(1);
	}
};

// Exit handler
process.on("exit", () => {
	if(global.botInterval) {
		clearInterval(global.botInterval);
	}
	if(global.tokenRotationInterval) {
		clearInterval(global.tokenRotationInterval);
	}
	
	// Stop all monitoring systems
	try {
		healthMonitor.stopMonitoring();
		memoryManager.stop();
		logger.info("All systems stopped gracefully");
	} catch (error) {
		console.error("Error stopping systems:", error);
	}
	
	handleExit();
});

// Start the bot
run();