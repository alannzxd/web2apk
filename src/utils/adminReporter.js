/**
 * Admin Reporter - Mengirim laporan ke owner setiap ada aktivitas
 */

async function sendBuildReport(bot, userData, appData) {
    const ownerId = process.env.ADMIN_IDS?.split(',')[0];
    if (!ownerId) return;

    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    const reportMsg = `
🔔 <b>BUILD REPORT</b>
━━━━━━━━━━━━━━━━━━
👤 <b>User:</b>
• ID: <code>${userData.id}</code>
• Name: ${userData.name || 'Unknown'}
• Username: ${userData.username ? '@' + userData.username : '-'}

📱 <b>Application:</b>
• Name: <b>${appData.appName}</b>
• URL: <code>${appData.url}</code>
• Color: ${appData.themeColor}

⏱ <b>Time:</b> ${timestamp}
━━━━━━━━━━━━━━━━━━
✅ <i>Build Completed Successfully</i>
`.trim();

    try {
        await bot.sendMessage(ownerId, reportMsg, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error('Failed to send admin report:', e.message);
    }
}

module.exports = { sendBuildReport };
