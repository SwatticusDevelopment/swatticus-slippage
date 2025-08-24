@echo off
title Jupiter Arbitrage Bot - Dynamic Trading Edition
color 0A

echo.
echo =====================================================
echo   JUPITER DYNAMIC ARBITRAGE BOT - STARTUP
echo =====================================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check if .env file exists
if not exist ".env" (
    echo ERROR: .env file not found!
    echo.
    echo Please create a .env file with your configuration:
    echo 1. Copy .env.example to .env
    echo 2. Edit .env with your wallet private key and settings
    echo.
    echo KEY DYNAMIC TRADING SETTINGS:
    echo TRADING_ENABLED=true
    echo MAX_TRADE_SIZE_SOL=0.1
    echo MIN_TRADE_SIZE_SOL=0.005
    echo TRADE_SIZE_STRATEGY=optimal
    echo MIN_PROFIT_USD=0.50
    echo ENABLE_MEV_PROTECTION=true
    echo.
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    echo.
    npm install
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

REM Create required directories
if not exist "temp" mkdir temp
if not exist "logs" mkdir logs

echo Checking dynamic trading configuration...
node -e "
require('dotenv').config();
console.log('='.repeat(50));
console.log('DYNAMIC TRADING CONFIGURATION');
console.log('='.repeat(50));
console.log('Trading Mode:', process.env.TRADING_ENABLED === 'true' ? 'LIVE TRADING 🔥' : 'SIMULATION 💡');
console.log('Max Trade Size:', process.env.MAX_TRADE_SIZE_SOL || '0.1', 'SOL');
console.log('Min Trade Size:', process.env.MIN_TRADE_SIZE_SOL || '0.005', 'SOL');
console.log('Size Strategy:', (process.env.TRADE_SIZE_STRATEGY || 'optimal').toUpperCase());
console.log('Size Tests:', process.env.TRADE_SIZE_TESTS || '5', 'tests per opportunity');
console.log('Min Profit:', process.env.MIN_PROFIT_THRESHOLD || '0.3', '% OR $' + (process.env.MIN_PROFIT_USD || '0.50'));
console.log('MEV Protection:', process.env.ENABLE_MEV_PROTECTION === 'true' ? 'ENABLED 🛡️' : 'DISABLED');
console.log('='.repeat(50));
"

echo.
echo =====================================================
echo   STARTING DYNAMIC JUPITER ARBITRAGE BOT
echo =====================================================
echo.

REM Check trading mode and show warning
for /f "tokens=*" %%i in ('node -e "require('dotenv').config(); console.log((process.env.TRADE_SIZE_STRATEGY || 'optimal').toUpperCase());"') do set STRATEGY=%%i

echo =====================================================
echo   DYNAMIC SIZING ACTIVE
echo =====================================================
echo Max Trade Size: %MAX_SIZE% SOL
echo Min Trade Size: %MIN_SIZE% SOL  
echo Sizing Strategy: %STRATEGY%
echo =====================================================
echo.

REM Start the bot with error handling
echo Starting dynamic arbitrage bot...
node src/index.js

REM Handle exit codes
if errorlevel 1 (
    echo.
    echo ==========================================
    echo   BOT STOPPED WITH ERROR
    echo ==========================================
    echo.
    echo Check the error messages above.
    echo Error details may be saved in ./temp/startup_error.json
    echo.
    echo Common issues with dynamic trading:
    echo 1. Insufficient wallet balance for max trade size
    echo 2. RPC rate limiting from size testing
    echo 3. Invalid MEV protection configuration
    echo 4. Network connectivity issues
    echo.
) else (
    echo.
    echo ==========================================
    echo   DYNAMIC BOT STOPPED NORMALLY
    echo ==========================================
    echo.
    echo Check ./temp/ and ./logs/ for:
    echo - Trade history with optimal sizes
    echo - Performance analytics
    echo - MEV protection reports
    echo.
)

echo Press any key to close this window...
pause >nul" %%i in ('node -e "require('dotenv').config(); console.log(process.env.TRADING_ENABLED);"') do set TRADING_MODE=%%i

if "%TRADING_MODE%"=="true" (
    echo.
    echo ************************************************
    echo    WARNING: REAL TRADING MODE ENABLED
    echo ************************************************
    echo.
    echo This bot will use REAL MONEY to execute trades!
    echo.
    echo DYNAMIC FEATURES ENABLED:
    echo - Automatically finds optimal trade sizes
    echo - Tests multiple sizes per opportunity
    echo - MEV protection and bundling
    echo - Smart profit optimization
    echo.
    echo Make sure you understand the risks.
    echo.
    echo Starting in 10 seconds... Press Ctrl+C to abort
    timeout /t 10 /nobreak
    echo.
) else (
    echo Running in SIMULATION mode - testing dynamic sizing
    echo No real trades will be executed
    echo.
)

REM Get dynamic sizing configuration
for /f "tokens=*" %%i in ('node -e "require('dotenv').config(); console.log(process.env.MAX_TRADE_SIZE_SOL || '0.1');"') do set MAX_SIZE=%%i
for /f "tokens=*" %%i in ('node -e "require('dotenv').config(); console.log(process.env.MIN_TRADE_SIZE_SOL || '0.005');"') do set MIN_SIZE=%%i
for /f "tokens=*