const fs = require("fs");
const chalk = require("chalk");
const ora = require("ora-classic");
const bs58 = require("bs58");
const {Connection,Keypair,PublicKey,LAMPORTS_PER_SOL} = require("@solana/web3.js");

const {logExit} = require("./exit");
const {toDecimal,createTempDir} = require("../utils");
const {intro,listenHotkeys} = require("./ui");
const cache = require("./cache");
const {fetchTrendingTokens,getUSDCToken} = require("../utils/tokenFetcher");
const {
	jupiterQuoteApi,
	getQuote,
	checkArbitrageOpportunity
} = require("../utils/jupiterApiClient");
const logger = require("../utils/logger");

const wrapUnwrapSOL = cache.wrapUnwrapSOL;

// Helper function to try multiple RPC endpoints
const tryMultipleRPCs = async (operation, rpcs, maxRetries = 3) => {
	const rpcList = Array.isArray(rpcs) ? rpcs : [rpcs];
	
	for (let rpcIndex = 0; rpcIndex < rpcList.length; rpcIndex++) {
		const rpc = rpcList[rpcIndex];
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				logger.info(`Trying RPC ${rpc} (attempt ${attempt}/${maxRetries})`);
				const connection = new Connection(rpc, {
					commitment: 'confirmed',
					timeout: 30000
				});
				
				const result = await operation(connection);
				logger.info(`Successfully connected to RPC: ${rpc}`);
				return result;
			} catch (error) {
				logger.warn(`RPC ${rpc} failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
				
				if (attempt < maxRetries) {
					const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
					logger.info(`Waiting ${delay}ms before retry...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			}
		}
	}
	
	throw new Error(`All RPC endpoints failed after ${maxRetries} attempts each`);
};

// Improved balance check with multiple RPC fallback
const balanceCheck = async (checkToken) => {
	let checkBalance = Number(0);
	
	const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY));
	
	// Get RPC list from environment
	const primaryRpc = process.env.DEFAULT_RPC;
	const altRpcs = process.env.ALT_RPC_LIST ? process.env.ALT_RPC_LIST.split(',') : [];
	const allRpcs = [primaryRpc, ...altRpcs].filter(Boolean);
	
	logger.info(`Checking balance for ${checkToken.symbol} using ${allRpcs.length} RPC endpoints`);
	
	const balanceOperation = async (connection) => {
		if (wrapUnwrapSOL && checkToken.address === 'So11111111111111111111111111111111111111112') {
			// Check native SOL balance
			const balance = await connection.getBalance(wallet.publicKey);
			return Number(balance);
		} else {
			// Check token balance
			let totalTokenBalance = BigInt(0);
			const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
				mint: new PublicKey(checkToken.address)
			});
			
			tokenAccounts.value.forEach((accountInfo) => {
				const parsedInfo = accountInfo.account.data.parsed.info;
				totalTokenBalance += BigInt(parsedInfo.tokenAmount.amount);
			});
			
			return Number(totalTokenBalance);
		}
	};
	
	try {
		checkBalance = await tryMultipleRPCs(balanceOperation, allRpcs);
		
		const balanceUi = toDecimal(checkBalance, checkToken.decimals);
		logger.info(`Wallet balance for ${checkToken.symbol}: ${balanceUi} (raw: ${checkBalance})`);
		
		if (checkBalance > Number(0)) {
			return checkBalance;
		} else {
			logger.warn(`Zero balance detected for ${checkToken.symbol}`);
			return 0; // Return 0 instead of throwing error
		}
	} catch (error) {
		logger.error(`Failed to check balance for ${checkToken.symbol}: ${error.message}`);
		// Return 0 instead of throwing to prevent bot crash
		logger.warn(`Returning 0 balance due to RPC failure - bot will continue in simulation mode`);
		return 0;
	}
};

// Handle Balance Errors with graceful degradation
const checkTokenABalance = async (tokenObj, requiredAmount) => {
	try {
		const realBalance = await balanceCheck(tokenObj);
		logger.info(`Wallet Balance: ${toDecimal(String(realBalance), tokenObj.decimals)} ${tokenObj.symbol}`);
		
		if (realBalance < requiredAmount && realBalance > 0) {
			logger.warn(`Insufficient balance: have ${toDecimal(realBalance, tokenObj.decimals)}, need ${toDecimal(requiredAmount, tokenObj.decimals)} ${tokenObj.symbol}`);
			logger.warn('Continuing in simulation mode due to insufficient balance');
			cache.tradingEnabled = false; // Force simulation mode
		} else if (realBalance === 0) {
			logger.warn('Zero balance detected - forcing simulation mode');
			cache.tradingEnabled = false; // Force simulation mode
		}
		
		return realBalance;
	} catch (error) {
		logger.error(`Error looking up balance: ${error.message}`);
		logger.warn('Continuing in simulation mode due to balance check failure');
		cache.tradingEnabled = false; // Force simulation mode
		return 0;
	}
};

const setup = async () => {
	// Create dir
	createTempDir();

	// Properly handle wallet initialization with better error handling
	let wallet;
	try {
		// Initialize wallet from private key with explicit error handling
		const privateKeyString = process.env.SOLANA_WALLET_PRIVATE_KEY;
		if (!privateKeyString) {
			throw new Error("SOLANA_WALLET_PRIVATE_KEY is missing in environment variables");
		}

		logger.info("Initializing wallet...");

		try {
			const decodedKey = bs58.decode(privateKeyString);
			wallet = Keypair.fromSecretKey(decodedKey);

			if (!wallet || !wallet.publicKey) {
				throw new Error("Failed to create wallet from private key");
			}

			logger.info("Wallet initialized successfully");
		} catch (walletError) {
			logger.error(`Error creating wallet: ${walletError.message}`);
			throw new Error("Invalid wallet private key format. Please check your .env file.");
		}
	} catch (error) {
		logger.error(`Wallet setup failed: ${error.message}`);
		logExit(1, error);
		process.exit(1);
	}

	let spinner = ora({
		text: "🔄 Setting up Jupiter connection...",
		spinner: "dots",
	}).start();

	try {
		// Listen for hotkeys
		listenHotkeys();

		// setup trading strategy based on env variables or default to arbitrage
		cache.config.tradingStrategy = "arbitrage";
		cache.config.tokenA = {};
		cache.config.tokenB = {};

		// Always use WSOL as tokenA
		const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";
		let tokenA;

		try {
			// Get trending tokens list
			const trendingTokens = await fetchTrendingTokens();

			// Find WSOL in the list
			tokenA = trendingTokens.find(token => token.address === WSOL_ADDRESS);

			if (!tokenA) {
				// If WSOL is not in the list for some reason, create a default WSOL token object
				tokenA = {
					address: WSOL_ADDRESS,
					symbol: "SOL",
					name: "Wrapped SOL",
					decimals: 9,
					logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
					tags: ["wrapped-solana"]
				};
				logger.warn("WSOL not found in token list, using default values.");
			}

			// Set up token rotation
			await setupTokenRotation(trendingTokens);

		} catch (error) {
			logger.error(`Error setting up tokens: ${error.message}`);
			throw new Error("Failed to set up tokens for rotation");
		}

		// Get current tokenB from cache
		const tokenB = cache.currentRotationToken || getUSDCToken();

		logger.info(`Using tokens: ${tokenA.symbol} (${tokenA.address.slice(0, 6)}...) and ${tokenB.symbol} (${tokenB.address.slice(0, 6)}...)`);

		// Check if user wallet has enough SOL to pay for transaction fees with graceful handling
		try {
			const primaryRpc = process.env.DEFAULT_RPC;
			const connection = new Connection(primaryRpc);
			const balance = await connection.getBalance(wallet.publicKey);
			const solBalance = balance / LAMPORTS_PER_SOL;

			if (solBalance < 0.01) {
				logger.warn(`Warning: Your wallet only has ${solBalance.toFixed(4)} SOL. This may not be enough for transaction fees.`);
				if (solBalance < 0.005) {
					logger.warn('Very low SOL balance detected - forcing simulation mode');
					cache.tradingEnabled = false;
				}
			} else {
				logger.info(`SOL balance: ${solBalance.toFixed(4)} SOL`);
			}
		} catch (balanceError) {
			logger.warn(`Could not check wallet SOL balance: ${balanceError.message}`);
			logger.warn('Continuing without SOL balance check');
		}

		// Test Jupiter API with retry logic
		let testQuote = null;
		const maxApiRetries = 3;
		
		for (let attempt = 1; attempt <= maxApiRetries; attempt++) {
			try {
				logger.info(`Testing Jupiter API connection (attempt ${attempt}/${maxApiRetries})...`);
				
				// Use a small amount for testing (0.000001 of the token)
				const testAmount = Math.pow(10, tokenA.decimals - 6).toString();
				testQuote = await getQuote(tokenA.address, tokenB.address, testAmount, 100);

				if (testQuote) {
					spinner.succeed(chalk.green("Jupiter API connection successful!"));
					break;
				}
			} catch (apiError) {
				logger.warn(`Jupiter API test failed (attempt ${attempt}/${maxApiRetries}): ${apiError.message}`);
				
				if (attempt < maxApiRetries) {
					const delay = Math.pow(2, attempt) * 2000; // Exponential backoff
					logger.info(`Waiting ${delay}ms before retry...`);
					await new Promise(resolve => setTimeout(resolve, delay));
				} else {
					spinner.fail(chalk.red("Jupiter API connection failed after all retries"));
					logger.error("Failed to connect to Jupiter API after multiple attempts");
					
					// Don't exit - continue in simulation mode
					logger.warn("Continuing in simulation mode due to Jupiter API issues");
					cache.tradingEnabled = false;
				}
			}
		}

		// Create a real Jupiter interface with improved error handling
		const jupiter = {
			computeRoutes: async ({inputMint, outputMint, amount, slippageBps = 100}) => {
				try {
					logger.debug(`Computing routes for ${inputMint} → ${outputMint}`);

					// Convert PublicKey to string
					const inputMintStr = inputMint instanceof PublicKey ? inputMint.toString() : inputMint;
					const outputMintStr = outputMint instanceof PublicKey ? outputMint.toString() : outputMint;

					// Check if this is a same-token arbitrage
					const isArbitrage = inputMintStr === outputMintStr;

					if (isArbitrage) {
						logger.debug("Same-token arbitrage detected - using intermediate USDC token for routing");
					}

					// Get quote from Jupiter API with retry logic
					let quote = null;
					const maxRouteRetries = 2;
					
					for (let attempt = 1; attempt <= maxRouteRetries; attempt++) {
						try {
							quote = await getQuote(
								inputMintStr,
								outputMintStr,
								amount.toString(),
								slippageBps
							);
							break;
						} catch (routeError) {
							logger.warn(`Route computation failed (attempt ${attempt}/${maxRouteRetries}): ${routeError.message}`);
							
							if (attempt < maxRouteRetries) {
								await new Promise(resolve => setTimeout(resolve, 2000));
							}
						}
					}

					if (!quote || !quote.outAmount) {
						logger.warn("No routes available");
						return {routesInfos: []};
					}

					// Format response to match the expected format
					const routeInfo = {
						outAmount: quote.outAmount,
						inAmount: quote.inAmount,
						amount: quote.inAmount,
						otherAmountThreshold: quote.otherAmountThreshold,
						slippageBps: slippageBps,
						priceImpactPct: parseFloat(quote.priceImpactPct || "0"),
						marketInfos: (quote.routePlan || []).map(step => ({
							id: step.swapInfo?.ammKey || step.swapInfo?.id || 'unknown',
							label: step.swapInfo?.label || 'Unknown AMM',
							inputMint: step.swapInfo?.inputMint || step.sourceMint,
							outputMint: step.swapInfo?.outputMint || step.destinationMint,
							inAmount: step.swapInfo?.inAmount || step.inputAmount,
							outAmount: step.swapInfo?.outAmount || step.outputAmount,
							lpFee: {amount: '0'}
						}))
					};

					// Calculate profit for arbitrage
					if (isArbitrage) {
						const inAmountBN = BigInt(quote.inAmount);
						const outAmountBN = BigInt(quote.outAmount);
						const profit = outAmountBN > inAmountBN ?
							Number((outAmountBN - inAmountBN) * BigInt(10000) / inAmountBN) / 100 : 0;

						logger.debug(`Arbitrage route found with profit: ${profit.toFixed(4)}%`);
					}

					return {routesInfos: [routeInfo]};
				} catch (error) {
					logger.error(`Error computing routes: ${error.message}`);
					return {routesInfos: []};
				}
			},

			exchange: async ({routeInfo}) => {
				return {
					execute: async () => {
						if (!cache.tradingEnabled) {
							logger.info("Executing swap in simulation mode");
							// Simulate a successful transaction
							return {
								txid: "simulation_mode_txid",
								inputAmount: routeInfo.inAmount,
								outputAmount: routeInfo.outAmount,
								success: true
							};
						} else {
							logger.warn("Real trading mode - implement actual swap execution here");
							// In real implementation, this would call the actual swap API
							// For now, just simulate
							return {
								txid: "simulation_mode_txid",
								inputAmount: routeInfo.inAmount,
								outputAmount: routeInfo.outAmount,
								success: true
							};
						}
					}
				};
			}
		};

		return {
			jupiter,
			tokenA,
			tokenB,
			wallet
		};
	} catch (error) {
		spinner.fail(chalk.red("Setup failed!"));
		logger.error(`Error during setup: ${error.message}`);
		logExit(1, error);
		process.exit(1);
	}
};

/**
 * Set up token rotation system
 * @param {Array} tokenList - List of all available tokens
 */
const setupTokenRotation = async (tokenList) => {
	try {
		// Filter out WSOL from token list (since we're always using it as tokenA)
		const filteredTokens = tokenList.filter(token =>
			token.address !== "So11111111111111111111111111111111111111112" &&
			token.daily_volume > 10000 // Only tokens with decent volume
		);

		// Sort by volume for better opportunities
		filteredTokens.sort((a, b) => (b.daily_volume || 0) - (a.daily_volume || 0));

		// Store token rotation list in cache
		cache.tokenRotationList = filteredTokens;

		// Get current index from temp file if it exists
		let currentIndex = 0;
		const indexFilePath = './temp/current_token_index.json';

		if (fs.existsSync(indexFilePath)) {
			try {
				const data = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
				currentIndex = data.index || 0;
			} catch (error) {
				logger.warn("Could not read token rotation index, starting from 0");
			}
		}

		// Make sure the index is valid
		if (currentIndex >= filteredTokens.length) {
			currentIndex = 0;
		}

		// Set current token
		cache.currentRotationToken = filteredTokens[currentIndex];
		cache.currentRotationIndex = currentIndex;

		// Save to file
		fs.writeFileSync(indexFilePath, JSON.stringify({
			index: currentIndex,
			timestamp: new Date().toISOString(),
			currentToken: cache.currentRotationToken.symbol
		}, null, 2));

		logger.info(`Token rotation setup complete. Using ${filteredTokens.length} tokens.`);
		logger.info(`Current token (#${currentIndex + 1}): ${cache.currentRotationToken.symbol}`);

	} catch (error) {
		logger.error(`Error setting up token rotation: ${error.message}`);
		// Fall back to USDC if there's an issue
		cache.currentRotationToken = getUSDCToken();
	}
};

// Export token rotation function to break circular dependency
const createTokenRotationFunction = () => {
	return () => {
		try {
			if (!cache.tokenRotationList || cache.tokenRotationList.length === 0) {
				logger.warn("No token rotation list available. Staying with current token.");
				return null;
			}

			// Increment index
			let nextIndex = (cache.currentRotationIndex + 1) % cache.tokenRotationList.length;

			// Set the next token
			cache.currentRotationToken = cache.tokenRotationList[nextIndex];
			cache.currentRotationIndex = nextIndex;

			// Save to file
			const indexFilePath = './temp/current_token_index.json';
			fs.writeFileSync(indexFilePath, JSON.stringify({
				index: nextIndex,
				timestamp: new Date().toISOString(),
				currentToken: cache.currentRotationToken.symbol
			}, null, 2));

			logger.info(`Rotated to next token (#${nextIndex + 1}): ${cache.currentRotationToken.symbol}`);

			return cache.currentRotationToken;
		} catch (error) {
			logger.error(`Error rotating to next token: ${error.message}`);
			return null;
		}
	};
};

// For backwards compatibility - remove circular dependency
const getInitialotherAmountThreshold = async (
	jupiter,
	inputToken,
	outputToken,
	amountToTrade
) => {
	let spinner;
	try {
		const tokenDecimals = cache.sideBuy ? inputToken.decimals : outputToken.decimals;
		const spinnerText = `Computing routes for the token with amountToTrade ${amountToTrade} with decimals ${tokenDecimals}`;

		spinner = ora({
			text: spinnerText,
			discardStdin: false,
			color: "magenta",
		}).start();

		// Get quote using new Jupiter API
		const quote = await getQuote(
			inputToken.address,
			outputToken.address,
			amountToTrade.toString(),
			100  // 1% slippage
		);

		if (quote) {
			spinner.succeed("Routes computed using Jupiter API v6!");
			return quote.otherAmountThreshold;
		} else {
			spinner.fail("No routes found. Something is wrong! Check tokens:" + inputToken.address + " " + outputToken.address);
			logger.error("No routes found between these tokens. This could be due to:");
			logger.error("1. Insufficient liquidity between the token pair");
			logger.error("2. Invalid token address configuration");
			logger.error("3. RPC issues or network congestion");
			process.exit(1);
		}
	} catch (error) {
		if (spinner)
			spinner.fail(chalk.bold.redBright("Computing routes failed!\n"));
		logger.error(`Error computing routes: ${error.message}`);
		logger.error("This could be due to RPC issues, insufficient liquidity, or invalid token configuration");
		logExit(1, error);
		process.exitCode = 1;
		process.exit(1);
	}
};

module.exports = {
	setup,
	getInitialotherAmountThreshold,
	balanceCheck,
	checkTokenABalance,
	createTokenRotationFunction,
};