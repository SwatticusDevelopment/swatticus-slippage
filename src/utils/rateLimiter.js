const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class RateLimiter {
    constructor() {
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.requestQueue = [];
        this.processing = false;
        this.maxRequestsPerMinute = 25; // Conservative limit
        this.minDelayBetweenRequests = 2500; // 2.5 seconds minimum
        this.lastRequestTime = 0;
        
        console.log('Rate Limiter initialized with enhanced protection', {
            maxPerMinute: this.maxRequestsPerMinute,
            minDelay: this.minDelayBetweenRequests
        });
    }

    async queueRequest(requestFn) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ 
                requestFn, 
                resolve, 
                reject,
                timestamp: Date.now()
            });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.processing || this.requestQueue.length === 0) return;
        
        this.processing = true;
        
        try {
            while (this.requestQueue.length > 0) {
                const now = Date.now();
                
                // Reset counter every minute
                if (now - this.lastReset > 60000) {
                    this.requestCount = 0;
                    this.lastReset = now;
                    console.log('Rate limiter: Counter reset');
                }
                
                // Check if we need to wait for rate limit
                if (this.requestCount >= this.maxRequestsPerMinute) {
                    const waitTime = 60000 - (now - this.lastReset);
                    console.log(`Rate limit reached (${this.requestCount}/${this.maxRequestsPerMinute}), waiting ${waitTime/1000}s...`);
                    await delay(waitTime);
                    this.requestCount = 0;
                    this.lastReset = Date.now();
                }
                
                // Ensure minimum delay between requests
                const timeSinceLastRequest = now - this.lastRequestTime;
                if (timeSinceLastRequest < this.minDelayBetweenRequests) {
                    const waitTime = this.minDelayBetweenRequests - timeSinceLastRequest;
                    console.log(`Enforcing minimum delay: waiting ${waitTime}ms...`);
                    await delay(waitTime);
                }
                
                const { requestFn, resolve, reject, timestamp } = this.requestQueue.shift();
                
                // Check if request is too old (older than 30 seconds)
                if (Date.now() - timestamp > 30000) {
                    console.warn('Discarding stale request from queue');
                    reject(new Error('Request timeout in queue'));
                    continue;
                }
                
                try {
                    console.log(`Processing request (${this.requestCount + 1}/${this.maxRequestsPerMinute} this minute)`);
                    const result = await requestFn();
                    this.requestCount++;
                    this.lastRequestTime = Date.now();
                    resolve(result);
                } catch (error) {
                    console.error('Request failed in rate limiter:', error.message);
                    
                    // If it's a rate limit error, add extra delay
                    if (error.message.includes('429') || error.message.includes('rate limit')) {
                        console.log('Rate limit error detected, adding extra delay...');
                        await delay(10000); // 10 second penalty
                    }
                    
                    reject(error);
                }
                
                // Small delay between processing queue items
                await delay(500);
            }
        } catch (error) {
            console.error('Error in rate limiter queue processing:', error);
        } finally {
            this.processing = false;
        }
    }

    // Get current status
    getStatus() {
        return {
            requestCount: this.requestCount,
            maxRequestsPerMinute: this.maxRequestsPerMinute,
            queueLength: this.requestQueue.length,
            processing: this.processing,
            lastRequestTime: this.lastRequestTime,
            timeToReset: Math.max(0, 60000 - (Date.now() - this.lastReset))
        };
    }

    // Clear the queue (emergency use)
    clearQueue() {
        const clearedCount = this.requestQueue.length;
        this.requestQueue.forEach(({ reject }) => {
            reject(new Error('Queue cleared'));
        });
        this.requestQueue = [];
        console.log(`Cleared ${clearedCount} requests from queue`);
    }

    // Reset rate limiting (emergency use)
    reset() {
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.lastRequestTime = 0;
        console.log('Rate limiter reset');
    }
}

const rateLimiter = new RateLimiter();

async function makeJupiterRequest(requestFn) {
    return rateLimiter.queueRequest(requestFn);
}

async function getQuoteWithRateLimit(inputMint, outputMint, amount, slippageBps = 100) {
    const { getQuote } = require('./jupiterApiClient');
    
    return makeJupiterRequest(async () => {
        return getQuote(inputMint, outputMint, amount, slippageBps);
    });
}

// Enhanced function with circuit breaker pattern
async function getQuoteWithCircuitBreaker(inputMint, outputMint, amount, slippageBps = 100) {
    const maxConsecutiveFailures = 5;
    const circuitBreakerTimeout = 60000; // 1 minute
    
    // Simple circuit breaker state (in a real app, this would be persistent)
    if (!rateLimiter.circuitBreaker) {
        rateLimiter.circuitBreaker = {
            failures: 0,
            lastFailure: 0,
            isOpen: false
        };
    }
    
    const cb = rateLimiter.circuitBreaker;
    
    // Check if circuit breaker is open
    if (cb.isOpen) {
        if (Date.now() - cb.lastFailure > circuitBreakerTimeout) {
            // Try to close the circuit breaker
            cb.isOpen = false;
            cb.failures = 0;
            console.log('Circuit breaker: Attempting to close circuit');
        } else {
            throw new Error('Circuit breaker is open - too many recent failures');
        }
    }
    
    try {
        const result = await getQuoteWithRateLimit(inputMint, outputMint, amount, slippageBps);
        
        // Success - reset failure count
        cb.failures = 0;
        return result;
        
    } catch (error) {
        cb.failures++;
        cb.lastFailure = Date.now();
        
        console.warn(`Circuit breaker: Failure ${cb.failures}/${maxConsecutiveFailures}`);
        
        // Open circuit breaker if too many failures
        if (cb.failures >= maxConsecutiveFailures) {
            cb.isOpen = true;
            console.error('Circuit breaker: OPENED due to consecutive failures');
        }
        
        throw error;
    }
}

module.exports = {
    rateLimiter,
    makeJupiterRequest,
    getQuoteWithRateLimit,
    getQuoteWithCircuitBreaker
};