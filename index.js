import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import NodeCache from 'node-cache';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import FormData from 'form-data';
import boxen from 'boxen';
import chalkTemplate from 'chalk-template';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execPromise = promisify(exec);
const cache = new NodeCache({ stdTTL: 21600, checkperiod: 600 });
const progressCache = new Map(); // Store download progress

// CONFIG FROM ENV
const TELE_TOKEN = process.env.TELE_TOKEN;
const TELE_CHAT_ID = process.env.TELE_CHAT_ID;

// COOKIES SUPPORT
const cookieFile = path.join(__dirname, 'cookies.txt');
const getCookieArg = () => fs.existsSync(cookieFile) ? `--cookies "${cookieFile}"` : '';

// STATIC BASE URL HELPER
const getPublicUrl = (request) => {
    if (process.env.RAILWAY_STATIC_URL) return `https://${process.env.RAILWAY_STATIC_URL}`;
    const protocol = request.headers['x-forwarded-proto'] || request.protocol || 'http';
    const host = request.headers.host || `${request.hostname}:7000`;
    return `${protocol}://${host}`;
};

// Jika di deploy, ganti ini di .env backend
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || '';

const fastify = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 104857600 // 100MB global limit
});

// Register Plugins
await fastify.register(cors, { origin: true });
await fastify.register(multipart, {
    limits: {
        fileSize: 104857600, // 100MB file size limit
        fieldSize: 104857600  // 100MB field size limit
    }
});

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

await fastify.register(fastifyStatic, {
    root: tempDir,
    prefix: '/temp/',
});

// CLEANUP: Hapus total setiap 12 jam
setInterval(() => {
    console.log('🧹 Running 12-hour total cleanup for temp files...');
    fs.readdir(tempDir, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            fs.unlink(filePath, () => { });
        });
    });
}, 12 * 60 * 60 * 1000);

// API CONFIG FOR FRONTEND (Hanya untuk info port atau metadata lain)
fastify.get('/api/config', async () => {
    return {
        LOCAL_PORT: process.env.PORT || 7000
    };
});

// PROGRESS POLLING ENDPOINT
fastify.get('/api/progress', async (request, reply) => {
    const { taskId } = request.query;
    if (!taskId) return { progress: 0 };
    return progressCache.get(taskId) || { progress: 0, status: 'unknown' };
});

// PREPARE DOWNLOAD ENDPOINT
fastify.get('/api/prepare', async (request, reply) => {
    const { url, h } = request.query;
    if (!url || !h) return reply.status(400).send({ error: 'url_and_h_required' });

    const taskId = h;
    const outPath = path.join(tempDir, `${taskId}_final.mp4`);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1048576) {
        return { taskId, progress: 100, status: 'done' };
    }

    if (progressCache.has(taskId) && progressCache.get(taskId).status === 'downloading') {
        return { taskId, progress: progressCache.get(taskId).progress, status: 'downloading' };
    }

    // Start background download
    progressCache.set(taskId, { progress: 0, status: 'downloading' });

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    const isInsta = url.includes('instagram.com');
    const bReferer = isInsta ? 'https://www.instagram.com/' : 'https://www.tiktok.com/';

    const args = [];
    if (fs.existsSync(cookieFile)) {
        args.push('--cookies', cookieFile);
    }

    args.push(
        '--user-agent', userAgent,
        '--add-header', `Referer:${bReferer}`,
        '--add-header', 'Origin:https://www.instagram.com',
        '--add-header', 'sec-ch-ua-mobile:?0',
        '--add-header', 'sec-ch-ua-platform:Windows',
        // Try single file MP4 first for IG to avoid merging failures
        '-f', isInsta ? 'b[ext=mp4]/best' : 'bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--no-playlist', '--no-check-certificates', '--no-cache-dir', '--abort-on-error',
        '-o', outPath,
        url
    );

    const child = spawn('yt-dlp', args);

    child.stdout.on('data', (data) => {
        const output = data.toString();
        // Regex to match [download] 45.5% of 12.34MiB at 1.23MiB/s
        const match = output.match(/(\d+\.\d+)%/);
        if (match) {
            const progress = parseFloat(match[1]);
            progressCache.set(taskId, { progress, status: 'downloading' });
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`yt-dlp stderr: ${data}`);
    });

    child.on('close', (code) => {
        if (code === 0) {
            progressCache.set(taskId, { progress: 100, status: 'done' });
        } else {
            progressCache.set(taskId, { progress: 0, status: 'error', error: 'Process failed' });
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        }
    });

    return { taskId, progress: 0, status: 'downloading' };
});

// API REPORT BUG TO TELEGRAM
fastify.post('/api/report', async (request, reply) => {
    try {
        const parts = request.parts();
        let message = '';
        let fileBuffer = null;
        let fileName = '';

        for await (const part of parts) {
            if (part.file) {
                fileBuffer = await part.toBuffer();
                fileName = part.filename;
            } else {
                if (part.fieldname === 'message') message = part.value;
            }
        }

        const teleMsg = `🚨 *BUG REPORT*\n\n📝 *Pesan:* ${message}\n⏰ *Waktu:* ${new Date().toLocaleString()}`;

        if (fileBuffer) {
            const form = new FormData();
            form.append('chat_id', TELE_CHAT_ID);
            form.append('caption', teleMsg);
            form.append('parse_mode', 'Markdown');
            form.append('photo', fileBuffer, { filename: fileName });

            await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
        } else {
            await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/sendMessage`, {
                chat_id: TELE_CHAT_ID,
                text: teleMsg,
                parse_mode: 'Markdown'
            });
        }

        return { success: true, message: 'Laporan bug berhasil dikirim!' };
    } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ success: false, error: err.message });
    }
});

const downloadSchema = z.object({
    url: z.string().url()
});

// TIKTOK FALLBACK API (TikWM)
async function fetchTikTokFallback(url) {
    try {
        const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
        const data = res.data;
        if (data.code !== 0 || !data.data) return null;

        const info = data.data;
        return {
            id: info.id,
            title: info.title || 'TikTok Video',
            thumbnail: info.cover,
            uploader: info.author.nickname || info.author.unique_id,
            duration: info.duration ? `${Math.floor(info.duration / 60)}:${(info.duration % 60).toString().padStart(2, '0')}` : '00:00',
            platform: 'TikTok (Fallback)',
            download_url: info.play || info.hdplay,
            merge_required: false,
            media: {
                all_formats: [
                    { id: 'hd', ext: 'mp4', resolution: 'HD (No Watermark)', url: info.hdplay || info.play },
                    { id: 'sd', ext: 'mp4', resolution: 'Watermarked', url: info.wmplay },
                    { id: 'music', ext: 'mp3', resolution: 'Audio Only', url: info.music }
                ]
            },
            metadata: {
                views: info.play_count || 0,
                likes: info.digg_count || 0,
                comments: info.comment_count || 0
            },
            _forceProxy: true // Fallback usually needs proxy to bypass local blocks
        };
    } catch (e) {
        return null;
    }
}

// INSTAGRAM FALLBACK API (Using multiple robust public sources)
async function fetchInstagramFallback(url) {
    // Sources to try in order
    const sources = [
        {
            name: 'VkrDown',
            url: `https://api.vkrdown.com/insta/?url=${encodeURIComponent(url)}`,
            headers: { 'Referer': 'https://vkrdown.com/' }
        },
        {
            name: 'SnapInsta',
            url: `https://api.snapinsta.app/info?url=${encodeURIComponent(url)}`,
            headers: { 'Referer': 'https://snapinsta.app/' }
        },
        {
            name: 'SaveIG',
            url: `https://saveig.app/api/info?url=${encodeURIComponent(url)}`,
            headers: { 'Referer': 'https://saveig.app/' }
        }
    ];

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

    for (const source of sources) {
        try {
            console.log(`Trying Instagram fallback: ${source.name}...`);
            const res = await axios.get(source.url, {
                headers: { ...source.headers, 'User-Agent': userAgent },
                timeout: 10000
            });
            const data = res.data;

            // Normalize data based on source
            let results = [];
            let title = 'Instagram Media';
            let thumb = '';

            if (source.name === 'VkrDown' && data.data) {
                results = data.data.map(m => ({ url: m.url, type: m.type }));
            } else if (source.name === 'SnapInsta' && data.data) {
                results = data.data;
            } else if (source.name === 'SaveIG' && data.data) {
                results = data.data;
            }

            results = results.filter(r => r && r.url);
            if (results.length === 0) continue;

            const mainMedia = results[0];
            const isPhoto = mainMedia.type === 'photo' || mainMedia.url?.includes('.jpg') || mainMedia.url?.includes('.webp');

            return {
                id: `ig_${Date.now()}`,
                title: title || (isPhoto ? 'Instagram Photo' : 'Instagram Video'),
                thumbnail: thumb || mainMedia.url || mainMedia.thumb,
                uploader: 'Instagram User',
                duration: '00:00',
                platform: isPhoto ? 'Instagram Photo/Slide' : 'Instagram (Fallback)',
                download_url: mainMedia.url,
                merge_required: false,
                media: {
                    all_formats: results.map((m, i) => {
                        const isImg = m.type === 'photo' || m.url?.includes('.jpg') || m.url?.includes('.webp');
                        return {
                            id: `ig_${i}`,
                            ext: isImg ? 'jpg' : 'mp4',
                            vcodec: isImg ? 'image' : 'h264',
                            resolution: m.type === 'photo' ? `Slide ${i + 1}` : `Video ${i + 1}`,
                            url: m.url
                        };
                    })
                },
                metadata: { views: 0, likes: 0, comments: 0 },
                _forceProxy: true
            };
        } catch (e) {
            console.error(`Instagram Fallback ${source.name} failed:`, e.message);
            continue;
        }
    }
    return null;
}

fastify.get('/api/download', async (request, reply) => {
    const result = downloadSchema.safeParse(request.query);
    if (!result.success) return reply.status(400).send({ error: 'invalid_url' });

    let { url } = result.data;

    // Clean TikTok URLs (remove tracking/webapp params that can cause extraction failure)
    if (url.includes('tiktok.com')) {
        const urlObj = new URL(url);
        // Only keep the essential part of the path
        url = `${urlObj.origin}${urlObj.pathname}`;
    }

    const cached = cache.get(url);
    let response;

    if (cached) {
        response = JSON.parse(JSON.stringify(cached)); // Deep clone to avoid mutating cache
    } else {
        try {
            // Stage 1: Get metadata and format info
            const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
            const isInstaUrl = url.includes('instagram.com');
            const referer = isInstaUrl ? 'https://www.instagram.com/' : 'https://www.tiktok.com/';

            const cmd = `yt-dlp ${getCookieArg()} --user-agent "${userAgent}" --add-header "Referer:${referer}" --dump-json --no-playlist --no-check-certificates "${url}"`;

            const { stdout } = await execPromise(cmd);
            const metadata = JSON.parse(stdout);

            let thumbnail = metadata.thumbnail;
            if (metadata.thumbnails && metadata.thumbnails.length > 0) {
                thumbnail = metadata.thumbnails[metadata.thumbnails.length - 1].url;
            }

            const formats = (metadata.formats || []).map(f => ({
                id: f.format_id,
                ext: f.ext,
                vcodec: f.vcodec,
                acodec: f.acodec,
                url: f.url,
                resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : null),
                filesize: f.filesize || f.filesize_approx
            }));

            const isTikTok = metadata.extractor_key?.toLowerCase().includes('tiktok');
            const isInstaExt = metadata.extractor_key?.toLowerCase().includes('instagram');

            // Look for best format that already has both audio and video
            let bestCombined = formats.find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url && f.ext === 'mp4');
            if (!bestCombined) bestCombined = formats.find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url);

            let forceProxy = isTikTok || (isInstaExt && !bestCombined);

            response = {
                id: metadata.id,
                title: metadata.title,
                thumbnail: thumbnail,
                uploader: metadata.uploader || metadata.uploader_id || metadata.webpage_url_domain || 'Social Media',
                duration: metadata.duration_string || '00:00',
                platform: metadata.extractor_key,
                download_url: bestCombined?.url || null,
                merge_required: bestCombined ? false : true,
                media: { all_formats: formats.reverse() },
                metadata: {
                    views: metadata.view_count || 0,
                    likes: metadata.like_count || 0,
                    comments: metadata.comment_count || 0
                },
                _forceProxy: forceProxy
            };

            cache.set(url, response);
        } catch (err) {
            // SMART FALLBACK FOR TIKTOK & INSTAGRAM
            const isNoVideoErr = err.message.includes('There is no video in this post');

            if (url.includes('tiktok.com')) {
                const fallback = await fetchTikTokFallback(url);
                if (fallback) { cache.set(url, fallback); return fallback; }
            } else if (url.includes('instagram.com') || isNoVideoErr) {
                const fallback = await fetchInstagramFallback(url);
                if (fallback) { cache.set(url, fallback); return fallback; }
            }

            let userMsg = err.message;
            if (userMsg.includes('Log in for access')) {
                userMsg = 'TikTok memproduksi blokir akses. Kami sudah mencoba fallback tapi gagal. Silakan coba video lain atau tambahkan cookies.txt.';
            } else if (isNoVideoErr) {
                userMsg = 'Konten ini sepertinya berupa Gambar/Slide, dan server gagal mengambil datanya. Silakan coba beberapa saat lagi.';
            }
            return reply.status(500).send({ error: 'extraction_failed', message: userMsg });
        }
    }

    const publicUrl = getPublicUrl(request);

    // FIX BROKEN THUMBNAILS (Proxy Instagram/FB thumbnails to bypass hotlinking protection)
    const isSensitiveThumb = response.thumbnail && (
        response.thumbnail.includes('fbcdn.net') ||
        response.thumbnail.includes('instagram.com') ||
        response.thumbnail.includes('cdninstagram.com')
    );

    if (isSensitiveThumb && !response.thumbnail.includes('/api/proxy-img')) {
        response.thumbnail = `${publicUrl}/api/proxy-img?url=${encodeURIComponent(response.thumbnail)}`;
    }

    // ALWAYS generate a fresh unique hash for the download URL, even if metadata is cached
    if (response.merge_required || response._forceProxy) {
        const uniqueHash = Buffer.from(url + Date.now() + Math.random()).toString('hex').slice(0, 15);
        response.download_url = `${publicUrl}/api/proxy?url=${encodeURIComponent(url)}&h=${uniqueHash}`;
    }

    return response;
});

fastify.get('/api/proxy', async (request, reply) => {
    const { url, h } = request.query;
    if (!url) return reply.status(400).send('URL required');

    const fileId = h || Buffer.from(url).toString('hex').slice(0, 12);
    const outPath = path.join(tempDir, `${fileId}_final.mp4`);

    try {
        const streamFile = (fPath, name) => {
            const stream = fs.createReadStream(fPath);
            reply.header('Content-Type', 'video/mp4');
            reply.header('Content-Disposition', `attachment; filename="${name}"`);
            reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            reply.header('Pragma', 'no-cache');
            reply.header('Expires', '0');

            stream.on('close', () => {
                // Keep the file for a bit so multiple rapid clicks work, 
                // but let the interval cleanup handle it or delete after 1 min
                setTimeout(() => {
                    try { if (fs.existsSync(fPath)) fs.unlinkSync(fPath); } catch (e) { }
                }, 60000);
            });
            return reply.send(stream);
        };

        // IF FILE ALREADY PREPARED (from /api/prepare), JUST SEND IT!
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1048576) {
            return streamFile(outPath, `Fetcher_${Date.now()}.mp4`);
        }

        // Otherwise, do the normal flow (Hapus file lama jika ada)
        if (fs.existsSync(outPath)) {
            try { fs.unlinkSync(outPath); } catch (e) { }
        }

        // --- NEW ROBUST HEADERS FOR TIKTOK ---
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

        // Simplified header to avoid complex shell quoting issues
        const cmd = `yt-dlp ${getCookieArg()} --user-agent "${userAgent}" ` +
            `--add-header "Referer:https://www.tiktok.com/" ` +
            `--add-header "sec-ch-ua-mobile:?0" ` +
            `--add-header "sec-ch-ua-platform:Windows" ` +
            `-f "bestvideo+bestaudio/best" ` +
            `--merge-output-format mp4 ` +
            `--no-playlist --no-check-certificates --no-cache-dir --abort-on-error ` +
            `-o "${outPath}" "${url}"`;

        await execPromise(cmd, { timeout: 180000 });

        if (fs.existsSync(outPath)) {
            const stats = fs.statSync(outPath);
            if (stats.size < 1000000) {
                const buffer = fs.readFileSync(outPath).slice(0, 2000).toString();
                if (buffer.includes('<html') || buffer.includes('Access Denied')) {
                    fs.unlinkSync(outPath);
                    throw new Error("TikTok Security Block (763KB Error). Coba lagi beberapa saat lagi.");
                }
            }
            return streamFile(outPath, `Fetcher_${Date.now()}.mp4`);
        } else {
            throw new Error("Download failed - File not created");
        }
    } catch (err) {
        return reply.status(500).send(`Failed to process video: ${err.message}`);
    }
});

// IMAGE PROXY ENDPOINT (To bypass Instagram hotlinking protection)
fastify.get('/api/proxy-img', async (request, reply) => {
    const { url } = request.query;
    if (!url) return reply.status(400).send('URL required');

    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/'
            }
        });

        reply.header('Content-Type', res.headers['content-type'] || 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        return reply.send(Buffer.from(res.data));
    } catch (e) {
        return reply.status(500).send('Failed to proxy image');
    }
});

const start = async () => {
    try {
        const port = process.env.PORT || 7000;
        await fastify.listen({ port, host: '0.0.0.0' });

        // PREMIUM SERVING LOG (LIKE THE SCREENSHOT)
        const localLink = `http://localhost:${port}`;
        const networkLink = `http://192.168.10.199:${port}`; // Shared IP from context

        const message = chalkTemplate`
{bold.cyan Serving!}

- {bold Local:}    {underline ${localLink}}
- {bold Network:}  {underline ${networkLink}}

{gray.italic Copied local address to clipboard!}`;

        console.log(boxen(message, {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'cyan',
            float: 'left'
        }));

    } catch (err) {
        console.error('❌ Error starting server:', err);
        process.exit(1);
    }
};
start();
