/**
 * Build Queue System - Single Build Lock with Timeout & Auto-Recovery
 * Ensures only one build runs at a time and auto-releases stuck builds
 */

class BuildQueue {
    constructor() {
        this.isBuilding = false;
        this.currentBuildChatId = null;
        this.buildStartTime = null;
        this.lastActivityTime = null;

        // Timeout settings
        this.MAX_BUILD_TIME = 45 * 60 * 1000;      // 45 minutes absolute max
        this.INACTIVITY_TIMEOUT = 10 * 60 * 1000;  // 10 minutes no activity

        // Start watchdog to detect stuck builds
        this.startWatchdog();
    }

    /**
     * Start watchdog to check for stuck builds every minute
     */
    startWatchdog() {
        setInterval(() => {
            this.checkStuckBuilds();
        }, 60 * 1000); // Check every 1 minute
    }

    /**
     * Check and auto-release stuck builds
     */
    checkStuckBuilds() {
        if (!this.isBuilding) return;

        const now = Date.now();
        const totalTime = now - this.buildStartTime;
        const inactiveTime = now - (this.lastActivityTime || this.buildStartTime);

        // Force release if exceeded max time
        if (totalTime > this.MAX_BUILD_TIME) {
            console.warn(`[Queue] ⚠️ BUILD TIMEOUT! Total time ${Math.round(totalTime / 60000)}m exceeded limit. Force releasing...`);
            this.forceRelease();
            return;
        }

        // Force release if inactive too long
        if (inactiveTime > this.INACTIVITY_TIMEOUT) {
            console.warn(`[Queue] ⚠️ BUILD INACTIVE! No activity for ${Math.round(inactiveTime / 60000)}m. Force releasing...`);
            this.forceRelease();
            return;
        }

        // Log status for monitoring
        console.log(`[Queue] 📊 Build running: ${Math.round(totalTime / 60000)}m, last activity: ${Math.round(inactiveTime / 1000)}s ago`);
    }

    /**
     * Update activity timestamp (call during build progress)
     */
    updateActivity() {
        this.lastActivityTime = Date.now();
    }

    /**
     * Check if a build is currently in progress
     * @returns {boolean}
     */
    isBusy() {
        return this.isBuilding;
    }

    /**
     * Get current build info
     * @returns {object|null}
     */
    getCurrentBuild() {
        if (!this.isBuilding) return null;
        return {
            chatId: this.currentBuildChatId,
            startTime: this.buildStartTime,
            duration: Date.now() - this.buildStartTime,
            lastActivity: this.lastActivityTime
        };
    }

    /**
     * Lock the build queue for a specific chat
     * @param {number} chatId - Chat ID of the user
     * @returns {boolean} - True if lock acquired, false if busy
     */
    acquire(chatId) {
        if (this.isBuilding) {
            return false;
        }

        this.isBuilding = true;
        this.currentBuildChatId = chatId;
        this.buildStartTime = Date.now();
        this.lastActivityTime = Date.now();
        console.log(`[Queue] ✅ Build started for chat ${chatId}`);
        return true;
    }

    /**
     * Release the build lock
     * @param {number} chatId - Chat ID of the user (for verification)
     */
    release(chatId = null) {
        if (chatId && this.currentBuildChatId !== chatId) {
            console.warn(`[Queue] Attempted to release lock by wrong chat: ${chatId}, current: ${this.currentBuildChatId}`);
        }

        const duration = this.buildStartTime ? Date.now() - this.buildStartTime : 0;
        console.log(`[Queue] ✅ Build completed for chat ${this.currentBuildChatId} (${Math.round(duration / 1000)}s)`);

        this.isBuilding = false;
        this.currentBuildChatId = null;
        this.buildStartTime = null;
        this.lastActivityTime = null;
    }

    /**
     * Force release (for error recovery or admin)
     */
    forceRelease() {
        console.log(`[Queue] 🔄 Force releasing lock for chat ${this.currentBuildChatId}`);
        this.isBuilding = false;
        this.currentBuildChatId = null;
        this.buildStartTime = null;
        this.lastActivityTime = null;
    }

    /**
     * Get formatted status message
     * @returns {string}
     */
    getStatusMessage() {
        if (!this.isBuilding) {
            return '✅ Server siap untuk build';
        }

        const duration = Math.round((Date.now() - this.buildStartTime) / 1000);
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;

        return `⏳ Server sedang build (${minutes}m ${seconds}s)`;
    }
}

// Singleton instance
const buildQueue = new BuildQueue();

module.exports = { buildQueue };
