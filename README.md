# Social Media Downloader API (Railway Optimized)

A high-performance, low-latency API to extract download links from various social media platforms using `yt-dlp`.

## Features
- **Ultra-low latency**: Uses Fastify and intelligent caching.
- **Wide support**: Powered by `yt-dlp`, supporting 1000+ sites including TikTok, Instagram, YouTube, Twitter/X, and more.
- **Direct links**: Provides direct video/audio URLs whenever possible.
- **Railway Ready**: Includes `Dockerfile` for seamless deployment.
- **Metadata**: Returns title, thumbnail, duration, views, likes, and more.

## Endpoints

### `GET /`
Returns service status and usage information.

### `GET /api/download?url=<LINK>`
Extracts media links from the provided URL.

**Query Params:**
- `url` (required): The social media link.

**Example Response:**
```json
{
  "id": "12345",
  "title": "Example Video",
  "download_url": "https://...",
  "platform": "TikTok",
  "media": {
    "best": { ... },
    "all_formats": [ ... ]
  },
  "_process_time": "450ms"
}
```

## Deployment on Railway

1. **Fork/Upload** this repository to GitHub.
2. **Connect** to Railway.
3. Railway will detect the `Dockerfile` and start building.
4. **Environment Variables**:
   - `PORT`: (Managed by Railway)
   - `NODE_ENV`: Set to `production`

## Performance Optimizations
- **Metadata only**: Uses `--dump-json` to avoid downloading full files on the server.
- **In-memory cache**: Repeated requests for the same URL within 6 hours are served instantly from cache.
- **Fastify**: High-performance Node.js framework with minimal overhead.
- **Optimized Docker**: Lightweight image based on `node:slim`.

## Site Specific Notes

### Instagram
If you encounter "Rate Limited" or "Login required", you may need to provide session cookies.
1. Export cookies from your browser using an extension (Netscape format).
2. Set a Railway variable `COOKIES_DATA`.
3. Modify `index.js` to write this to a file and pass `--cookies cookies.txt` to `yt-dlp`.

## License
MIT
