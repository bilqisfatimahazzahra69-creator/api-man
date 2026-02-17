import Fastify from 'fastify';
import cors from '@fastify/cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import NodeCache from 'node-cache';
import { z } from 'zod';

const execPromise = promisify(exec);
// TTL of 6 hours for high hit rate, max 1000 items to prevent OOM
const cache = new NodeCache({ stdTTL: 21600, checkperiod: 600, useClones: false });

const fastify = Fastify({
    logger: {
        level: 'info',
        serializers: {
            req: (request) => ({
                method: request.method,
                url: request.url,
                remoteAddress: request.ip
            })
        }
    },
    trustProxy: true
});

// Register CORS
await fastify.register(cors, {
    origin: true // Allow all origins for the API
});

const downloadSchema = z.object({
    url: z.string().url('Please provide a valid URL')
});

// Root endpoint with professional info
fastify.get('/', async () => {
    return {
        service: 'Social Media Downloader API',
        version: '1.1.0',
        status: 'operational',
        usage: {
            endpoint: '/api/download',
            method: 'GET',
            query_params: {
                url: 'The social media link (TikTok, Instagram, YouTube, etc.)'
            },
            example: '/api/download?url=https://www.tiktok.com/@user/video/123456789'
        },
        supported_platforms: [
            'TikTok', 'Instagram', 'YouTube', 'Twitter/X', 'Facebook', 'Threads', 'Pinterest', 'and 1000+ more'
        ]
    };
});

// Health check for Railway monitoring
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Main Download extraction endpoint
fastify.get('/api/download', async (request, reply) => {
    const result = downloadSchema.safeParse(request.query);
    if (!result.success) {
        return reply.status(400).send({
            error: 'validation_error',
            message: result.error.errors[0].message
        });
    }

    const { url } = result.data;

    // Check cache for ultra-low latency on repeated requests
    const cachedResponse = cache.get(url);
    if (cachedResponse) {
        return { ...cachedResponse, _cached: true };
    }

    try {
        /**
         * yt-dlp Flags for optimized metadata extraction:
         * --dump-json: Only metadata, no download
         * --no-playlist: Single video only
         * --no-warnings: Keep output clean
         * --prefer-free-formats: Faster muxing if needed
         * --no-check-certificates: Speed up SSL handshake
         * --youtube-skip-dash-manifest: Latency reduction for YT
         */
        const cmd = `yt-dlp --dump-json --no-playlist --no-warnings --no-check-certificates --youtube-skip-dash-manifest "${url}"`;

        const startTime = Date.now();
        const { stdout } = await execPromise(cmd, { timeout: 30000 }); // 30s timeout
        const latency = Date.now() - startTime;

        const metadata = JSON.parse(stdout);

        // Process formats for better accessibility
        const formats = (metadata.formats || [])
            .filter(f => f.url && !f.url.includes('manifest'))
            .map(f => ({
                id: f.format_id,
                ext: f.ext,
                resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : 'audio-only'),
                url: f.url,
                filesize: f.filesize || f.filesize_approx || null,
                quality: f.format_note || f.quality || null,
                vcodec: f.vcodec || 'none',
                acodec: f.acodec || 'none',
                fps: f.fps || null
            }));

        // Identify the "best" format (video + audio if possible)
        const bestFormat = formats.find(f => f.vcodec !== 'none' && f.acodec !== 'none') ||
            formats.find(f => f.vcodec !== 'none') ||
            formats[0];

        const response = {
            id: metadata.id,
            title: metadata.title,
            description: metadata.description?.slice(0, 500),
            thumbnail: metadata.thumbnail,
            duration: metadata.duration,
            duration_string: metadata.duration_string,
            uploader: metadata.uploader,
            platform: metadata.extractor_key,
            source_url: metadata.webpage_url,
            download_url: bestFormat?.url,
            media: {
                best: bestFormat,
                all_formats: formats.reverse()
            },
            metadata: {
                views: metadata.view_count,
                likes: metadata.like_count,
                comments: metadata.comment_count,
                timestamp: metadata.timestamp
            },
            _process_time: `${latency}ms`
        };

        // Cache the result
        cache.set(url, response);

        return { ...response, _cached: false };
    } catch (error) {
        fastify.log.error(`Extraction failed for ${url}: ${error.message}`);

        // Specific error mapping
        let statusCode = 500;
        let message = 'Failed to extract media. The link might be private or unsupported.';

        if (error.message.includes('not found') || error.message.includes('404')) {
            statusCode = 404;
            message = 'Video not found or link is broken.';
        } else if (error.message.includes('Sign in')) {
            statusCode = 403;
            message = 'This video requires authentication (age-restricted or private).';
        }

        return reply.status(statusCode).send({
            error: 'extraction_failed',
            message,
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Run the server
const start = async () => {
    try {
        const port = process.env.PORT || 3000;
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`🚀 Downloader API live at port ${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
