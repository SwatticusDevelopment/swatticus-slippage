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
const dynamicTradeSizer = require("../utils/dynamicTradeSizer");
const mevProtector = require("../utils/mevProtector");
const priceFeedService = require("../utils/priceFeedService");

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
	},
	{
		address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
		symbol: "JUP",
		decimals: 6
	}
];

// FIXED waitabit function - use regular setTimeout, not timers/promises
const waitabit = async (ms) => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
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

// Function to watch for arbitrage opportunities with DYNAMIC SIZING
const watcher = async (jupiter, tokenA, tokenB) => {
	// Get real-time SOL price
	const solPriceUSD = await priceFeedService.getCurrentSOLPrice();
	const priceSummary = priceFeedService.getPriceSummary();
	
	logger.info(`🔍 DYNAMIC TRIANGULAR ARBITRAGE SCAN: ${tokenA.symbol} → [INTERMEDIATE] → ${tokenA.symbol}`);
	logger.debug(`💰 Current SOL Price: ${priceSummary.price} ${priceSummary.trend} ${priceSummary.freshness}`);

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

		// Try triangular arbitrage with DYNAMIC trade sizing
		await dynamicTriangularArbitrageStrategy(jupiter, tokenA, tokenB, solPriceUSD);
	} catch(error) {
		logger.error("Error in watcher:", error);
		healthMonitor.recordError();
	}
};

// ENHANCED triangularArbitrageStrategy function with REAL SOL PRICE
const dynamicTriangularArbitrageStrategy = async (jupiter, tokenA, tokenB, solPriceUSD) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;

	logger.debug('Starting DYNAMIC TRIANGULAR arbitrage strategy', {
		iteration: i,
		tokenPair: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`,
		tradingMode: cache.tradingEnabled ? 'LIVE' : 'SIMULATION',
		solPrice: `$${solPriceUSD}`
	});

	try {
		// Calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Get max trade size and calculate USD value
		const maxTradeSizeSOL = parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1;
		const maxTradeSizeUSD = maxTradeSizeSOL * solPriceUSD;

		logger.info(`💰 DYNAMIC TRIANGULAR ARBITRAGE: ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);
		logger.info(`📊 Max Trade Size: ${maxTradeSizeSOL} SOL | SOL Price: $${solPriceUSD} | Max Value: $${maxTradeSizeUSD.toFixed(2)}`);
		logger.info(`🔥 Trading Mode: ${cache.tradingEnabled ? '🔥 LIVE TRADING' : '💡 SIMULATION'}`);

		// STEP 1: Find optimal trade size using dynamic sizer with REAL SOL PRICE
		logger.info(`🎯 FINDING OPTIMAL TRADE SIZE...`);
		const optimalResult = await dynamicTradeSizer.findOptimalTradeSize(tokenA, tokenB, solPriceUSD);

		if (!optimalResult) {
			logger.warn(`❌ No profitable trade size found for ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);
			logger.debug(`💡 This could be due to:`);
			logger.debug(`   - All sizes below minimum profit threshold (${process.env.MIN_PROFIT_THRESHOLD}% OR $${process.env.MIN_PROFIT_USD})`);
			logger.debug(`   - High price impact on tested sizes (>${process.env.MAX_PRICE_IMPACT_PERCENT}%)`);
			logger.debug(`   - Insufficient liquidity for profitable arbitrage`);
			logger.debug(`   - Current SOL price: $${solPriceUSD} may make small trades unprofitable`);
			cache.queue[i] = 0;
			return;
		}

		// Extract optimal trade parameters
		const {
			sizeSOL: optimalSizeSOL,
			sizeRaw: optimalSizeRaw,
			profitPercent,
			profitUSD,
			totalValue,
			totalPriceImpact,
			route1,
			route2
		} = optimalResult;

		// Update performance tracking
		cache.availableRoutes["buy"] = 2; // Two-step route
		cache.queue[i] = 0;

		logger.info('═'.repeat(80));
		logger.info('🎯 DYNAMIC TRIANGULAR ARBITRAGE ANALYSIS');
		logger.info('═'.repeat(80));
		logger.info(`🔄 Route: ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);
		logger.info(`⚡ OPTIMAL SIZE: ${optimalSizeSOL} SOL ($${totalValue.toFixed(2)} USD)`);
		logger.info(`💰 Expected Profit: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(4)}% ($${profitUSD.toFixed(2)} USD)`);
		logger.info(`📊 Price Impact: ${totalPriceImpact.toFixed(4)}%`);
		logger.info(`💵 SOL Price: $${solPriceUSD} ${priceFeedService.getPriceSummary().trend}`);
		logger.info(`🎯 Profitable: YES ✅`);
		logger.info(`🔥 Trading Mode: ${cache.tradingEnabled ? 'LIVE' : 'SIMULATION'}`);

		// Verify profit meets USD threshold
		const minProfitUSD = parseFloat(process.env.MIN_PROFIT_USD) || 0.50;
		if (profitUSD < minProfitUSD) {
			logger.warn(`⚠️ Profit $${profitUSD.toFixed(2)} below minimum $${minProfitUSD} - skipping trade`);
			logger.debug(`💡 Try lowering MIN_PROFIT_USD or increasing MAX_TRADE_SIZE_SOL`);
			cache.queue[i] = 0;
			return;
		}

		// Store max profit spotted
		if(profitPercent > (cache.maxProfitSpotted["buy"] || 0)) {
			cache.maxProfitSpotted["buy"] = profitPercent;
		}

		// STEP 2: Execute trade if profitable and conditions are met
		if(
			!cache.swappingRightNow &&
			(cache.hotkeys?.e ||
				cache.hotkeys?.r ||
				profitPercent > 0) // Since we already found it profitable, execute
		) {
			// Hotkeys
			if(cache.hotkeys?.e) {
				logger.info("🔥 [E] PRESSED - FORCED EXECUTION!");
				cache.hotkeys.e = false;
			}
			if(cache.hotkeys?.r) {
				logger.info("↩️ [R] PRESSED - REVERT TRADE!");
				cache.hotkeys.r = false;
			}

			cache.swappingRightNow = true;
			
			try {
				logger.info('🚀 EXECUTING DYNAMIC TRIANGULAR ARBITRAGE TRADE');
				logger.info(`💰 Optimal Amount: ${optimalSizeSOL} SOL ($${totalValue.toFixed(2)} USD)`);
				logger.info(`📈 Expected Profit: ${profitPercent.toFixed(4)}% ($${profitUSD.toFixed(2)} USD)`);
				logger.info(`🔄 Route: ${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`);
				logger.info(`💡 Mode: ${cache.tradingEnabled ? '🔥 REAL TRADING' : '💡 SIMULATION'}`);

				let txResult1, txResult2;
				let actualProfit = profitPercent; // Default to expected
				let actualProfitUSD = profitUSD;
				let finalTxid = null;

				if (cache.tradingEnabled) {
					// REAL TRADE EXECUTION with MEV PROTECTION
					logger.info('🔥 EXECUTING REAL TRADES ON SOLANA BLOCKCHAIN');
					
					// Apply MEV protection
					const protectionParams = await mevProtector.applyMEVProtection({
						priority: parseInt(process.env.PRIORITY) || 150000,
						slippage: parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 100
					}, optimalSizeSOL, profitPercent);
					
					try {
						// Execute Step 1: SOL → Intermediate Token
						logger.info(`🔄 STEP 1: Swapping ${optimalSizeSOL} ${tokenA.symbol} → ${tokenB.symbol}`);
						
						const step1Route = {
							inAmount: optimalSizeRaw.toString(),
							outAmount: route1.outAmount,
							_fullQuote: route1
						};
						
						const exchange1 = await jupiter.exchange({ routeInfo: step1Route });
						txResult1 = await mevProtector.executeProtectedTransaction(
							await exchange1.execute(),
							protectionParams
						);
						
						if (!txResult1.success) {
							throw new Error(`Step 1 trade failed: ${txResult1.error || 'Unknown error'}`);
						}
						
						logger.info(`✅ STEP 1 COMPLETED! TXID: ${txResult1.txid}`);
						logger.info(`💰 Received: ${toDecimal(txResult1.outputAmount || route1.outAmount, tokenB.decimals)} ${tokenB.symbol}`);
						
						// Wait between swaps to ensure first transaction is confirmed
						logger.info('⏳ Waiting for transaction confirmation...');
						await waitabit(3000);
						
						// Execute Step 2: Intermediate Token → SOL
						logger.info(`🔄 STEP 2: Swapping ${tokenB.symbol} → ${tokenA.symbol}`);
						
						const actualIntermediateAmount = txResult1.outputAmount || route1.outAmount;
						const step2Route = {
							inAmount: actualIntermediateAmount,
							outAmount: route2.outAmount,
							_fullQuote: route2
						};
						
						const exchange2 = await jupiter.exchange({ routeInfo: step2Route });
						txResult2 = await mevProtector.executeProtectedTransaction(
							await exchange2.execute(),
							protectionParams
						);
						
						if (!txResult2.success) {
							throw new Error(`Step 2 trade failed: ${txResult2.error || 'Unknown error'}`);
						}
						
						logger.info(`✅ STEP 2 COMPLETED! TXID: ${txResult2.txid}`);
						logger.info(`💰 Final Amount: ${toDecimal(txResult2.outputAmount || route2.outAmount, tokenA.decimals)} ${tokenA.symbol}`);
						
						// Calculate actual profit based on real execution results with CURRENT SOL PRICE
						const currentSolPrice = await priceFeedService.getCurrentSOLPrice(); // Get fresh price
						const actualInputAmount = BigInt(optimalSizeRaw.toString());
						const actualOutputAmount = BigInt(txResult2.outputAmount || route2.outAmount);
						const actualProfitAmount = actualOutputAmount - actualInputAmount;
						actualProfit = Number(actualProfitAmount * BigInt(10000) / actualInputAmount) / 100;
						
						// Calculate actual USD profit with current price
						const actualProfitSOL = Number(actualProfitAmount) / Math.pow(10, tokenA.decimals);
						actualProfitUSD = actualProfitSOL * currentSolPrice;
						
						finalTxid = txResult2.txid;
						
						// Monitor for MEV attacks
						const mevData = await mevProtector.monitorMEVAttack(finalTxid, profitPercent, optimalSizeSOL);
						
						logger.info('🎉 DYNAMIC TRIANGULAR ARBITRAGE COMPLETED SUCCESSFULLY!');
						logger.info(`💰 ACTUAL PROFIT: ${actualProfit > 0 ? '+' : ''}${actualProfit.toFixed(4)}%`);
						logger.info(`💵 ACTUAL PROFIT USD: $${actualProfitUSD.toFixed(2)} (at SOL price $${currentSolPrice})`);
						logger.info(`💵 PROFIT AMOUNT: ${toDecimal(actualProfitAmount, tokenA.decimals)} ${tokenA.symbol}`);
						
						// Update dynamic trade sizer with actual results
						dynamicTradeSizer.updateActualPerformance(
							`${tokenA.symbol}-${tokenB.symbol}`,
							optimalSizeSOL,
							actualProfit,
							actualProfit > 0
						);
						
					} catch (realTradeError) {
						logger.error(`❌ Real trade execution failed: ${realTradeError.message}`);
						
						// Update sizer with failure
						dynamicTradeSizer.updateActualPerformance(
							`${tokenA.symbol}-${tokenB.symbol}`,
							optimalSizeSOL,
							-100, // Mark as complete loss
							false
						);
						
						// Still record the attempt but mark as failed
						actualProfit = -100; // Mark as complete loss
						actualProfitUSD = -totalValue; // Mark as loss of full trade value
						finalTxid = `failed_${Date.now()}`;
						
						// Update failure counter
						if (!cache.tradeCounter.buy) cache.tradeCounter.buy = { success: 0, fail: 0 };
						cache.tradeCounter.buy.fail++;
						
						throw realTradeError;
					}
				} else {
					// SIMULATION MODE
					logger.info('💡 SIMULATION MODE - Trade execution simulated');
					finalTxid = `simulation_${Date.now()}`;
					
					// In simulation, use expected profit with current SOL price
					actualProfit = profitPercent;
					actualProfitUSD = profitUSD;
				}

				// Record transaction performance
				logger.performance('dynamic_triangular_arbitrage', 6000, {
					success: actualProfit > 0,
					profit: actualProfit,
					profitUSD: actualProfitUSD,
					optimalSize: optimalSizeSOL,
					solPrice: solPriceUSD,
					route: `${tokenA.symbol}-${tokenB.symbol}-${tokenA.symbol}`,
					txid: finalTxid,
					mode: cache.tradingEnabled ? 'live' : 'simulation',
					mevProtected: mevProtector.enabled
				});

				// Store trade to the history - WITH ENHANCED DETAILS
				const tradeEntry = {
					date: date.toLocaleString(),
					buy: true,
					inputToken: tokenA.symbol,
					outputToken: tokenA.symbol,
					intermediateToken: tokenB.symbol,
					inAmount: optimalSizeSOL,
					inAmountUSD: totalValue,
					solPriceAtTrade: solPriceUSD,
					expectedOutAmount: toDecimal(route2.outAmount, tokenA.decimals),
					actualOutAmount: txResult2 ? toDecimal(txResult2.outputAmount, tokenA.decimals) : toDecimal(route2.outAmount, tokenA.decimals),
					expectedProfit: profitPercent,
					expectedProfitUSD: profitUSD,
					actualProfit: actualProfit,
					actualProfitUSD: actualProfitUSD,
					slippage: (parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 100) / 100,
					priceImpact: totalPriceImpact,
					tradeType: 'DYNAMIC_TRIANGULAR_ARBITRAGE',
					tradingStrategy: 'OPTIMAL_SIZING',
					route: `${tokenA.symbol} → ${tokenB.symbol} → ${tokenA.symbol}`,
					txid: finalTxid,
					step1Txid: txResult1?.txid || null,
					step2Txid: txResult2?.txid || null,
					mode: cache.tradingEnabled ? 'LIVE' : 'SIMULATION',
					success: actualProfit > 0,
					mevProtected: mevProtector.enabled,
					optimalSize: optimalSizeSOL,
					sizeOptimization: 'DYNAMIC',
					profitabilityScore: (actualProfitUSD / totalValue) * 100, // ROI as percentage
					tradeSizeRank: optimalSizeSOL / parseFloat(process.env.MAX_TRADE_SIZE_SOL) * 100 // Size utilization %
				};

				// Add to trade history safely
				if (!cache.tradeHistory) cache.tradeHistory = [];
				cache.tradeHistory.push(tradeEntry);

				// Update counters safely
				if (!cache.tradeCounter.buy) cache.tradeCounter.buy = { success: 0, fail: 0 };
				
				if (actualProfit > 0) {
					cache.tradeCounter.buy.success++;
					logger.info(`✅ SUCCESSFUL DYNAMIC ARBITRAGE TRADE #${cache.tradeCounter.buy.success}`);
				} else {
					cache.tradeCounter.buy.fail++;
					logger.error(`❌ FAILED DYNAMIC ARBITRAGE TRADE #${cache.tradeCounter.buy.fail}`);
				}

				// Update balance tracking for arbitrage
				if (cache.tradingEnabled && actualProfit > 0) {
					const profitAmount = (actualProfit / 100) * optimalSizeSOL;
					const newBalance = cache.currentBalance.tokenA + toNumber(profitAmount, tokenA.decimals);
					cache.lastBalance.tokenA = cache.currentBalance.tokenA;
					cache.currentBalance.tokenA = newBalance;
					
					// Update cumulative profit
					cache.currentProfit.tokenA = calculateProfit(
						String(cache.initialBalance.tokenA),
						String(cache.currentBalance.tokenA)
					);
					
					logger.info(`💰 UPDATED BALANCE: ${toDecimal(cache.currentBalance.tokenA, tokenA.decimals)} ${tokenA.symbol}`);
					logger.info(`📈 CUMULATIVE PROFIT: ${cache.currentProfit.tokenA.toFixed(4)}%`);
				}

				// Calculate profitability metrics
				const roi = (actualProfitUSD / totalValue) * 100;
				const profitPerHour = actualProfitUSD * (3600000 / (parseInt(process.env.UPDATE_INTERVAL) || 8000));
				const sizeEfficiency = (optimalSizeSOL / parseFloat(process.env.MAX_TRADE_SIZE_SOL)) * 100;

				logger.info('═'.repeat(80));
				logger.info(`📊 DYNAMIC TRADE SUMMARY:`);
				logger.info(`🎯 Success: ${actualProfit > 0 ? 'YES ✅' : 'NO ❌'}`);
				logger.info(`⚡ Optimal Size: ${optimalSizeSOL} SOL (${sizeEfficiency.toFixed(1)}% of max)`);
				logger.info(`📈 Profit: ${actualProfit.toFixed(4)}% | ${actualProfitUSD.toFixed(2)} USD`);
				logger.info(`💎 ROI: ${roi.toFixed(2)}% | Est. $/hour: ${profitPerHour.toFixed(2)}`);
				logger.info(`💰 SOL Price: ${solPriceUSD} ${priceFeedService.getPriceSummary().trend}`);
				logger.info(`🛡️ MEV Protected: ${mevProtector.enabled ? 'YES' : 'NO'}`);
				logger.info(`🆔 TX ID: ${finalTxid}`);
				logger.info(`📊 Total: ✅ ${cache.tradeCounter.buy.success} | ❌ ${cache.tradeCounter.buy.fail} | Success Rate: ${cache.tradeCounter.buy.success + cache.tradeCounter.buy.fail > 0 ? ((cache.tradeCounter.buy.success / (cache.tradeCounter.buy.success + cache.tradeCounter.buy.fail)) * 100).toFixed(1) : 0}%`);
				logger.info('═'.repeat(80));

			} catch (tradeExecutionError) {
				logger.error(`❌ Trade execution failed: ${tradeExecutionError.message}`);
				
				// Record failed trade
				if (!cache.tradeCounter.buy) cache.tradeCounter.buy = { success: 0, fail: 0 };
				cache.tradeCounter.buy.fail++;
				
			} finally {
				// Always reset swap flag
				cache.swappingRightNow = false;
			}

		} else {
			if (cache.swappingRightNow) {
				logger.debug('⏳ Skipping - swap already in progress');
			} else {
				// This shouldn't happen since we already found it profitable, but just in case
				logger.debug('📉 Unexpected: profitable opportunity not executed', {
					profitPercent: profitPercent.toFixed(4),
					profitUSD: profitUSD.toFixed(2),
					tradingEnabled: cache.tradingEnabled
				});
			}
		}

	} catch(error) {
		logger.error("CRITICAL: Error in dynamic triangular arbitrage strategy:", {
			message: error.message,
			stack: error.stack,
			iteration: i,
			tokenPair: `${tokenA.symbol} → ${tokenB.symbol}`,
			solPrice: `${solPriceUSD}`
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
			
			// Clean up old performance data periodically
			if (cache.iteration % 100 === 0) {
				dynamicTradeSizer.cleanupOldData();
				mevProtector.cleanupOldData();
			}
			
		} catch (cleanupError) {
			logger.error('Cleanup error (non-critical):', cleanupError.message);
		}
	}
};

const run = async () => {
	try {
		logger.info("🚀 Starting Jupiter DYNAMIC TRIANGULAR Arbitrage Bot...");

		// Initialize price feed service first
		logger.info("💰 Initializing real-time SOL price feed...");
		const initialPrice = await priceFeedService.forceRefreshPrice();
		const priceSummary = priceFeedService.getPriceSummary();
		logger.info(`💎 SOL Price initialized: ${priceSummary.price} ${priceSummary.trend} | Sources: ${priceSummary.sources.join(', ')}`);

		// Log trading configuration from environment
		const envConfig = {
			tradingEnabled: process.env.TRADING_ENABLED === 'true',
			maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1,
			minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE_SOL) || 0.005,
			tradeSizeStrategy: process.env.TRADE_SIZE_STRATEGY || 'optimal',
			testCount: parseInt(process.env.TRADE_SIZE_TESTS) || 5,
			minProfit: parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.3,
			minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.50,
			maxSlippage: parseFloat(process.env.MAX_SLIPPAGE_PERCENT) || 1.0,
			updateInterval: parseInt(process.env.UPDATE_INTERVAL) || 8000,
			mevProtection: process.env.ENABLE_MEV_PROTECTION === 'true'
		};

		// Calculate USD values with real SOL price
		const maxTradeValueUSD = envConfig.maxTradeSize * initialPrice;
		const minTradeValueUSD = envConfig.minTradeSize * initialPrice;

		logger.info("📊 DYNAMIC TRIANGULAR ARBITRAGE CONFIGURATION:");
		logger.info(`💰 Max Trade Size: ${envConfig.maxTradeSize} SOL (${maxTradeValueUSD.toFixed(2)} USD)`);
		logger.info(`💰 Min Trade Size: ${envConfig.minTradeSize} SOL (${minTradeValueUSD.toFixed(2)} USD)`);
		logger.info(`📈 Min Profit: ${envConfig.minProfit}% OR ${envConfig.minProfitUSD}`);
		logger.info(`⚙️ Strategy: ${envConfig.tradeSizeStrategy.toUpperCase()} (${envConfig.testCount} size tests)`);
		logger.info(`⚠️ Max Slippage: ${envConfig.maxSlippage}%`);
		logger.info(`🛡️ MEV Protection: ${envConfig.mevProtection ? 'ENABLED' : 'DISABLED'}`);
		logger.info(`💎 SOL Price: ${initialPrice} (Auto-updating every 30s)`);

		// CRITICAL TRADING MODE ANNOUNCEMENT
		if (envConfig.tradingEnabled) {
			logger.info('🔥'.repeat(50));
			logger.info('🔥 REAL TRADING MODE ENABLED - USING REAL MONEY! 🔥');
			logger.info('🔥 DYNAMIC SIZING ENABLED - OPTIMIZING TRADES! 🔥');
			logger.info('🔥 REAL-TIME PRICE FEED ACTIVE! 🔥');
			logger.info('🔥'.repeat(50));
			logger.info(`💰 Trade Range: ${minTradeValueUSD.toFixed(2)} - ${maxTradeValueUSD.toFixed(2)} USD`);
			logger.info(`📈 Profit Target: Minimum ${envConfig.minProfitUSD} per trade`);
			logger.info(`💎 SOL Price Tracking: LIVE (${priceSummary.sources.length} sources)`);
			logger.info('🔥'.repeat(50));
		} else {
			logger.info('💡 SIMULATION MODE - No real trades will be executed');
			logger.info(`📊 Testing dynamic sizing with real SOL price (${initialPrice})`);
		}

		// Are they ARB ready and part of the community?
		await checkArbReady();

		// Set everything up
		logger.info("Setting up Jupiter client and wallet...");
		let result = await setup();
		let {jupiter, tokenA, tokenB, wallet} = result;

		logger.info("🎯 DYNAMIC TRIANGULAR ARBITRAGE MODE ACTIVATED");
		logger.info(`Base Token: ${tokenA.symbol} (${tokenA.address})`);
		logger.info(`Current Intermediate: ${tokenB.symbol} (${tokenB.address})`);
		logger.info(`Strategy: DYNAMIC ${tokenA.symbol} → [INTERMEDIATE] → ${tokenA.symbol} arbitrage`);
		logger.info(`Trading Mode: ${cache.tradingEnabled ? '🔥 LIVE TRADING' : '💡 SIMULATION'}`);
		logger.info(`Sizing Strategy: ${envConfig.tradeSizeStrategy.toUpperCase()}`);
		logger.info(`Price Feed: LIVE (${initialPrice})`);

		// Set pubkey display
		const walpubkeyfull = wallet.publicKey.toString();
		logger.info("Wallet:", walpubkeyfull);
		cache.walletpubkeyfull = walpubkeyfull;
		cache.walletpubkey = walpubkeyfull.slice(0, 5) + '...' + walpubkeyfull.slice(walpubkeyfull.length - 3);

		// Configure balance for arbitrage strategy using MAXIMUM env values
		cache.initialBalance.tokenA = toNumber(envConfig.maxTradeSize, tokenA.decimals);
		cache.currentBalance.tokenA = cache.initialBalance.tokenA;
		cache.lastBalance.tokenA = cache.initialBalance.tokenA;

		logger.info(`💰 Max Trade Size Set: ${envConfig.maxTradeSize} ${tokenA.symbol} (${maxTradeValueUSD.toFixed(2)} USD)`);
		logger.info(`💰 Min Trade Size Set: ${envConfig.minTradeSize} ${tokenA.symbol} (${minTradeValueUSD.toFixed(2)} USD)`);
		logger.info(`🎯 Min Profit: ${envConfig.minProfit}% OR ${envConfig.minProfitUSD}`);
		logger.info(`⚙️ Max Slippage: ${envConfig.maxSlippage}%`);

		// Check wallet balance
		logger.info("Checking wallet balance...");
		const { checkTokenABalance } = require("./setup");
		const realBalanceTokenA = await checkTokenABalance(tokenA, cache.initialBalance.tokenA);

		if(realBalanceTokenA < cache.initialBalance.tokenA && realBalanceTokenA > 0) {
			logger.warn('⚠️ Insufficient balance for maximum desired trade size', {
				available: toDecimal(realBalanceTokenA, tokenA.decimals),
				maxDesired: toDecimal(cache.initialBalance.tokenA, tokenA.decimals),
				token: tokenA.symbol
			});
			
			// Adjust maximum trade size to available balance
			const maxSafeTradeSize = Math.floor(realBalanceTokenA * 0.9); // Use 90% of available
			const maxSafeSOL = toDecimal(maxSafeTradeSize, tokenA.decimals);
			const maxSafeUSD = maxSafeSOL * initialPrice;
			
			// Update environment variable for dynamic sizer
			process.env.MAX_TRADE_SIZE_SOL = maxSafeSOL.toString();
			
			logger.warn(`🔧 Adjusted MAX trade size to: ${maxSafeSOL} ${tokenA.symbol} (${maxSafeUSD.toFixed(2)} USD)`);
			logger.info(`🎯 Dynamic sizer will now find optimal sizes up to ${maxSafeSOL} SOL`);
			
		} else if (realBalanceTokenA === 0) {
			logger.warn('❌ Zero balance detected - forcing simulation mode');
			cache.tradingEnabled = false;
		} else {
			const availableUSD = toDecimal(realBalanceTokenA, tokenA.decimals) * initialPrice;
			logger.info("✅ Wallet balance sufficient for dynamic trading", {
				available: `${toDecimal(realBalanceTokenA, tokenA.decimals)} ${tokenA.symbol} (${availableUSD.toFixed(2)} USD)`,
				maxTradeSize: `${envConfig.maxTradeSize} SOL (${maxTradeValueUSD.toFixed(2)} USD)`
			});
		}

		// Set up token rotation for intermediate tokens
		const rotateIntermediateToken = async () => {
			const currentIndex = INTERMEDIATE_TOKENS.findIndex(token => token.address === tokenB.address);
			const nextIndex = (currentIndex + 1) % INTERMEDIATE_TOKENS.length;
			tokenB = INTERMEDIATE_TOKENS[nextIndex];
			
			logger.rotation(tokenA.symbol, tokenB.symbol, 'intermediate_rotation');
			logger.info(`🔄 Rotated to intermediate token: ${tokenB.symbol}`);
			
			// Clean up performance data for the old token pair to get fresh optimal sizes
			const oldPair = `${tokenA.symbol}-${INTERMEDIATE_TOKENS[currentIndex].symbol}`;
			logger.debug(`🧹 Clearing cached optimal size for ${oldPair} to allow fresh discovery`);
		};

		// Schedule intermediate token rotation 
		const rotationInterval = parseInt(process.env.TOKEN_ROTATION_INTERVAL_MINUTES) || 2;
		global.tokenRotationInterval = setInterval(rotateIntermediateToken, rotationInterval * 60 * 1000);

		// Set up performance reporting with USD values
		const reportPerformance = async () => {
			const sizerStats = dynamicTradeSizer.getPerformanceStats();
			const mevStats = mevProtector.getProtectionStats();
			const priceStats = priceFeedService.getPriceStats();
			const currentPrice = await priceFeedService.getCurrentSOLPrice();
			
			logger.info('📊'.repeat(20));
			logger.info('🎯 DYNAMIC ARBITRAGE PERFORMANCE REPORT');
			logger.info('📊'.repeat(20));
			logger.info(`🔄 Total Token Pairs Analyzed: ${sizerStats.totalPairs}`);
			logger.info(`⚡ Average Optimal Size: ${sizerStats.averageOptimalSize.toFixed(4)} SOL (${(sizerStats.averageOptimalSize * currentPrice).toFixed(2)})`);
			logger.info(`📈 Overall Success Rate: ${(sizerStats.successRate * 100).toFixed(1)}%`);
			logger.info(`💰 Total Trades: ${cache.tradeCounter.buy.success + cache.tradeCounter.buy.fail}`);
			logger.info(`✅ Successful: ${cache.tradeCounter.buy.success}`);
			logger.info(`❌ Failed: ${cache.tradeCounter.buy.fail}`);
			logger.info(`💎 SOL Price: ${currentPrice} | Trend: ${priceStats.trend} | Volatility: ${priceStats.volatility}%`);
			
			if (mevStats.totalTrades > 0) {
				logger.info(`🛡️ MEV Protected Trades: ${mevStats.protectedTrades}`);
				logger.info(`💵 MEV Savings: ${mevStats.totalMEVSaved.toFixed(2)}`);
			}
			
			if (sizerStats.bestPerformers.length > 0) {
				logger.info('🏆 Top Performing Token Pairs:');
				sizerStats.bestPerformers.slice(0, 3).forEach((performer, index) => {
					const sizeUSD = performer.bestSize * currentPrice;
					const estimatedProfitUSD = (performer.bestProfit / 100) * sizeUSD;
					logger.info(`  ${index + 1}. ${performer.pair}: ${performer.bestProfit.toFixed(4)}% | ${performer.bestSize.toFixed(4)} SOL (~${estimatedProfitUSD.toFixed(2)})`);
				});
			}
			logger.info('📊'.repeat(20));
		};

		// Schedule performance reporting every 30 minutes
		global.performanceReportInterval = setInterval(reportPerformance, 30 * 60 * 1000);

		logger.info("🚀 Starting DYNAMIC TRIANGULAR arbitrage monitor...");
		logger.info(`⏱️ Update interval: ${envConfig.updateInterval}ms`);
		logger.info(`🎯 Target profit: ${envConfig.minProfit}%+ OR ${envConfig.minProfitUSD}+`);
		logger.info(`⚙️ Trading: ${envConfig.tradingEnabled ? '🔥 LIVE TRADING ENABLED' : '💡 SIMULATION'}`);
		logger.info(`📊 Sizing: DYNAMIC (${envConfig.minTradeSize}-${envConfig.maxTradeSize} SOL, ${envConfig.testCount} tests)`);
		logger.info(`🔄 Intermediate tokens: ${INTERMEDIATE_TOKENS.map(t => t.symbol).join(', ')}`);
		logger.info(`🛡️ MEV Protection: ${envConfig.mevProtection ? 'ENABLED' : 'DISABLED'}`);
		logger.info(`💎 Price Feed: LIVE from ${priceSummary.sources.length} sources`);

		logger.info("💻 DYNAMIC TRIANGULAR ARBITRAGE ACTIVE - PRESS [CTRL+C] TO EXIT");
		
		if (cache.tradingEnabled) {
			logger.info("🔥 BOT IS NOW TRADING WITH REAL MONEY!");
			logger.info("🎯 OPTIMIZING TRADE SIZES FOR MAXIMUM MEV CAPTURE!");
			logger.info("💎 USING REAL-TIME SOL PRICE FOR ACCURATE USD CALCULATIONS!");
			logger.info("🚨 Monitor your trades and profits carefully!");
		}

		// Start the watcher with DYNAMIC TRIANGULAR arbitrage
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
	if(global.performanceReportInterval) {
		clearInterval(global.performanceReportInterval);
	}
	
	// Stop price feed updates
	try {
		priceFeedService.stopPriceUpdates();
	} catch (error) {
		logger.warn('Error stopping price updates:', error.message);
	}
	
	// Generate final performance reports
	try {
		const sizerStats = dynamicTradeSizer.getPerformanceStats();
		const mevReport = mevProtector.generateProtectionReport();
		const priceStats = priceFeedService.getPriceStats();
		
		logger.info('🏁 FINAL PERFORMANCE SUMMARY:');
		logger.info(`Total Pairs Analyzed: ${sizerStats.totalPairs}`);
		logger.info(`Average Optimal Size: ${sizerStats.averageOptimalSize.toFixed(4)} SOL`);
		logger.info(`Success Rate: ${(sizerStats.successRate * 100).toFixed(1)}%`);
		logger.info(`Final SOL Price: ${priceStats.currentPrice}`);
		logger.info(`Price Trend: ${priceStats.trend} | Volatility: ${priceStats.volatility}%`);
		
		console.log(mevReport);
		
	} catch (reportError) {
		logger.warn('Could not generate final reports:', reportError.message);
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