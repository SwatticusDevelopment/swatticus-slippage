// quick_fix.js - Run this to fix the getQuote issue
const fs = require('fs');

console.log('🔧 Fixing Jupiter API client...\n');

// Create the Jupiter API client content
const jupiterClientContent = `const axios = require("axios");
const chalk = require("chalk");

// Rate limiting variables
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1500;
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
    
    if (requestCount >= 50) {
        const waitTime = 60000 - (now - requestResetTime);
        console.log(chalk.yellow(\`Rate limit approaching, waiting \${waitTime/1000}s...\`));
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
 * Get a quote for swapping tokens
 */
const getQuote = async (inputMint, outputMint, amount, slippageBps = 100, retryCount = 0) => {
    try {
        await enforceRateLimit();
        const amountStr = amount.toString();

        console.log(chalk.cyan(\`Fetching quote: \${inputMint.substring(0,6)}... → \${outputMint.substring(0,6)}... Amount: \${amountStr}\`));

        const url = \`https://quote-api.jup.ag/v6/quote?inputMint=\${inputMint}&outputMint=\${outputMint}&amount=\${amountStr}&slippageBps=\${slippageBps}&onlyDirectRoutes=false\`;

        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Jupiter-Bot/1.0'
            }
        });
        
        const quoteResponse = response.data;
        
        if(quoteResponse) {
            const inAmount = quoteResponse.inAmount;
            const outAmount = quoteResponse.outAmount;
            const priceImpact = (parseFloat(quoteResponse.priceImpactPct || "0") * 100).toFixed(4);

            console.log(chalk.green(\`Quote received: In: \${inAmount}, Out: \${outAmount}, Impact: \${priceImpact}%\`));
        }

        return quoteResponse;
        
    } catch(error) {
        if (error.response?.status === 429 && retryCount < 3) {
            const backoffTime = Math.pow(2, retryCount) * 30000;
            console.log(chalk.yellow(\`Rate limit hit, waiting \${backoffTime/1000}s...\`));
            await delay(backoffTime);
            return getQuote(inputMint, outputMint, amount, slippageBps, retryCount + 1);
        }
        
        console.error(chalk.red('Error getting Jupiter quote:'), error.message);
        throw error;
    }
};

const checkArbitrageOpportunity = async (tokenAMint, tokenBMint, amount) => {
    try {
        console.log(chalk.cyan(\`Checking arbitrage: \${tokenAMint.substring(0,6)}... ↔ \${tokenBMint.substring(0,6)}...\`));
        
        const forwardQuote = await getQuote(tokenAMint, tokenBMint, amount.toString(), 100);
        const reverseQuote = await getQuote(tokenBMint, tokenAMint, forwardQuote.outAmount, 100);
        
        const startAmount = BigInt(amount.toString());
        const endAmount = BigInt(reverseQuote.outAmount);
        const profitPercentage = Number((endAmount - startAmount) * BigInt(10000) / startAmount) / 100;
        
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
};`;

// Create the rateLimiter content  
const rateLimiterContent = `const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class RateLimiter {
    constructor() {
        this.requestCount = 0;
        this.lastReset = Date.now();
        console.log('Rate Limiter initialized (simple version)');
    }

    async queueRequest(requestFn) {
        await delay(1000); // Simple 1 second delay
        return await requestFn();
    }
}

const rateLimiter = new RateLimiter();

async function makeJupiterRequest(requestFn) {
    return rateLimiter.queueRequest(requestFn);
}

async function getQuoteWithRateLimit(inputMint, outputMint, amount, slippageBps = 100) {
    const { getQuote } = require('./jupiterApiClient');
    return getQuote(inputMint, outputMint, amount, slippageBps);
}

module.exports = {
    rateLimiter,
    makeJupiterRequest,
    getQuoteWithRateLimit
};`;

// Write the files
try {
    // Create utils directory if it doesn't exist
    if (!fs.existsSync('src/utils')) {
        fs.mkdirSync('src/utils', { recursive: true });
        console.log('✅ Created src/utils directory');
    }
    
    // Write Jupiter API client
    fs.writeFileSync('src/utils/jupiterApiClient.js', jupiterClientContent);
    console.log('✅ Created/Updated: src/utils/jupiterApiClient.js');
    
    // Write rate limiter
    fs.writeFileSync('src/utils/rateLimiter.js', rateLimiterContent);
    console.log('✅ Created/Updated: src/utils/rateLimiter.js');
    
} catch (error) {
    console.error('❌ Failed to write files:', error.message);
    process.exit(1);
}

console.log('\n🎉 Jupiter API client has been fixed!');
console.log('\n📋 Next steps:');
console.log('1. Run: node src/index.js');
console.log('2. The bot should now connect to Jupiter API successfully');
console.log('3. Look for "Quote received" messages in the output');
console.log('4. The bot should start monitoring for arbitrage opportunities');

console.log('\n✅ Fix complete!');