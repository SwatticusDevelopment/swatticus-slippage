// global cache - UPDATED FOR DYNAMIC TRADING
const cache = {
	startTime: new Date(),
	queue: {},
	queueThrottle: 1,
	sideBuy: true,
	iteration: 0,
	walletpubkey: '',
	walletpubkeyfull: '',
	iterationPerMinute: {
		start: performance.now(),
		value: 0,
		counter: 0,
	},
	initialBalance: {
		tokenA: 0,
		tokenB: 0,
	},

	currentBalance: {
		tokenA: 0,
		tokenB: 0,
	},
	currentProfit: {
		tokenA: 0,
		tokenB: 0,
	},
	lastBalance: {
		tokenA: 0,
		tokenB: 0,
	},
	profit: {
		tokenA: 0,
		tokenB: 0,
	},
	maxProfitSpotted: {
		buy: 0,
		sell: 0,
	},
	tradeCounter: {
		buy: { success: 0, fail: 0 },
		sell: { success: 0, fail: 0 },
		failedbalancecheck: 0,
		errorcount: 0,
	},
	ui: {
		defaultColor: process.env.UI_COLOR ?? "cyan",
		showPerformanceOfRouteCompChart: false,
		showProfitChart: false,
		showTradeHistory: false,
		hideRpc: false,
		showHelp: false,
		allowClear: true,
	},
	chart: {
		spottedMax: {
			buy: new Array(120).fill(0),
			sell: new Array(120).fill(0),
		},
		performanceOfRouteComp: new Array(120).fill(0),
	},
	hotkeys: {
		e: false,
		r: false,
	},
	// UPDATED: Default to real trading if TRADING_ENABLED is true
	tradingEnabled: process.env.TRADING_ENABLED === "true",
	wrapUnwrapSOL:
		process.env.WRAP_UNWRAP_SOL === undefined
			? true
			: process.env.WRAP_UNWRAP_SOL === "true",
	swappingRightNow: false,
	fetchingResultsFromSolscan: false,
	fetchingResultsFromSolscanStart: 0,
	tradeHistory: [],
	performanceOfTxStart: 0,
	availableRoutes: {
		buy: 0,
		sell: 0,
	},
	isSetupDone: false,
	
	// Token rotation state
	tokenRotationList: [],
	currentRotationToken: null,
	currentRotationIndex: 0,
	
	// ENHANCED: Dynamic trading state
	dynamicSizing: {
		enabled: true,
		maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1,
		minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE_SOL) || 0.005,
		strategy: process.env.TRADE_SIZE_STRATEGY || "optimal",
		testCount: parseInt(process.env.TRADE_SIZE_TESTS) || 5,
		lastOptimalSizes: new Map(), // tokenPair -> optimal size
		performanceHistory: new Map(), // tokenPair -> performance data
		totalSizeTests: 0,
		successfulSizeTests: 0,
	},
	
	// MEV protection state
	mevProtection: {
		enabled: process.env.ENABLE_MEV_PROTECTION === "true",
		useJitoBundles: process.env.USE_JITO_BUNDLES === "true",
		randomizeGas: process.env.RANDOMIZE_GAS === "true",
		usePrivateMempool: process.env.USE_PRIVATE_MEMPOOL === "true",
		maxMEVLoss: parseFloat(process.env.MAX_MEV_LOSS_PERCENT) || 0.2,
		protectedTrades: 0,
		detectedMEV: 0,
		savedUSD: 0,
	},
	
	config: {
		// Default configuration from environment variables
		rpc: [process.env.DEFAULT_RPC || ""],
		minInterval: parseInt(process.env.MIN_INTERVAL_MS) || 3000,
		slippage: parseInt(process.env.MAX_SLIPPAGE_PERCENT * 100) || 100,
		priority: parseInt(process.env.PRIORITY) || 150000,
		minPercProfit: parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.3,
		minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.50,
		adaptiveSlippage: process.env.ADAPTIVE_SLIPPAGE === "true" ? 1 : 0,
		tradingStrategy: "arbitrage",
		tradeSize: {
			value: parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1, // Now maximum
			strategy: process.env.TRADE_SIZE_STRATEGY || "optimal",
			min: parseFloat(process.env.MIN_TRADE_SIZE_SOL) || 0.005,
			max: parseFloat(process.env.MAX_TRADE_SIZE_SOL) || 0.1,
			testCount: parseInt(process.env.TRADE_SIZE_TESTS) || 5,
		},
		ui: {
			defaultColor: process.env.UI_COLOR || "cyan",
		},
		storeFailedTxInHistory: true,
		
		// Enhanced configuration
		smartOrderRouting: process.env.SMART_ORDER_ROUTING === "true",
		maxPriceImpact: parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT) || 2.0,
		sizeTestDelay: parseInt(process.env.SIZE_TEST_DELAY_MS) || 500,
		logSizeTests: process.env.LOG_SIZE_TESTS === "true",
		enableSizeOptimization: process.env.ENABLE_SIZE_OPTIMIZATION === "true",
		maxTradesPerHour: parseInt(process.env.MAX_TRADES_PER_HOUR) || 20,
	},
	
	// Trade rate limiting
	rateLimit: {
		tradesThisHour: 0,
		hourStart: Date.now(),
		maxTradesPerHour: parseInt(process.env.MAX_TRADES_PER_HOUR) || 20,
	},
	
	// Performance tracking
	performance: {
		totalIterations: 0,
		profitableOpportunities: 0,
		executedTrades: 0,
		averageOptimalSize: 0,
		totalProfitUSD: 0,
		totalVolumeUSD: 0,
		bestTrade: {
			profit: 0,
			profitUSD: 0,
			size: 0,
			pair: '',
			timestamp: null
		},
		sizingEfficiency: 0, // How often optimal size beats average size
	}
};

// Enhanced logging for dynamic trading mode
console.log(`🚀 DYNAMIC TRADING MODE: ${cache.tradingEnabled ? '🔥 LIVE TRADING ENABLED' : '💡 SIMULATION MODE'}`);
console.log(`📊 Dynamic Sizing: ${cache.dynamicSizing.enabled ? 'ENABLED' : 'DISABLED'}`);
console.log(`💰 Trade Size Range: ${cache.dynamicSizing.minTradeSize} - ${cache.dynamicSizing.maxTradeSize} SOL`);
console.log(`🎯 Strategy: ${cache.dynamicSizing.strategy.toUpperCase()} (${cache.dynamicSizing.testCount} tests)`);
console.log(`🛡️ MEV Protection: ${cache.mevProtection.enabled ? 'ENABLED' : 'DISABLED'}`);

// Helper functions for dynamic trading
cache.updateOptimalSize = (tokenPair, size, profit) => {
	cache.dynamicSizing.lastOptimalSizes.set(tokenPair, {
		size,
		profit,
		timestamp: Date.now()
	});
};

cache.getLastOptimalSize = (tokenPair) => {
	const data = cache.dynamicSizing.lastOptimalSizes.get(tokenPair);
	return data ? data.size : null;
};

cache.updatePerformanceStats = (tradeData) => {
	cache.performance.totalIterations++;
	
	if (tradeData.profitable) {
		cache.performance.profitableOpportunities++;
	}
	
	if (tradeData.executed) {
		cache.performance.executedTrades++;
		cache.performance.totalProfitUSD += tradeData.profitUSD || 0;
		cache.performance.totalVolumeUSD += tradeData.volumeUSD || 0;
		
		// Update average optimal size
		const currentAvg = cache.performance.averageOptimalSize;
		const newCount = cache.performance.executedTrades;
		cache.performance.averageOptimalSize = ((currentAvg * (newCount - 1)) + tradeData.size) / newCount;
		
		// Update best trade
		if (tradeData.profitUSD > cache.performance.bestTrade.profitUSD) {
			cache.performance.bestTrade = {
				profit: tradeData.profit,
				profitUSD: tradeData.profitUSD,
				size: tradeData.size,
				pair: tradeData.pair,
				timestamp: Date.now()
			};
		}
	}
};

cache.checkRateLimit = () => {
	const now = Date.now();
	const hourInMs = 60 * 60 * 1000;
	
	// Reset counter if hour has passed
	if (now - cache.rateLimit.hourStart > hourInMs) {
		cache.rateLimit.tradesThisHour = 0;
		cache.rateLimit.hourStart = now;
	}
	
	// Check if we're under the limit
	return cache.rateLimit.tradesThisHour < cache.rateLimit.maxTradesPerHour;
};

cache.incrementTradeCount = () => {
	cache.rateLimit.tradesThisHour++;
};

cache.getPerformanceSummary = () => {
	const perf = cache.performance;
	return {
		iterations: perf.totalIterations,
		opportunities: perf.profitableOpportunities,
		executed: perf.executedTrades,
		successRate: perf.totalIterations > 0 ? (perf.profitableOpportunities / perf.totalIterations) : 0,
		executionRate: perf.profitableOpportunities > 0 ? (perf.executedTrades / perf.profitableOpportunities) : 0,
		averageOptimalSize: perf.averageOptimalSize,
		totalProfitUSD: perf.totalProfitUSD,
		totalVolumeUSD: perf.totalVolumeUSD,
		averageProfitPerTrade: perf.executedTrades > 0 ? (perf.totalProfitUSD / perf.executedTrades) : 0,
		bestTrade: perf.bestTrade,
		rateLimit: {
			tradesThisHour: cache.rateLimit.tradesThisHour,
			maxPerHour: cache.rateLimit.maxTradesPerHour,
			remaining: cache.rateLimit.maxTradesPerHour - cache.rateLimit.tradesThisHour
		}
	};
};

module.exports = cache;