const os = require('os');
const fs = require('fs');
const { performance } = require('perf_hooks');
const logger = require('./logger');
const cache = require('../bot/cache');

class HealthMonitor {
    constructor() {
        this.startTime = Date.now();
        this.metrics = {
            system: {
                cpu: [],
                memory: [],
                disk: []
            },
            bot: {
                iterations: 0,
                successfulTrades: 0,
                failedTrades: 0,
                errors: 0,
                avgResponseTime: 0,
                lastUpdate: Date.now()
            },
            rpc: {
                requests: 0,
                failures: 0,
                avgResponseTime: 0,
                lastSuccessful: null
            },
            jupiter: {
                requests: 0,
                rateLimitHits: 0,
                failures: 0,
                avgResponseTime: 0
            }
        };
        
        this.thresholds = {
            maxMemoryUsage: 0.85, // 85% of available memory
            maxCpuUsage: 0.80,    // 80% CPU usage
            maxErrorRate: 0.10,   // 10% error rate
            minSuccessRate: 0.85, // 85% success rate
            maxResponseTime: 5000, // 5 seconds
            maxConsecutiveErrors: 5
        };
        
        this.alerts = {
            active: new Map(),
            history: []
        };
        
        this.consecutiveErrors = 0;
        this.isHealthy = true;
        this.lastHealthCheck = Date.now();
        
        // Start monitoring
        this.startMonitoring();
        
        logger.info('Health Monitor initialized', {
            thresholds: this.thresholds
        });
    }

    startMonitoring() {
        // System metrics every 30 seconds
        this.systemMetricsInterval = setInterval(() => {
            this.collectSystemMetrics();
        }, 30000);

        // Bot metrics every 10 seconds
        this.botMetricsInterval = setInterval(() => {
            this.collectBotMetrics();
        }, 10000);

        // Health check every 60 seconds
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 60000);

        // Cleanup old metrics every 5 minutes
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldMetrics();
        }, 300000);
    }

    collectSystemMetrics() {
        try {
            // CPU Usage
            const cpuUsage = process.cpuUsage();
            const totalCpuTime = cpuUsage.user + cpuUsage.system;
            this.metrics.system.cpu.push({
                timestamp: Date.now(),
                usage: totalCpuTime,
                loadAverage: os.loadavg()[0]
            });

            // Memory Usage
            const memUsage = process.memoryUsage();
            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const usedMemory = totalMemory - freeMemory;
            
            this.metrics.system.memory.push({
                timestamp: Date.now(),
                total: totalMemory,
                used: usedMemory,
                free: freeMemory,
                heapUsed: memUsage.heapUsed,
                heapTotal: memUsage.heapTotal,
                external: memUsage.external,
                rss: memUsage.rss
            });

            // Disk Usage (for log directory)
            try {
                const stats = fs.statSync('./logs');
                this.metrics.system.disk.push({
                    timestamp: Date.now(),
                    logDirSize: this.getDirectorySize('./logs'),
                    tempDirSize: this.getDirectorySize('./temp')
                });
            } catch (error) {
                // Directory might not exist
            }

        } catch (error) {
            logger.error('Failed to collect system metrics', error);
        }
    }

    collectBotMetrics() {
        try {
            // Update bot metrics from cache
            this.metrics.bot = {
                iterations: cache.iteration || 0,
                successfulTrades: (cache.tradeCounter?.buy?.success || 0) + (cache.tradeCounter?.sell?.success || 0),
                failedTrades: (cache.tradeCounter?.buy?.fail || 0) + (cache.tradeCounter?.sell?.fail || 0),
                errors: cache.tradeCounter?.errorcount || 0,
                tradingEnabled: cache.tradingEnabled,
                swappingRightNow: cache.swappingRightNow,
                currentToken: cache.currentRotationToken?.symbol || 'unknown',
                maxProfitSpotted: cache.maxProfitSpotted?.buy || 0,
                balance: cache.currentBalance?.tokenA || 0,
                lastUpdate: Date.now()
            };

            // Calculate success rate
            const totalTrades = this.metrics.bot.successfulTrades + this.metrics.bot.failedTrades;
            this.metrics.bot.successRate = totalTrades > 0 ? this.metrics.bot.successfulTrades / totalTrades : 0;
            this.metrics.bot.errorRate = totalTrades > 0 ? this.metrics.bot.failedTrades / totalTrades : 0;

        } catch (error) {
            logger.error('Failed to collect bot metrics', error);
        }
    }

    performHealthCheck() {
        const healthStatus = {
            timestamp: Date.now(),
            overall: 'HEALTHY',
            checks: {},
            alerts: []
        };

        try {
            // System health checks
            healthStatus.checks.memory = this.checkMemoryHealth();
            healthStatus.checks.cpu = this.checkCpuHealth();
            healthStatus.checks.disk = this.checkDiskHealth();

            // Bot health checks
            healthStatus.checks.bot = this.checkBotHealth();
            healthStatus.checks.trading = this.checkTradingHealth();
            healthStatus.checks.errors = this.checkErrorHealth();

            // External service health
            healthStatus.checks.rpc = this.checkRpcHealth();
            healthStatus.checks.jupiter = this.checkJupiterHealth();

            // Determine overall health
            const failedChecks = Object.entries(healthStatus.checks)
                .filter(([_, status]) => status.status !== 'HEALTHY');

            if (failedChecks.length === 0) {
                healthStatus.overall = 'HEALTHY';
                this.isHealthy = true;
            } else if (failedChecks.some(([_, status]) => status.status === 'CRITICAL')) {
                healthStatus.overall = 'CRITICAL';
                this.isHealthy = false;
            } else {
                healthStatus.overall = 'WARNING';
                this.isHealthy = true; // Still operational but needs attention
            }

            // Handle alerts
            failedChecks.forEach(([check, status]) => {
                if (status.status === 'CRITICAL' || status.status === 'WARNING') {
                    this.handleAlert(check, status);
                }
            });

            // Clear resolved alerts
            this.clearResolvedAlerts(Object.keys(healthStatus.checks));

            this.lastHealthCheck = Date.now();
            
            // Log health status
            if (healthStatus.overall === 'HEALTHY') {
                logger.info('Health check passed', { status: healthStatus.overall });
            } else {
                logger.warn('Health check issues detected', { 
                    status: healthStatus.overall,
                    failedChecks: failedChecks.length
                });
            }

        } catch (error) {
            logger.error('Health check failed', error);
            healthStatus.overall = 'CRITICAL';
            healthStatus.checks.monitor = {
                status: 'CRITICAL',
                message: `Health monitor error: ${error.message}`
            };
        }

        return healthStatus;
    }

    checkMemoryHealth() {
        const latest = this.getLatestMetric('system.memory');
        if (!latest) return { status: 'UNKNOWN', message: 'No memory data' };

        const memoryUsagePercent = latest.used / latest.total;
        const heapUsagePercent = latest.heapUsed / latest.heapTotal;

        if (memoryUsagePercent > this.thresholds.maxMemoryUsage) {
            return {
                status: 'CRITICAL',
                message: `High memory usage: ${(memoryUsagePercent * 100).toFixed(1)}%`,
                value: memoryUsagePercent
            };
        } else if (heapUsagePercent > 0.9) {
            return {
                status: 'WARNING',
                message: `High heap usage: ${(heapUsagePercent * 100).toFixed(1)}%`,
                value: heapUsagePercent
            };
        }

        return {
            status: 'HEALTHY',
            message: `Memory usage: ${(memoryUsagePercent * 100).toFixed(1)}%`,
            value: memoryUsagePercent
        };
    }

    checkCpuHealth() {
        const latest = this.getLatestMetric('system.cpu');
        if (!latest) return { status: 'UNKNOWN', message: 'No CPU data' };

        const loadAverage = latest.loadAverage;
        const cpuCores = os.cpus().length;
        const loadPercent = loadAverage / cpuCores;

        if (loadPercent > this.thresholds.maxCpuUsage) {
            return {
                status: 'WARNING',
                message: `High CPU load: ${loadPercent.toFixed(2)} (${(loadPercent * 100).toFixed(1)}%)`,
                value: loadPercent
            };
        }

        return {
            status: 'HEALTHY',
            message: `CPU load: ${loadPercent.toFixed(2)}`,
            value: loadPercent
        };
    }

    checkDiskHealth() {
        const latest = this.getLatestMetric('system.disk');
        if (!latest) return { status: 'HEALTHY', message: 'No disk data' };

        const totalSize = (latest.logDirSize || 0) + (latest.tempDirSize || 0);
        const maxSize = 100 * 1024 * 1024; // 100MB limit

        if (totalSize > maxSize) {
            return {
                status: 'WARNING',
                message: `High disk usage: ${(totalSize / 1024 / 1024).toFixed(1)}MB`,
                value: totalSize
            };
        }

        return {
            status: 'HEALTHY',
            message: `Disk usage: ${(totalSize / 1024 / 1024).toFixed(1)}MB`,
            value: totalSize
        };
    }

    checkBotHealth() {
        const bot = this.metrics.bot;
        const timeSinceUpdate = Date.now() - bot.lastUpdate;

        if (timeSinceUpdate > 300000) { // 5 minutes
            return {
                status: 'CRITICAL',
                message: `Bot not updating (${Math.floor(timeSinceUpdate / 1000)}s ago)`,
                value: timeSinceUpdate
            };
        }

        if (bot.iterations === 0) {
            return {
                status: 'WARNING',
                message: 'Bot has not started iterations',
                value: 0
            };
        }

        return {
            status: 'HEALTHY',
            message: `Bot active (${bot.iterations} iterations)`,
            value: bot.iterations
        };
    }

    checkTradingHealth() {
        const bot = this.metrics.bot;

        if (bot.errorRate > this.thresholds.maxErrorRate) {
            return {
                status: 'WARNING',
                message: `High error rate: ${(bot.errorRate * 100).toFixed(1)}%`,
                value: bot.errorRate
            };
        }

        if (bot.successRate < this.thresholds.minSuccessRate && (bot.successfulTrades + bot.failedTrades) > 10) {
            return {
                status: 'WARNING',
                message: `Low success rate: ${(bot.successRate * 100).toFixed(1)}%`,
                value: bot.successRate
            };
        }

        return {
            status: 'HEALTHY',
            message: `Trading performance normal`,
            value: bot.successRate
        };
    }

    checkErrorHealth() {
        if (this.consecutiveErrors > this.thresholds.maxConsecutiveErrors) {
            return {
                status: 'CRITICAL',
                message: `Too many consecutive errors: ${this.consecutiveErrors}`,
                value: this.consecutiveErrors
            };
        }

        return {
            status: 'HEALTHY',
            message: `Error count normal`,
            value: this.consecutiveErrors
        };
    }

    checkRpcHealth() {
        const rpc = this.metrics.rpc;

        if (!rpc.lastSuccessful || Date.now() - rpc.lastSuccessful > 300000) {
            return {
                status: 'CRITICAL',
                message: 'RPC connection issues detected',
                value: rpc.lastSuccessful
            };
        }

        const failureRate = rpc.requests > 0 ? rpc.failures / rpc.requests : 0;
        if (failureRate > 0.2) {
            return {
                status: 'WARNING',
                message: `High RPC failure rate: ${(failureRate * 100).toFixed(1)}%`,
                value: failureRate
            };
        }

        return {
            status: 'HEALTHY',
            message: 'RPC connection healthy',
            value: failureRate
        };
    }

    checkJupiterHealth() {
        const jupiter = this.metrics.jupiter;

        if (jupiter.rateLimitHits > 10) {
            return {
                status: 'WARNING',
                message: `Frequent Jupiter rate limits: ${jupiter.rateLimitHits}`,
                value: jupiter.rateLimitHits
            };
        }

        const failureRate = jupiter.requests > 0 ? jupiter.failures / jupiter.requests : 0;
        if (failureRate > 0.3) {
            return {
                status: 'WARNING',
                message: `High Jupiter failure rate: ${(failureRate * 100).toFixed(1)}%`,
                value: failureRate
            };
        }

        return {
            status: 'HEALTHY',
            message: 'Jupiter API healthy',
            value: failureRate
        };
    }

    handleAlert(checkName, status) {
        const alertId = `${checkName}_${status.status}`;
        
        if (!this.alerts.active.has(alertId)) {
            const alert = {
                id: alertId,
                check: checkName,
                status: status.status,
                message: status.message,
                firstSeen: Date.now(),
                count: 1
            };
            
            this.alerts.active.set(alertId, alert);
            this.alerts.history.push({ ...alert, type: 'NEW' });
            
            logger.warn(`Health alert: ${alert.message}`, {
                category: 'health',
                check: checkName,
                status: status.status
            });
        } else {
            // Update existing alert
            const alert = this.alerts.active.get(alertId);
            alert.count++;
            alert.lastSeen = Date.now();
        }
    }

    clearResolvedAlerts(activeChecks) {
        for (const [alertId, alert] of this.alerts.active) {
            const checkStillFailing = activeChecks.some(check => 
                alertId.startsWith(check) && 
                this.getLatestHealthCheck()?.checks[check]?.status !== 'HEALTHY'
            );
            
            if (!checkStillFailing) {
                this.alerts.active.delete(alertId);
                this.alerts.history.push({ 
                    ...alert, 
                    type: 'RESOLVED',
                    resolvedAt: Date.now()
                });
                
                logger.info(`Health alert resolved: ${alert.message}`, {
                    category: 'health',
                    check: alert.check
                });
            }
        }
    }

    getLatestMetric(path) {
        const parts = path.split('.');
        let current = this.metrics;
        
        for (const part of parts) {
            current = current[part];
            if (!current) return null;
        }
        
        if (Array.isArray(current) && current.length > 0) {
            return current[current.length - 1];
        }
        
        return current;
    }

    cleanupOldMetrics() {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
        
        // Clean system metrics
        this.metrics.system.cpu = this.metrics.system.cpu.filter(m => m.timestamp > cutoff);
        this.metrics.system.memory = this.metrics.system.memory.filter(m => m.timestamp > cutoff);
        this.metrics.system.disk = this.metrics.system.disk.filter(m => m.timestamp > cutoff);
        
        // Clean alert history (keep last 100)
        if (this.alerts.history.length > 100) {
            this.alerts.history = this.alerts.history.slice(-100);
        }
        
        logger.debug('Cleaned up old metrics');
    }

    getDirectorySize(dirPath) {
        if (!fs.existsSync(dirPath)) return 0;
        
        let totalSize = 0;
        const files = fs.readdirSync(dirPath);
        
        for (const file of files) {
            const filePath = require('path').join(dirPath, file);
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
        }
        
        return totalSize;
    }

    // Public interface methods
    getHealthStatus() {
        return {
            isHealthy: this.isHealthy,
            lastCheck: this.lastHealthCheck,
            uptime: Date.now() - this.startTime,
            activeAlerts: Array.from(this.alerts.active.values()),
            metrics: this.getMetricsSummary()
        };
    }

    getMetricsSummary() {
        return {
            system: {
                memory: this.getLatestMetric('system.memory'),
                cpu: this.getLatestMetric('system.cpu'),
                disk: this.getLatestMetric('system.disk')
            },
            bot: this.metrics.bot,
            rpc: this.metrics.rpc,
            jupiter: this.metrics.jupiter
        };
    }

    recordRpcRequest(endpoint, success, responseTime) {
        this.metrics.rpc.requests++;
        if (success) {
            this.metrics.rpc.lastSuccessful = Date.now();
            this.consecutiveErrors = 0;
        } else {
            this.metrics.rpc.failures++;
            this.consecutiveErrors++;
        }
        
        // Update average response time
        const total = this.metrics.rpc.avgResponseTime * (this.metrics.rpc.requests - 1) + responseTime;
        this.metrics.rpc.avgResponseTime = total / this.metrics.rpc.requests;
    }

    recordJupiterRequest(success, responseTime, rateLimited = false) {
        this.metrics.jupiter.requests++;
        if (rateLimited) {
            this.metrics.jupiter.rateLimitHits++;
        }
        if (!success) {
            this.metrics.jupiter.failures++;
        }
        
        // Update average response time
        const total = this.metrics.jupiter.avgResponseTime * (this.metrics.jupiter.requests - 1) + responseTime;
        this.metrics.jupiter.avgResponseTime = total / this.metrics.jupiter.requests;
    }

    // Generate health report
    generateHealthReport() {
        const status = this.getHealthStatus();
        const uptime = Math.floor(status.uptime / 1000);
        
        let report = '\n';
        report += chalk.bold.cyan('='.repeat(50)) + '\n';
        report += chalk.bold.cyan('        HEALTH MONITORING REPORT') + '\n';
        report += chalk.bold.cyan('='.repeat(50)) + '\n\n';
        
        // Overall status
        const statusColor = status.isHealthy ? chalk.green : chalk.red;
        report += statusColor.bold(`Overall Status: ${status.isHealthy ? 'HEALTHY' : 'UNHEALTHY'}\n`);
        report += chalk.gray(`Uptime: ${uptime}s\n`);
        report += chalk.gray(`Last Check: ${new Date(status.lastCheck).toLocaleString()}\n\n`);
        
        // Active alerts
        if (status.activeAlerts.length > 0) {
            report += chalk.red.bold('🚨 ACTIVE ALERTS:\n');
            status.activeAlerts.forEach(alert => {
                report += chalk.red(`   ${alert.message} (${alert.count}x)\n`);
            });
            report += '\n';
        }
        
        // Metrics summary
        report += chalk.yellow.bold('📊 METRICS SUMMARY:\n');
        if (status.metrics.system.memory) {
            const memPercent = (status.metrics.system.memory.used / status.metrics.system.memory.total * 100).toFixed(1);
            report += chalk.gray(`   Memory: ${memPercent}%\n`);
        }
        
        report += chalk.gray(`   Bot Iterations: ${status.metrics.bot.iterations}\n`);
        report += chalk.gray(`   Successful Trades: ${status.metrics.bot.successfulTrades}\n`);
        report += chalk.gray(`   Failed Trades: ${status.metrics.bot.failedTrades}\n`);
        report += chalk.gray(`   RPC Requests: ${status.metrics.rpc.requests}\n`);
        report += chalk.gray(`   Jupiter Requests: ${status.metrics.jupiter.requests}\n`);
        
        report += '\n' + chalk.bold.cyan('='.repeat(50)) + '\n';
        
        return report;
    }

    // Stop monitoring (for graceful shutdown)
    stopMonitoring() {
        if (this.systemMetricsInterval) clearInterval(this.systemMetricsInterval);
        if (this.botMetricsInterval) clearInterval(this.botMetricsInterval);
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        
        logger.info('Health monitoring stopped');
    }
}

// Create singleton instance
const healthMonitor = new HealthMonitor();

module.exports = healthMonitor;