const logger = require('./logger');
const cache = require('../bot/cache');

class MemoryManager {
    constructor() {
        this.maxTradeHistorySize = parseInt(process.env.MAX_TRADE_HISTORY) || 1000;
        this.maxChartDataPoints = parseInt(process.env.MAX_CHART_DATA_POINTS) || 120;
        this.maxLogEntries = parseInt(process.env.MAX_LOG_ENTRIES) || 500;
        this.gcInterval = parseInt(process.env.GC_INTERVAL_MS) || 300000; // 5 minutes
        this.memoryWarningThreshold = 0.85; // 85% of heap
        this.memoryCriticalThreshold = 0.95; // 95% of heap
        
        this.startTime = Date.now();
        this.lastGC = Date.now();
        this.gcCount = 0;
        this.memoryLeakDetection = {
            samples: [],
            maxSamples: 20,
            sampleInterval: 60000 // 1 minute
        };
        
        this.setupMemoryMonitoring();
        
        logger.info('Memory Manager initialized', {
            maxTradeHistory: this.maxTradeHistorySize,
            maxChartData: this.maxChartDataPoints,
            gcInterval: this.gcInterval
        });
    }

    setupMemoryMonitoring() {
        // Regular garbage collection
        this.gcTimer = setInterval(() => {
            this.performGarbageCollection();
        }, this.gcInterval);

        // Memory leak detection
        this.leakDetectionTimer = setInterval(() => {
            this.detectMemoryLeaks();
        }, this.memoryLeakDetection.sampleInterval);

        // Monitor memory warnings
        this.memoryWarningTimer = setInterval(() => {
            this.checkMemoryWarnings();
        }, 30000); // Check every 30 seconds
    }

    performGarbageCollection() {
        const beforeGC = process.memoryUsage();
        const startTime = Date.now();
        
        try {
            // Clean trade history
            this.cleanTradeHistory();
            
            // Clean chart data
            this.cleanChartData();
            
            // Clean cache queues
            this.cleanCacheQueues();
            
            // Clean logs if memory is high
            if (this.getMemoryUsagePercent() > this.memoryWarningThreshold) {
                this.emergencyCleanup();
            }
            
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
            
            const afterGC = process.memoryUsage();
            const duration = Date.now() - startTime;
            const memoryFreed = beforeGC.heapUsed - afterGC.heapUsed;
            
            this.gcCount++;
            this.lastGC = Date.now();
            
            logger.debug('Garbage collection completed', {
                duration,
                memoryFreed: this.formatBytes(memoryFreed),
                heapUsed: this.formatBytes(afterGC.heapUsed),
                heapTotal: this.formatBytes(afterGC.heapTotal),
                gcCount: this.gcCount
            });
            
            // Log if significant memory was freed
            if (memoryFreed > 10 * 1024 * 1024) { // 10MB
                logger.info(`Significant memory freed: ${this.formatBytes(memoryFreed)}`);
            }
            
        } catch (error) {
            logger.error('Garbage collection failed', error);
        }
    }

    cleanTradeHistory() {
        if (!cache.tradeHistory || !Array.isArray(cache.tradeHistory)) {
            return;
        }
        
        const originalLength = cache.tradeHistory.length;
        
        if (originalLength > this.maxTradeHistorySize) {
            // Keep only the most recent trades
            cache.tradeHistory = cache.tradeHistory.slice(-this.maxTradeHistorySize);
            
            const removed = originalLength - cache.tradeHistory.length;
            logger.debug(`Cleaned trade history: removed ${removed} old entries`);
        }
    }

    cleanChartData() {
        if (!cache.chart) return;
        
        // Clean spotted max arrays
        if (cache.chart.spottedMax) {
            if (cache.chart.spottedMax.buy && cache.chart.spottedMax.buy.length > this.maxChartDataPoints) {
                cache.chart.spottedMax.buy = cache.chart.spottedMax.buy.slice(-this.maxChartDataPoints);
            }
            if (cache.chart.spottedMax.sell && cache.chart.spottedMax.sell.length > this.maxChartDataPoints) {
                cache.chart.spottedMax.sell = cache.chart.spottedMax.sell.slice(-this.maxChartDataPoints);
            }
        }
        
        // Clean performance array
        if (cache.chart.performanceOfRouteComp && cache.chart.performanceOfRouteComp.length > this.maxChartDataPoints) {
            cache.chart.performanceOfRouteComp = cache.chart.performanceOfRouteComp.slice(-this.maxChartDataPoints);
        }
    }

    cleanCacheQueues() {
        if (!cache.queue) return;
        
        // Remove completed queue items (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        const keysToDelete = [];
        
        for (const [key, value] of Object.entries(cache.queue)) {
            // If the queue item is a number (timestamp) and it's old
            if (typeof value === 'number' && key < fiveMinutesAgo) {
                keysToDelete.push(key);
            }
        }
        
        keysToDelete.forEach(key => delete cache.queue[key]);
        
        if (keysToDelete.length > 0) {
            logger.debug(`Cleaned cache queue: removed ${keysToDelete.length} old items`);
        }
    }

    emergencyCleanup() {
        logger.warn('Performing emergency memory cleanup due to high memory usage');
        
        // More aggressive cleanup
        if (cache.tradeHistory && cache.tradeHistory.length > 100) {
            cache.tradeHistory = cache.tradeHistory.slice(-100);
            logger.warn('Emergency: Reduced trade history to 100 entries');
        }
        
        // Clear all chart data except recent
        if (cache.chart) {
            if (cache.chart.spottedMax) {
                cache.chart.spottedMax.buy = cache.chart.spottedMax.buy?.slice(-50) || [];
                cache.chart.spottedMax.sell = cache.chart.spottedMax.sell?.slice(-50) || [];
            }
            if (cache.chart.performanceOfRouteComp) {
                cache.chart.performanceOfRouteComp = cache.chart.performanceOfRouteComp.slice(-50);
            }
            logger.warn('Emergency: Reduced chart data to 50 points');
        }
        
        // Clear old queue items
        cache.queue = {};
        
        // Force garbage collection
        if (global.gc) {
            global.gc();
            logger.warn('Emergency: Forced garbage collection');
        }
    }

    detectMemoryLeaks() {
        const memUsage = process.memoryUsage();
        const sample = {
            timestamp: Date.now(),
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss
        };
        
        this.memoryLeakDetection.samples.push(sample);
        
        // Keep only recent samples
        if (this.memoryLeakDetection.samples.length > this.memoryLeakDetection.maxSamples) {
            this.memoryLeakDetection.samples.shift();
        }
        
        // Analyze for memory leaks
        if (this.memoryLeakDetection.samples.length >= 10) {
            this.analyzeMemoryTrend();
        }
    }

    analyzeMemoryTrend() {
        const samples = this.memoryLeakDetection.samples;
        const recentSamples = samples.slice(-10);
        
        // Calculate trend in heap usage
        let totalIncrease = 0;
        let consecutiveIncreases = 0;
        
        for (let i = 1; i < recentSamples.length; i++) {
            const increase = recentSamples[i].heapUsed - recentSamples[i-1].heapUsed;
            if (increase > 0) {
                totalIncrease += increase;
                consecutiveIncreases++;
            } else {
                consecutiveIncreases = 0;
            }
        }
        
        // Memory leak indicators
        const avgIncrease = totalIncrease / (recentSamples.length - 1);
        const isLeaking = consecutiveIncreases >= 5 && avgIncrease > 1024 * 1024; // 1MB avg increase
        
        if (isLeaking) {
            logger.warn('Potential memory leak detected', {
                consecutiveIncreases,
                avgIncrease: this.formatBytes(avgIncrease),
                currentHeap: this.formatBytes(recentSamples[recentSamples.length - 1].heapUsed),
                recommendation: 'Consider restarting the bot if memory usage continues to increase'
            });
        }
    }

    checkMemoryWarnings() {
        const memUsage = process.memoryUsage();
        const usagePercent = this.getMemoryUsagePercent();
        
        if (usagePercent > this.memoryCriticalThreshold) {
            logger.error('CRITICAL: Memory usage is critically high', {
                usage: `${(usagePercent * 100).toFixed(1)}%`,
                heapUsed: this.formatBytes(memUsage.heapUsed),
                heapTotal: this.formatBytes(memUsage.heapTotal),
                action: 'Performing emergency cleanup'
            });
            
            this.emergencyCleanup();
            
        } else if (usagePercent > this.memoryWarningThreshold) {
            logger.warn('Memory usage is high', {
                usage: `${(usagePercent * 100).toFixed(1)}%`,
                heapUsed: this.formatBytes(memUsage.heapUsed),
                heapTotal: this.formatBytes(memUsage.heapTotal),
                recommendation: 'Consider reducing trade history size or restarting'
            });
        }
    }

    getMemoryUsagePercent() {
        const memUsage = process.memoryUsage();
        return memUsage.heapUsed / memUsage.heapTotal;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Public interface methods
    getMemoryStats() {
        const memUsage = process.memoryUsage();
        const uptime = Date.now() - this.startTime;
        
        return {
            current: {
                heapUsed: this.formatBytes(memUsage.heapUsed),
                heapTotal: this.formatBytes(memUsage.heapTotal),
                external: this.formatBytes(memUsage.external),
                rss: this.formatBytes(memUsage.rss),
                usagePercent: (this.getMemoryUsagePercent() * 100).toFixed(1) + '%'
            },
            management: {
                gcCount: this.gcCount,
                lastGC: new Date(this.lastGC).toLocaleString(),
                uptime: Math.floor(uptime / 1000) + 's',
                tradeHistorySize: cache.tradeHistory?.length || 0,
                maxTradeHistorySize: this.maxTradeHistorySize
            },
            leakDetection: {
                samplesCollected: this.memoryLeakDetection.samples.length,
                trend: this.analyzeTrendStatus()
            }
        };
    }

    analyzeTrendStatus() {
        if (this.memoryLeakDetection.samples.length < 5) {
            return 'INSUFFICIENT_DATA';
        }
        
        const recent = this.memoryLeakDetection.samples.slice(-5);
        let increases = 0;
        
        for (let i = 1; i < recent.length; i++) {
            if (recent[i].heapUsed > recent[i-1].heapUsed) {
                increases++;
            }
        }
        
        if (increases >= 4) return 'INCREASING';
        if (increases <= 1) return 'DECREASING';
        return 'STABLE';
    }

    // Force cleanup operations
    forceCleanup() {
        logger.info('Forcing memory cleanup...');
        this.performGarbageCollection();
        
        const stats = this.getMemoryStats();
        logger.info('Forced cleanup completed', stats.current);
        
        return stats;
    }

    // Configure memory limits
    setLimits(options = {}) {
        if (options.maxTradeHistory) {
            this.maxTradeHistorySize = options.maxTradeHistory;
            logger.info(`Trade history limit set to: ${this.maxTradeHistorySize}`);
        }
        
        if (options.maxChartDataPoints) {
            this.maxChartDataPoints = options.maxChartDataPoints;
            logger.info(`Chart data limit set to: ${this.maxChartDataPoints}`);
        }
        
        if (options.gcInterval) {
            clearInterval(this.gcTimer);
            this.gcInterval = options.gcInterval;
            this.gcTimer = setInterval(() => {
                this.performGarbageCollection();
            }, this.gcInterval);
            logger.info(`GC interval set to: ${this.gcInterval}ms`);
        }
    }

    // Stop memory management (for graceful shutdown)
    stop() {
        if (this.gcTimer) clearInterval(this.gcTimer);
        if (this.leakDetectionTimer) clearInterval(this.leakDetectionTimer);
        if (this.memoryWarningTimer) clearInterval(this.memoryWarningTimer);
        
        logger.info('Memory management stopped');
    }

    // Generate memory report
    generateMemoryReport() {
        const stats = this.getMemoryStats();
        const samples = this.memoryLeakDetection.samples;
        
        let report = '\n';
        report += '='.repeat(50) + '\n';
        report += '           MEMORY MANAGEMENT REPORT\n';
        report += '='.repeat(50) + '\n\n';
        
        // Current usage
        report += '📊 CURRENT MEMORY USAGE:\n';
        report += `   Heap Used: ${stats.current.heapUsed} (${stats.current.usagePercent})\n`;
        report += `   Heap Total: ${stats.current.heapTotal}\n`;
        report += `   RSS: ${stats.current.rss}\n`;
        report += `   External: ${stats.current.external}\n\n`;
        
        // Management stats
        report += '🔧 MANAGEMENT STATISTICS:\n';
        report += `   GC Cycles: ${stats.management.gcCount}\n`;
        report += `   Last GC: ${stats.management.lastGC}\n`;
        report += `   Uptime: ${stats.management.uptime}\n`;
        report += `   Trade History: ${stats.management.tradeHistorySize}/${stats.management.maxTradeHistorySize}\n\n`;
        
        // Leak detection
        report += '🔍 LEAK DETECTION:\n';
        report += `   Trend: ${stats.leakDetection.trend}\n`;
        report += `   Samples: ${stats.leakDetection.samplesCollected}\n`;
        
        if (samples.length >= 2) {
            const first = samples[0];
            const last = samples[samples.length - 1];
            const change = last.heapUsed - first.heapUsed;
            const timespan = last.timestamp - first.timestamp;
            
            report += `   Memory Change: ${this.formatBytes(change)} over ${Math.floor(timespan / 60000)}min\n`;
        }
        
        report += '\n' + '='.repeat(50) + '\n';
        
        return report;
    }
}

// Create singleton instance
const memoryManager = new MemoryManager();

module.exports = memoryManager;