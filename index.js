// Impor modul yang diperlukan
const { Client } = require('discord.js-selfbot-v13');
const express = require('express');
const morgan = require('morgan');
const logger = require('./logger'); // Asumsikan logger.js ada

// --- KONFIGURASI ---
const TOKEN = '';
const VOICE_CHANNEL_ID = '1266339814932873278';
const PORT = process.env.PORT || 3030;

const CHANNELS = {
    sita: '775719555628662794',
    sim: '775719273905258496',
    stnk: '775719070669996042',
    penilangan: '848713902656192563',
    pengeluaran: '985074666240626719',
    impound: '1113654296395907122'
};

// --- INISIALISASI ---
const app = express();
const client = new Client({ checkUpdate: false });

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' })); // Naikkan limit untuk menampung data member
app.use(morgan('short', { stream: logger.stream }));

// --- FUNGSI BANTUAN ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- FUNGSI fetchAllMessagesBetween DENGAN CALLBACK PROGRESS ---
async function fetchAllMessagesBetween(channel, afterDate, beforeDate, onProgress) {
    let allMessages = [];
    let lastId = null;
    let batchNumber = 1;
    const BATCH_LIMIT = 100;

    while (true) {
        try {
            await delay(100); // Penundaan untuk menghindari rate limit

            const options = { limit: BATCH_LIMIT, before: lastId || undefined };
            
            logger.debug(`Fetching messages in #${channel.name}, batch ${batchNumber}, before ID: ${lastId || 'start'}`);
            // Panggil callback untuk memberitahu bahwa request dimulai
            onProgress({ type: 'FETCHING_BATCH', batch: batchNumber });
            const messages = await channel.messages.fetch(options);
            
            // Panggil callback dengan hasil batch
            onProgress({ type: 'FETCH_COMPLETE', batch: batchNumber, count: messages.size });

            if (messages.size === 0) break;

            messages.forEach(msg => {
                const msgDate = new Date(msg.createdAt);
                if (msgDate >= afterDate && msgDate <= beforeDate) {
                    allMessages.push(msg);
                }
            });
            
            // Panggil callback dengan total pesan yang terkumpul
            onProgress({ type: 'MESSAGES_ACCUMULATED', total: allMessages.length });

            const oldestMessage = messages.last();
            if (!oldestMessage || new Date(oldestMessage.createdAt) < afterDate) {
                logger.debug(`Reached 'afterDate' limit in #${channel.name}. Stopping fetch.`);
                break; 
            }
            lastId = oldestMessage.id;
            batchNumber++;
        } catch (error) {
            if (error.code === 50001) { // Missing Access
                logger.error(`Missing access to channel #${channel.name} (${channel.id}). Skipping.`);
                onProgress({ type: 'ERROR', message: `Tidak ada akses ke #${channel.name}` });
                break;
            }
            logger.error(`Error fetching messages from #${channel.name}`, { 
                channelId: channel.id, 
                error: error.message,
                stack: error.stack
            });
            onProgress({ type: 'ERROR', message: `Error saat mengambil data dari #${channel.name}` });
            logger.info('Waiting for 5 seconds before retrying...');
            await delay(5000);
        }
    }
    return allMessages;
}


// --- RUTE API UTAMA UNTUK STREAMING ---

app.post('/api/discord/sync-stream', async (req, res) => {
    // 1. Set header untuk Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Kirim header segera

    // Fungsi helper untuk mengirim event ke client
    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const { startDate, endDate, members } = req.body;
        
        if (!startDate || !endDate) {
            sendEvent({ status: 'error', message: 'Start Date and End Date are required.' });
            return res.end();
        }
        if (!members || !Array.isArray(members)) {
            sendEvent({ status: 'error', message: 'Member list is missing or invalid in the request.' });
            return res.end();
        }

        const afterDate = new Date(startDate);
        afterDate.setHours(0, 0, 0, 0);

        const beforeDate = new Date(endDate);
        beforeDate.setHours(23, 59, 59, 999);
        
        if (members.length === 0) {
            sendEvent({ status: 'done', message: 'Sync complete. No members to process.' });
            return res.end();
        }

        const officerNames = members.map(m => strtoupper(m.nama));
        const authorIds = members.map(m => m.id);

        const endpoints = [
            { name: 'SIM', path: 'sim', type: 'content', data: officerNames },
            { name: 'STNK', path: 'stnk', type: 'content', data: officerNames },
            { name: 'SITA', path: 'sita', type: 'author', data: authorIds },
            { name: 'PENILANGAN', path: 'penilangan', type: 'author', data: authorIds },
            { name: 'IMPOUND', path: 'impound', type: 'author', data: authorIds },
            { name: 'PENGELUARAN', path: 'pengeluaran', type: 'author', data: authorIds },
        ];
        
        // --- PROSES LOOP UTAMA DENGAN LOGIKA CALLBACK ---
        for (let i = 0; i < endpoints.length; i++) {
            const endpoint = endpoints[i];
            const baseProgress = (i / endpoints.length) * 100;
            const fetchingProgressWeight = (100 / endpoints.length) * 0.4; // 40% dari porsi progress untuk fetching
            const filteringProgressWeight = (100 / endpoints.length) * 0.5; // 50% untuk filtering

            const channelId = CHANNELS[endpoint.path];
            if (!channelId) {
                logger.warn(`Channel path '${endpoint.path}' not found in configuration. Skipping.`);
                continue;
            }
            
            const channel = await client.channels.fetch(channelId);
            
            sendEvent({ 
                status: 'progress', 
                message: `[${i + 1}/${endpoints.length}] Memulai dari #${channel.name}...`, 
                progress: baseProgress 
            });
            logger.info(`Processing ${endpoint.name} for channel #${channel.name}`);
            
            // Definisikan callback 'onProgress' yang akan dipanggil oleh fetchAllMessagesBetween
            const onFetchProgress = (update) => {
                let message = '';
                switch(update.type) {
                    case 'FETCHING_BATCH':
                        message = `[#${channel.name}] Request batch ke-${update.batch}...`;
                        break;
                    case 'FETCH_COMPLETE':
                        message = `[#${channel.name}] Batch ke-${update.batch} selesai. Ditemukan ${update.count} pesan.`;
                        break;
                    case 'MESSAGES_ACCUMULATED':
                        message = `[#${channel.name}] Total pesan terkumpul: ${update.total}.`;
                        break;
                    case 'ERROR':
                        message = update.message;
                        break;
                }
                sendEvent({
                    status: 'progress',
                    message: message,
                    progress: baseProgress + fetchingProgressWeight // Progress tetap selama fetching
                });
            };

            const allMessages = await fetchAllMessagesBetween(channel, afterDate, beforeDate, onFetchProgress);
            logger.info(`Fetched ${allMessages.length} total messages from #${channel.name}.`);

            const results = {};
            const totalMessages = allMessages.length;

            if (totalMessages > 0) {
                sendEvent({ 
                    status: 'progress', 
                    message: `Memulai filter untuk ${totalMessages} pesan dari #${channel.name}...`, 
                    progress: baseProgress + fetchingProgressWeight
                });
                
                // --- PERUBAHAN UTAMA: LOGIKA DELAY YANG BARU ---
                const TARGET_FILTER_TIME = 1000; // Target waktu filter adalah 1 detik
                const MESSAGE_THRESHOLD = 200; // Batas jumlah pesan
                const MAX_ACCEPTABLE_DELAY = 50; // Jeda maksimal per update agar tidak terasa lambat
                
                let delayPerMessage;

                if (totalMessages >= MESSAGE_THRESHOLD) {
                    // Jika pesan 200 atau lebih, paksa total waktu menjadi 5 detik
                    delayPerMessage = TARGET_FILTER_TIME / totalMessages;
                } else {
                    // Jika pesan kurang dari 200, biarkan cepat tapi tidak lebih lambat dari 100ms per update
                    const idealDelay = TARGET_FILTER_TIME / totalMessages;
                    delayPerMessage = Math.min(idealDelay, MAX_ACCEPTABLE_DELAY);
                }

                if (endpoint.type === 'content') {
                    const officerNameMap = new Map(officerNames.map(name => [name.toLowerCase().trim(), name]));
                    for (let j = 0; j < totalMessages; j++) {
                        const m = allMessages[j];
                        const content = m.content.toLowerCase();
                        const match = content.match(/petugas\s*:\s*([a-z\s\d\.\_\[\]]+)/);
                        if (match && match[1]) {
                            const petugasName = match[1].trim();
                            if (officerNameMap.has(petugasName)) {
                                const originalOfficerName = officerNameMap.get(petugasName);
                                if (!results[originalOfficerName]) results[originalOfficerName] = { count: 0, messages: [] };
                                results[originalOfficerName].count++;
                                results[originalOfficerName].messages.push({ id: m.id, content: m.content, createdAt: m.createdAt.toISOString(), link: m.url });
                            }
                        }

                        // Kirim update di setiap perulangan
                        const filteringProgress = ((j + 1) / totalMessages);
                        const overallProgress = (baseProgress + fetchingProgressWeight) + (filteringProgress * filteringProgressWeight);
                        sendEvent({
                            status: 'progress', message: `Memfilter #${channel.name}: ${j + 1}/${totalMessages}`,
                            progress: overallProgress
                        });
                        await delay(delayPerMessage); // Gunakan delay yang sudah dihitung
                    }
                } else { // type 'author'
                    const authorIdMap = new Map(members.map(m => [m.id, m.nama]));
                    for (let j = 0; j < totalMessages; j++) {
                        const m = allMessages[j];
                        if (authorIdMap.has(m.author.id)) {
                            const memberName = authorIdMap.get(m.author.id);
                            if (!results[memberName]) results[memberName] = { count: 0, messages: [] };
                            results[memberName].count++;
                            results[memberName].messages.push({ id: m.id, content: m.content, createdAt: m.createdAt.toISOString(), link: m.url });
                        }
                        
                        // Kirim update di setiap perulangan
                        const filteringProgress = ((j + 1) / totalMessages);
                        const overallProgress = (baseProgress + fetchingProgressWeight) + (filteringProgress * filteringProgressWeight);
                        sendEvent({
                            status: 'progress', message: `Memfilter #${channel.name}: ${j + 1}/${totalMessages}`,
                            progress: overallProgress
                        });
                        await delay(delayPerMessage); // Gunakan delay yang sudah dihitung
                    }
                }
            }
            
            const finalChannelProgress = (i + 1) / endpoints.length * 100;
            const reportsFoundCount = Object.values(results).reduce((sum, member) => sum + member.count, 0);
            
            sendEvent({ 
                status: 'progress', 
                message: `Selesai #${channel.name}. Ditemukan ${reportsFoundCount} laporan relevan.`, 
                progress: finalChannelProgress
            });

            sendEvent({ status: 'result', payload: { name: endpoint.name, data: results } });
            await delay(200);
        }
        
        sendEvent({ status: 'done', message: 'Sinkronisasi selesai!', progress: 100 });

    } catch (error) {
        logger.error(`API Stream Error`, { error: error.message, stack: error.stack });
        sendEvent({ status: 'error', message: 'An internal server error occurred during sync.' });
    } finally {
        res.end();
    }
});


// --- EVENT DISCORD CLIENT ---
client.on('ready', async () => {
    logger.info(`Logged in to Discord as ${client.user.username} (${client.user.id})`);
    try {
        const voiceChannel = await client.channels.fetch(VOICE_CHANNEL_ID);
        if (voiceChannel && voiceChannel.isVoice()) {
            await client.voice.joinChannel(voiceChannel, { selfMute: true, selfDeaf: true });
            logger.info(`Successfully joined voice channel: ${voiceChannel.name}`);
        } else {
            logger.warn(`Voice channel with ID ${VOICE_CHANNEL_ID} not found or is not a voice channel.`);
        }
    } catch (error) {
        logger.error('Failed to join voice channel.', { error: error.message });
    }
});

// --- PENANGANAN PROSES & LOGIN ---
const cleanup = () => {
    logger.info('Disconnecting from Discord and shutting down...');
    client.destroy();
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

client.login(TOKEN).catch(error => {
    logger.error('Failed to login to Discord.', { message: error.message });
    if (error.message.includes('TOKEN_INVALID')) {
        logger.error('--- The provided token is invalid. Please check it. ---');
    }
    process.exit(1);
});

// Jalankan server setelah client siap
client.once('ready', () => {
    app.listen(PORT, () => logger.info(`🚀 API server is running on http://localhost:${PORT}`));
});

// Helper function, karena strtoupper tidak ada di JS
function strtoupper(str) {
    return str.toUpperCase();
}
