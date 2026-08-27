// Run this process separately in production. It intentionally does not invent credentials.
// A production scheduler/queue should load only users with a selected real account and a valid server-side token.
// Each run must call AutoTradingService.runOnce with that token.
console.log("Trading worker started. Connect a secure scheduler/queue for enabled users.");
