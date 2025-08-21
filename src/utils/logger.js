const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

class Logger {
    constructor() {
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.logToFile = process.env.LOG_TO_FILE !== 'false';
        this.logDirectory = './logs';
        this.maxLogFiles = 10;
        this.maxLogSize = 10 * 1024 * 1024; // 10MB
        
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        
        this.colors = {
            error: chalk.red.bold,
            warn: chalk.yellow,
            info: chalk.cyan,
            debug: chalk.gray
        };
        
        this.setupLogDirectory();
        this.currentLogFile = this.getCurrentLogFile();
        
        // Log startup
        this.info('Logger initialized', {
            level: this.logLevel,
            logToFile: this.logToFile,
            logDirectory: this.logDirectory
        });
    }

    setupLogDirectory() {
        if (this.logToFile && !fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
    }

    getCurrentLogFile() {
        if (!this.logToFile) return null;
        
        const date = new Date().toISOString().split('T')[0];
        return path.join(this.logDirectory, `bot_${date}.log`);
    }

    shouldLog(level) {
        return this.levels[level] <= this.levels[this.logLevel];
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const pid = process.pid;
        
        // Base log object
        const logObject = {
            timestamp,
            level: level.toUpperCase(),
            pid,
            message,
            ...meta
        };

        // Console format (colored and readable)
        const consoleMessage = `${chalk.gray(timestamp)} ${this.colors[level](`[${level.toUpperCase()}]`)} ${chalk.gray(`[${pid}]`)} ${message}`;
        
        // File format (JSON for parsing)
        const fileMessage = JSON.stringify(logObject);
        
        return { consoleMessage, fileMessage, logObject };
    }

    writeToFile(message) {
        if (!this.logToFile || !this.currentLogFile) return;
        
        try {
            // Check if we need to rotate log file
            this.rotateLogIfNeeded();
            
            fs.appendFileSync(this.currentLogFile, message + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    rotateLogIfNeeded() {
        if (!fs.existsSync(this.currentLogFile)) return;
        
        const stats = fs.statSync(this.currentLogFile);
        if (stats.size > this.maxLogSize) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedFile = this.currentLogFile.replace('.log', `_${timestamp}.log`);
            
            fs.renameSync(this.currentLogFile, rotatedFile);
            this.cleanOldLogs();
        }
    }

    cleanOldLogs() {
        try {
            const files = fs.readdirSync(this.logDirectory)
                .filter(file => file.startsWith('bot_') && file.endsWith('.log'))
                .map(file => ({
                    name: file,
                    path: path.join(this.logDirectory, file),
                    time: fs.statSync(path.join(this.logDirectory, file)).mtime
                }))
                .sort((a, b) => b.time - a.time);
            
            // Keep only the most recent files
            files.slice(this.maxLogFiles).forEach(file => {
                fs.unlinkSync(file.path);
            });
        } catch (error) {
            console.error('Failed to clean old logs:', error);
        }
    }

    log(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;
        
        const { consoleMessage, fileMessage } = this.formatMessage(level, message, meta);
        
        // Always output to console
        console.log(consoleMessage);
        
        // Write to file if enabled
        this.writeToFile(fileMessage);
    }

    error(message, meta = {}) {
        // For errors, also include stack trace if meta is an Error object
        if (meta instanceof Error) {
            meta = {
                name: meta.name,
                message: meta.message,
                stack: meta.stack,
                ...(typeof meta === 'object' ? meta : {})
            };
        }
        this.log('error', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta);
    }

    info(message, meta = {}) {
        this.log('info', message, meta);
    }

    debug(message, meta = {}) {
        this.log('debug', message, meta);
    }

    // Specialized logging methods for trading bot
    trade(action, details = {}) {
        this.info(`TRADE_${action.toUpperCase()}`, {
            category: 'trading',
            action,
            ...details
        });
    }

    performance(operation, duration, details = {}) {
        this.info(`PERFORMANCE_${operation.toUpperCase()}`, {
            category: 'performance',
            operation,
            duration_ms: duration,
            ...details
        });
    }

    balance(token, amount, details = {}) {
        this.info('BALANCE_UPDATE', {
            category: 'balance',
            token,
            amount,
            ...details
        });
    }

    rpc(endpoint, operation, duration, success = true, details = {}) {
        this.info(`RPC_${operation.toUpperCase()}`, {
            category: 'rpc',
            endpoint,
            operation,
            duration_ms: duration,
            success,
            ...details
        });
    }

    rotation(fromToken, toToken, reason = 'scheduled') {
        this.info('TOKEN_ROTATION', {
            category: 'rotation',
            from_token: fromToken,
            to_token: toToken,
            reason
        });
    }

    arbitrage(tokenPair, profit, details = {}) {
        const level = profit > 0 ? 'info' : 'warn';
        this[level]('ARBITRAGE_OPPORTUNITY', {
            category: 'arbitrage',
            token_pair: tokenPair,
            profit_percent: profit,
            ...details
        });
    }

    // Get recent logs for monitoring
    getRecentLogs(count = 100) {
        if (!this.logToFile || !fs.existsSync(this.currentLogFile)) {
            return [];
        }
        
        try {
            const content = fs.readFileSync(this.currentLogFile, 'utf8');
            const lines = content.trim().split('\n');
            const recentLines = lines.slice(-count);
            
            return recentLines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return { message: line, level: 'unknown' };
                }
            });
        } catch (error) {
            this.error('Failed to read recent logs', error);
            return [];
        }
    }

    // Get logs by level
    getLogsByLevel(level, count = 50) {
        const recentLogs = this.getRecentLogs(500);
        return recentLogs
            .filter(log => log.level === level.toUpperCase())
            .slice(-count);
    }

    // Get trading-specific logs
    getTradingLogs(count = 50) {
        const recentLogs = this.getRecentLogs(500);
        return recentLogs
            .filter(log => log.category === 'trading')
            .slice(-count);
    }

    // Log statistics
    getLogStats() {
        const recentLogs = this.getRecentLogs(1000);
        const stats = {
            total: recentLogs.length,
            by_level: {},
            by_category: {},
            errors_last_hour: 0,
            warnings_last_hour: 0
        };
        
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        
        recentLogs.forEach(log => {
            // Count by level
            stats.by_level[log.level] = (stats.by_level[log.level] || 0) + 1;
            
            // Count by category
            if (log.category) {
                stats.by_category[log.category] = (stats.by_category[log.category] || 0) + 1;
            }
            
            // Count recent errors and warnings
            const logTime = new Date(log.timestamp);
            if (logTime > oneHourAgo) {
                if (log.level === 'ERROR') stats.errors_last_hour++;
                if (log.level === 'WARN') stats.warnings_last_hour++;
            }
        });
        
        return stats;
    }

    // Export logs for analysis
    exportLogs(startDate, endDate, filename) {
        try {
            const logs = this.getRecentLogs(10000).filter(log => {
                const logDate = new Date(log.timestamp);
                return logDate >= startDate && logDate <= endDate;
            });
            
            const exportPath = path.join('./temp', filename || `logs_export_${Date.now()}.json`);
            fs.writeFileSync(exportPath, JSON.stringify(logs, null, 2));
            
            this.info(`Logs exported to ${exportPath}`, { count: logs.length });
            return exportPath;
        } catch (error) {
            this.error('Failed to export logs', error);
            throw error;
        }
    }

    // Set log level dynamically
    setLogLevel(level) {
        if (this.levels.hasOwnProperty(level)) {
            this.logLevel = level;
            this.info(`Log level changed to: ${level}`);
        } else {
            this.warn(`Invalid log level: ${level}. Valid levels: ${Object.keys(this.levels).join(', ')}`);
        }
    }

    // Flush logs (ensure all logs are written)
    flush() {
        // In this simple implementation, logs are written synchronously
        // In a more advanced version, you might have buffered async writes
        this.info('Log flush completed');
    }
}

// Create singleton instance
const logger = new Logger();

// Handle process exit to flush logs
process.on('exit', () => {
    logger.flush();
});

module.exports = logger;