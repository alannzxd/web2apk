const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

/**
 * Build APK from ZIP project (Flutter or Android Studio)
 */
async function buildFromZip(zipPath, projectType, buildType, onProgress) {
    const jobId = uuidv4();
    const tempDir = path.join(__dirname, '..', '..', 'temp', jobId);

    try {
        // Extract ZIP
        onProgress('📂 Extracting project files...');
        await fs.ensureDir(tempDir);

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(tempDir, true);

        // Find project root (look for build.gradle or pubspec.yaml)
        const projectRoot = await findProjectRoot(tempDir, projectType);
        if (!projectRoot) {
            throw new Error(`Invalid ${projectType} project. Required files not found.`);
        }

        onProgress('🔍 Project detected: ' + projectType);

        // Build based on project type
        let apkPath;
        if (projectType === 'flutter') {
            apkPath = await buildFlutter(projectRoot, buildType, onProgress);
        } else {
            apkPath = await buildAndroid(projectRoot, buildType, onProgress);
        }

        // Clean up ZIP file
        await fs.remove(zipPath).catch(() => { });

        return {
            success: true,
            apkPath: apkPath,
            buildDir: tempDir
        };

    } catch (error) {
        // Cleanup on error
        await fs.remove(tempDir).catch(() => { });
        await fs.remove(zipPath).catch(() => { });

        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Find project root directory
 */
async function findProjectRoot(dir, projectType) {
    const targetFile = projectType === 'flutter' ? 'pubspec.yaml' : 'build.gradle';

    // Check current directory
    if (await fs.pathExists(path.join(dir, targetFile))) {
        return dir;
    }

    // Check subdirectories (in case ZIP has a root folder)
    const items = await fs.readdir(dir);
    for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = await fs.stat(itemPath);
        if (stat.isDirectory()) {
            if (await fs.pathExists(path.join(itemPath, targetFile))) {
                return itemPath;
            }
        }
    }

    return null;
}

/**
 * Build Flutter project
 */
async function buildFlutter(projectDir, buildType, onProgress) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';

    // ============================================
    // STEP 1: Aggressive Gradle cache cleanup using shell command
    // This fixes JetifyTransform failures with Flutter engine JARs
    // ============================================
    onProgress('🗑️ Cleaning Gradle caches (aggressive)...');

    try {
        // Use shell command for guaranteed deletion on Linux
        await runCommand('rm', ['-rf',
            `${homeDir}/.gradle/caches/transforms-3`,
            `${homeDir}/.gradle/caches/modules-2/files-2.1/io.flutter`,
            `${homeDir}/.gradle/caches/jars-9`,
            `${projectDir}/.gradle`,
            `${projectDir}/android/.gradle`,
            `${projectDir}/build`,
            `${projectDir}/android/app/build`,
            `${projectDir}/android/build`
        ], projectDir).catch(() => { });
    } catch (e) {
        console.log('[CLEAN] Shell cleanup partial:', e.message);
    }

    // Also try fs-based cleanup as fallback
    const gradleCacheDirs = [
        path.join(homeDir, '.gradle', 'caches', 'transforms-3'),
        path.join(homeDir, '.gradle', 'caches', 'modules-2', 'files-2.1', 'io.flutter'),
        path.join(homeDir, '.gradle', 'caches', 'jars-9'),
        path.join(projectDir, '.gradle'),
        path.join(projectDir, 'android', '.gradle'),
        path.join(projectDir, 'build'),
        path.join(projectDir, 'android', 'app', 'build'),
        path.join(projectDir, 'android', 'build')
    ];

    for (const cacheDir of gradleCacheDirs) {
        try {
            await fs.remove(cacheDir);
        } catch (e) { /* ignore */ }
    }

    // ============================================
    // STEP 2: Disable Jetifier in gradle.properties
    // This prevents JetifyTransform from running on Flutter JARs
    // ============================================
    onProgress('⚙️ Configuring Gradle properties...');
    const gradlePropsPath = path.join(projectDir, 'android', 'gradle.properties');
    try {
        let gradleProps = '';
        if (await fs.pathExists(gradlePropsPath)) {
            gradleProps = await fs.readFile(gradlePropsPath, 'utf8');
        }

        // Add/update critical properties
        const propsToSet = {
            'org.gradle.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
            'android.useAndroidX': 'true',
            'android.enableJetifier': 'false',  // CRITICAL: Disable Jetifier for Flutter
            'org.gradle.daemon': 'false',
            'org.gradle.parallel': 'true',
            'org.gradle.caching': 'false'
        };

        for (const [key, value] of Object.entries(propsToSet)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(gradleProps)) {
                gradleProps = gradleProps.replace(regex, `${key}=${value}`);
            } else {
                gradleProps += `\n${key}=${value}`;
            }
        }

        await fs.writeFile(gradlePropsPath, gradleProps.trim() + '\n');
        console.log('[CONFIG] Updated gradle.properties with Jetifier disabled');
    } catch (e) {
        console.log('[CONFIG] Could not update gradle.properties:', e.message);
    }

    // ============================================
    // STEP 3: Flutter clean and pub get
    // ============================================
    onProgress('🧹 Running flutter clean...');
    await runCommand('flutter', ['clean'], projectDir).catch(() => { });

    onProgress('📦 Getting Flutter dependencies...');
    await runCommand('flutter', ['pub', 'get'], projectDir, onProgress);

    // ============================================
    // STEP 4: Build APK
    // ============================================
    onProgress('🔨 Building Flutter APK (this may take a while)...');
    const buildArgs = buildType === 'release'
        ? ['build', 'apk', '--release', '--no-tree-shake-icons']
        : ['build', 'apk', '--debug'];

    // Start keep-alive progress updates during build
    let keepAliveStep = 0;
    const buildingMessages = [
        '🔨 Compiling Dart code...',
        '⚙️ Processing resources...',
        '📦 Packaging APK...',
        '🔧 Optimizing assets...',
        '🚀 Building native code...',
        '📱 Generating APK bundle...'
    ];

    const keepAliveInterval = setInterval(() => {
        keepAliveStep++;
        const message = buildingMessages[keepAliveStep % buildingMessages.length];
        onProgress(message);
    }, 15000); // Update every 15 seconds

    try {
        await runCommand('flutter', buildArgs, projectDir, (output) => {
            // Pass real output to progress callback
            if (output && output.trim()) {
                onProgress(output);
            }
        });
    } finally {
        clearInterval(keepAliveInterval);
    }

    onProgress('✅ Build complete! Locating APK...');

    // Find APK
    const apkDir = path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk');
    const apkName = buildType === 'release' ? 'app-release.apk' : 'app-debug.apk';
    const apkPath = path.join(apkDir, apkName);

    if (!await fs.pathExists(apkPath)) {
        throw new Error('APK file not found after build');
    }

    // Copy to output
    const outputDir = path.join(__dirname, '..', '..', 'output');
    await fs.ensureDir(outputDir);
    const finalPath = path.join(outputDir, `flutter_${Date.now()}.apk`);
    await fs.copy(apkPath, finalPath);

    return finalPath;
}

/**
 * Build Android (Gradle) project
 */
async function buildAndroid(projectDir, buildType, onProgress) {
    const isWindows = process.platform === 'win32';
    const gradleCmd = isWindows ? 'gradlew.bat' : './gradlew';
    const gradlePath = path.join(projectDir, gradleCmd);

    // Check if gradlew exists, if not use global gradle
    let useGlobalGradle = false;
    if (!await fs.pathExists(gradlePath)) {
        useGlobalGradle = true;
    } else if (!isWindows) {
        // Make gradlew executable on Unix
        await fs.chmod(gradlePath, '755');
    }

    onProgress('🔨 Running Gradle build...');
    const buildTask = buildType === 'release' ? 'assembleRelease' : 'assembleDebug';

    // Standard build flags for VPS/Desktop
    const gradleFlags = [
        buildTask,
        '--no-daemon',
        '--no-watch-fs',
        '--no-build-cache',
        '-Dorg.gradle.native=false',
        '--stacktrace'
    ];

    if (useGlobalGradle) {
        await runCommand('gradle', gradleFlags, projectDir);
    } else {
        await runCommand(gradlePath, gradleFlags, projectDir);
    }

    // Find APK
    onProgress('📦 Locating APK file...');
    const apkPath = await findApk(projectDir, buildType);

    if (!apkPath) {
        throw new Error('APK file not found after build');
    }

    // Copy to output
    const outputDir = path.join(__dirname, '..', '..', 'output');
    await fs.ensureDir(outputDir);
    const finalPath = path.join(outputDir, `android_${Date.now()}.apk`);
    await fs.copy(apkPath, finalPath);

    return finalPath;
}

/**
 * Find APK file in build outputs
 */
async function findApk(projectDir, buildType) {
    const possiblePaths = [
        path.join(projectDir, 'app', 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`),
        path.join(projectDir, 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`),
        path.join(projectDir, 'app', 'build', 'outputs', 'apk', buildType, 'app-debug.apk'),
        path.join(projectDir, 'build', 'outputs', 'apk', buildType, 'app-debug.apk'),
    ];

    for (const p of possiblePaths) {
        if (await fs.pathExists(p)) {
            return p;
        }
    }

    // Recursive search as fallback
    return await findFileRecursive(projectDir, '.apk');
}

/**
 * Recursive file search
 */
async function findFileRecursive(dir, ext, maxDepth = 5, depth = 0) {
    if (depth > maxDepth) return null;

    try {
        const items = await fs.readdir(dir);
        for (const item of items) {
            const itemPath = path.join(dir, item);
            const stat = await fs.stat(itemPath);

            if (stat.isFile() && item.endsWith(ext)) {
                return itemPath;
            }

            if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
                const found = await findFileRecursive(itemPath, ext, maxDepth, depth + 1);
                if (found) return found;
            }
        }
    } catch (e) { }

    return null;
}

/**
 * Run command with promise
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {string} cwd - Working directory
 * @param {function} onOutput - Optional callback for streaming output
 */
function runCommand(cmd, args, cwd, onOutput = null) {
    return new Promise((resolve, reject) => {
        // Create log file for debugging
        const logDir = path.join(__dirname, '..', '..', 'logs');
        fs.ensureDirSync(logDir);
        const logFile = path.join(logDir, `build_${Date.now()}.log`);

        const proc = spawn(cmd, args, {
            cwd,
            shell: true,
            env: {
                ...process.env,
                // Increase heap memory for Flutter/Gradle builds (2GB for VPS with 8GB RAM)
                GRADLE_OPTS: '-Dorg.gradle.native=false -Dfile.encoding=UTF-8 -Xmx2048m -XX:MaxMetaspaceSize=512m',
                _JAVA_OPTIONS: '-Xmx2048m -Dfile.encoding=UTF-8',
                // Ensure NDK path is set
                ANDROID_NDK_HOME: process.env.ANDROID_NDK_HOME || '/opt/android-sdk/ndk/27.0.12077973'
            }
        });

        let stdout = '';
        let stderr = '';
        let lastActivity = Date.now();

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            fs.appendFileSync(logFile, text); // Log to file
            lastActivity = Date.now();
            if (onOutput) {
                const lines = text.split('\n').filter(l => l.trim());
                if (lines.length > 0) {
                    onOutput(lines[lines.length - 1].substring(0, 150));
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            fs.appendFileSync(logFile, '[STDERR] ' + text); // Log stderr too
            lastActivity = Date.now();
            // Also forward important stderr to progress
            if (onOutput && (text.includes('error') || text.includes('Error') || text.includes('Exception'))) {
                onOutput('[!] ' + text.substring(0, 150));
            }
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                // Extract meaningful error message from both stdout and stderr
                const allOutput = stdout + '\n' + stderr;

                // Save full output for debugging
                fs.writeFileSync(logFile + '.error', allOutput);
                console.log(`[DEBUG] Full error log saved to: ${logFile}.error`);

                // Better error extraction - look for more patterns
                const errorPatterns = [
                    /FAILURE:.*$/gm,
                    /error:.*$/gmi,
                    /Error:.*$/gm,
                    /Exception:.*$/gm,
                    /\* What went wrong:[\s\S]*?(?=\* Try:|\* Get more help|$)/gm,
                    /Could not.*$/gmi,
                    /Cannot.*$/gmi,
                    /failed.*$/gmi,
                    /not found.*$/gmi
                ];

                let errorLines = [];
                for (const pattern of errorPatterns) {
                    const matches = allOutput.match(pattern);
                    if (matches) {
                        errorLines.push(...matches);
                    }
                }

                // Remove duplicates and limit
                errorLines = [...new Set(errorLines)].slice(0, 10);

                let errorMsg;
                if (errorLines.length > 0) {
                    errorMsg = errorLines.join('\n');
                } else {
                    // Get last 20 lines as fallback
                    const lastLines = allOutput.split('\n').filter(l => l.trim()).slice(-20);
                    errorMsg = lastLines.join('\n') || `Build failed with code ${code}`;
                }

                // Include log file path in error
                errorMsg = errorMsg.substring(0, 1500) + `\n\n[Debug log: ${logFile}.error]`;
                reject(new Error(errorMsg));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });

        // Timeout after 30 minutes (increased from 10)
        const TIMEOUT_MS = 30 * 60 * 1000;
        const timeoutCheck = setInterval(() => {
            if (Date.now() - lastActivity > TIMEOUT_MS) {
                clearInterval(timeoutCheck);
                proc.kill();
                reject(new Error('Build timeout (30 minutes of inactivity)'));
            }
        }, 60000); // Check every minute

        proc.on('close', () => clearInterval(timeoutCheck));
    });
}

module.exports = { buildFromZip };
