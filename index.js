import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { exec } from 'child_process';
import { promisify } from 'util';
import NodeCache from 'node-cache';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execPromise = promisify(exec);
const cache = new NodeCache({ stdTTL: 21600, checkperiod: 600 });

const fastify = Fastify({
    logger: true,
    trustProxy: true
});

// Register CORS
await fastify.register(cors, { origin: true });

// Register static for temp files (merged videos)
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

await fastify.register(fastifyStatic, {
    root: tempDir,
    prefix: '/temp/',
});

const downloadSchema = z.object({
    url: z.string().url()
});

// Cleanup old temp files every hour
setInterval(() => {
    const now = Date.now();
    fs.readdir(tempDir, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 3600000) { // 1 hour
                fs.unlink(filePath, () => { });
            }
        });
    });
}, 3600000);

fastify.get('/', async () => ({ status: 'operational', service: 'Social Media Downloader Merged API' }));

// Helper to sanitize filename
const sanitize = (str) => str.replace(/[^a-z0-9]/gi, '_').toLowerCase();

fastify.get('/api/download', async (request, reply) => {
    const result = downloadSchema.safeParse(request.query);
    if (!result.success) return reply.status(400).send({ error: 'invalid_url' });

    const { url } = result.data;
    const cached = cache.get(url);
    if (cached) return { ...cached, _cached: true };

    try {
        // Stage 1: Get metadata and format info
        const { stdout } = await execPromise(`yt-dlp --dump-json --no-playlist "${url}"`);
        const metadata = JSON.parse(stdout);

        // Filter formats to find best video and best audio
        // For many sites (like YouTube), 1080p+ are usually separate (vcodec only)
        const formats = (metadata.formats || []).map(f => ({
            id: f.format_id,
            ext: f.ext,
            vcodec: f.vcodec,
            acodec: f.acodec,
            url: f.url,
            resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : null),
            filesize: f.filesize || f.filesize_approx
        }));

        // Find "best" direct link (already has audio + video)
        const bestCombined = formats.find(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url);

        // Find best video (might be video-only) and best audio
        const bestVideo = formats.filter(f => f.vcodec !== 'none').sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
        const bestAudio = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none').sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

        const response = {
            id: metadata.id,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            uploader: metadata.uploader || metadata.uploader_id || 'Platform Media',
            duration: metadata.duration_string || '00:00',
            platform: metadata.extractor_key,
            // Provide direct url if it exists, otherwise provide a "merge" link
            download_url: bestCombined?.url || null,
            merge_required: bestCombined ? false : true,
            media: {
                all_formats: formats.reverse()
            },
            metadata: {
                views: metadata.view_count || 0,
                likes: metadata.like_count || 0,
                comments: metadata.comment_count || 0
            }
        };

        // If no quality combined link exists, we create a proxy/merge endpoint
        if (!bestCombined) {
            // For YouTube/IG where dash formats are separate
            // We return a link to our server which handles the merging via yt-dlp on the fly
            const publicUrl = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `http://${request.hostname}`;
            response.download_url = `${publicUrl}/api/proxy?url=${encodeURIComponent(url)}`;
        }

        cache.set(url, response);
        return response;
    } catch (err) {
        return reply.status(500).send({ error: 'extraction_failed', message: err.message });
    }
});

/**
 * PROXY/MERGE ENDPOINT
 * This endpoint triggers yt-dlp to download and merge on the fly, then stream to user.
 * VERY latency intensive but ensures audio + video.
 */
fastify.get('/api/proxy', async (request, reply) => {
    const { url } = request.query;
    if (!url) return reply.status(400).send('URL required');

    const videoId = Buffer.from(url).toString('base64').slice(0, 10);
    const outPath = path.join(tempDir, `${videoId}_merged.mp4`);

    try {
        // Use yt-dlp to download and merge to a temporary file
        // -f "bestvideo+bestaudio/best" : merges automatically
        // --merge-output-format mp4
        const cmd = `yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 --no-playlist -o "${outPath}" "${url}"`;

        await execPromise(cmd, { timeout: 120000 }); // 2 min timeout for download/merge

        if (fs.existsSync(outPath)) {
            const stream = fs.createReadStream(outPath);
            reply.header('Content-Type', 'video/mp4');
            reply.header('Content-Disposition', `attachment; filename="video_${videoId}.mp4"`);
            return reply.send(stream);
        } else {
            throw new Error("Merge failed, file not found");
        }
    } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send(`Failed to process video: ${err.message}`);
    }
});

const start = async () => {
    try {
        await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    } catch (err) {
        process.exit(1);
    }
};
start();
