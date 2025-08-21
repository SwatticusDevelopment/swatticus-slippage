const axios = require("axios");
const chalk = require("chalk");

// Rate limiting variables
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // Increased to 2 seconds
let requestCount = 0;
let requestResetTime = Date.now();

// Helper function to add delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting function
const enforceRateLimit = async () => {
    const now = Date.now();
    
    if (now - requestResetTime > 60000) {
        requestCount = 0;
        requestResetTime = now;
    }
    
    // Reduced from 50 to 30 requests per minute for better stability
    if (requestCount >= 30) {
        const waitTime = 60000 - (now - requestResetTime);
        console.log(chalk.yellow(`Rate limit approaching, waiting ${waitTime/1000}s...`));
        await delay(waitTime);
        requestCount = 0;
        requestResetTime = Date.now();
    }
    
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        await delay(waitTime);
    }
    
    lastRequestTime = Date.now();
    requestCount++;
};

/**
 * Get a quote for swapping tokens with enhanced error handling
 */
const getQuote = async (inputMint, outputMint, amount, slippageBps = 100, retryCount = 0) => {
    const maxRetries = 3;
    
    try {
        await enforceRateLimit();
        const amountStr = amount.toString();

        console.log(chalk.cyan(`Fetching quote: ${inputMint.substring(0,6)}... → ${outputMint.substring(0,6)}... Amount: ${amountStr}`));

        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

        const response = await axios.get(url, {
            timeout: 20000, // Increased timeout to 20 seconds
            headers: {
                'User-Agent': 'Jupiter-Bot/1.0',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
        
        const quoteResponse = response.data;
        
        // Enhanced validation of response
        if (!quoteResponse) {
            throw new Error('Empty response from Jupiter API');
        }
        
        if (!quoteResponse.outAmount || quoteResponse.outAmount === '0') {
            throw new Error('No valid output amount in quote response');
        }
        
        if (!quoteResponse.inAmount) {
            throw new Error('No input amount in quote response');
        }
        
        const inAmount = quoteResponse.inAmount;
        const outAmount = quoteResponse.outAmount;
        const priceImpact = (parseFloat(quoteResponse.priceImpactPct || "0") * 100).toFixed(4);

        console.log(chalk.green(`Quote received: In: ${inAmount}, Out: ${outAmount}, Impact: ${priceImpact}%`));
        
        return quoteResponse;
        
    } catch(error) {
        console.error(chalk.red(`Quote request failed (attempt ${retryCount + 1}/${maxRetries + 1}):`), error.message);
        
        // Handle rate limiting
        if (error.response?.status === 429 && retryCount < maxRetries) {
            const backoffTime = Math.pow(2, retryCount) * 5000; // Exponential backoff starting at 5s
            console.log(chalk.yellow(`Rate limit hit, waiting ${backoffTime/1000}s before retry...`));
            await delay(backoffTime);
            return getQuote(inputMint, outputMint, amount, slippageBps, retryCount + 1);
        }
        
        // Handle network errors
        if ((error.code === 'ECONNRESET' || 
             error.code === 'ETIMEDOUT' || 
             error.code === 'ENOTFOUND' ||
             error.message.includes('timeout')) && retryCount < maxRetries) {
            const backoffTime = (retryCount + 1) * 3000; // Linear backoff for network errors
            console.log(chalk.yellow(`Network error, retrying in ${backoffTime/1000}s (${retryCount + 1}/${maxRetries})...`));
            await delay(backoffTime);
            return getQuote(inputMint, outputMint, amount, slippageBps, retryCount + 1);
        }
        
        // Handle server errors (5xx)
        if (error.response?.status >= 500 && retryCount < maxRetries) {
            const backoffTime = (retryCount + 1) * 4000;
            console.log(chalk.yellow(`Server error (${error.response.status}), retrying in ${backoffTime/1000}s...`));
            await delay(backoffTime);
            return getQuote(inputMint, outputMint, amount, slippageBps, retryCount + 1);
        }
        
        // Handle client errors (4xx) - don't retry most of these
        if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
            console.error(chalk.red(`Client error (${error.response.status}): ${error.response.data?.message || error.message}`));
            throw new Error(`Jupiter API client error: ${error.response.status} - ${error.response.data?.message || error.message}`);
        }
        
        // If we've exhausted all retries or it's an unrecoverable error
        const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
        console.error(chalk.red('Final error after all retries:'), errorMessage);
        throw new Error(`Jupiter API error after ${retryCount + 1} attempts: ${errorMessage}`);
    }
};

const checkArbitrageOpportunity = async (tokenAMint, tokenBMint, amount) => {
    try {
        console.log(chalk.cyan(`Checking arbitrage: ${tokenAMint.substring(0,6)}... ↔ ${tokenBMint.substring(0,6)}...`));
        
        let forwardQuote, reverseQuote;
        
        try {
            forwardQuote = await getQuote(tokenAMint, tokenBMint, amount.toString(), 100);
        } catch (error) {
            console.error(chalk.red('Forward quote failed:'), error.message);
            return { hasOpportunity: false, error: `Forward quote failed: ${error.message}` };
        }
        
        if (!forwardQuote || !forwardQuote.outAmount) {
            return { hasOpportunity: false, error: 'No forward quote available' };
        }
        
        // Add delay between quotes
        await delay(1500);
        
        try {
            reverseQuote = await getQuote(tokenBMint, tokenAMint, forwardQuote.outAmount, 100);
        } catch (error) {
            console.error(chalk.red('Reverse quote failed:'), error.message);
            return { hasOpportunity: false, error: `Reverse quote failed: ${error.message}` };
        }
        
        if (!reverseQuote || !reverseQuote.outAmount) {
            return { hasOpportunity: false, error: 'No reverse quote available' };
        }
        
        const startAmount = BigInt(amount.toString());
        const endAmount = BigInt(reverseQuote.outAmount);
        const profitPercentage = Number((endAmount - startAmount) * BigInt(10000) / startAmount) / 100;
        
        console.log(chalk.blue(`Arbitrage analysis: ${profitPercentage.toFixed(4)}% profit potential`));
        
        return {
            startAmount: amount.toString(),
            finalAmount: reverseQuote.outAmount,
            profitPercentage,
            hasOpportunity: profitPercentage > 0,
            forwardQuote,
            reverseQuote
        };
    } catch (error) {
        console.error(chalk.red('Arbitrage check failed:'), error.message);
        return { hasOpportunity: false, error: error.message };
    }
};

module.exports = {
    getQuote,
    checkArbitrageOpportunity
};