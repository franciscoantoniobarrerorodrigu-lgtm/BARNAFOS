const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('etag', false);

// Zero cache para listas en vivo y CORS Universal
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// Cache multicast en memoria
const sportsTokenCache = new Map();

// ─── 1. Decodificador StreamXHD / DeportesTVHD / EnviosLatam (Proveedor 1) ───
function decodeStreamXHD(html) {
    if (!html) return null;
    try {
        const arrMatch = html.match(/([a-zA-Z0-9_$]+)\s*=\s*(\[\[\s*\d+,\s*"[A-Za-z0-9+/=]+"[\s\S]*?\]\]);/);
        if (arrMatch) {
            const rawArr = JSON.parse(arrMatch[2]);
            rawArr.sort((a, b) => a[0] - b[0]);

            const fnRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(\)\s*\{\s*return\s+(\d+);\s*\}/g;
            const fns = {};
            let m;
            while ((m = fnRegex.exec(html)) !== null) fns[m[1]] = parseInt(m[2], 10);

            const kMatch = html.match(/var\s+k\s*=\s*([a-zA-Z0-9_$]+)\s*\(\)\s*\+\s*([a-zA-Z0-9_$]+)\s*\(\)/);
            let k = 0;
            if (kMatch) k = (fns[kMatch[1]] || 0) + (fns[kMatch[2]] || 0);
            else {
                const vals = Object.values(fns);
                if (vals.length >= 2) k = vals[0] + vals[1];
            }

            let streamUrl = '';
            rawArr.forEach(e => {
                let v = e[1];
                let num = parseInt(Buffer.from(v, 'base64').toString('utf-8').replace(/\D/g, ''), 10);
                streamUrl += String.fromCharCode(num - k);
            });
            if (streamUrl && (streamUrl.includes('.m3u8') || streamUrl.includes('.mpd'))) {
                return streamUrl;
            }
        }
    } catch(e) {}
    return null;
}

// ─── 2. Extractor Recursivo Profundo (Proveedor 1 y 2) ───
async function deepExtractStreams(targetUrl, depth = 0) {
    if (depth > 3 || !targetUrl) return [];
    const cleanTargetUrl = String(targetUrl).trim();
    if (!cleanTargetUrl.startsWith('http')) return [];

    const found = new Set();
    try {
        const urlObj = new URL(cleanTargetUrl);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': urlObj.origin + '/'
        };

        const res = await fetch(cleanTargetUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        const html = await res.text();
        const cleanHtml = html.replace(/\\\//g, '/');

        // Proveedor 1
        const sxhd = decodeStreamXHD(html);
        if (sxhd) found.add(sxhd);

        // Regex m3u8
        const m3u8Patterns = [
            /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi,
            /(?:source|file|url|src|stream|playbackURL)\s*[:=]\s*['"]?(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi,
            /(?:source|file|url|src|stream|playbackURL)\s*[:=]\s*['"]?(\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi
        ];
        for (const pattern of m3u8Patterns) {
            let match;
            while ((match = pattern.exec(cleanHtml)) !== null) {
                let u = match[1] || match[0];
                if (u.startsWith('//')) u = 'https:' + u;
                u = u.replace(/['";\s]+$/, '');
                found.add(u);
            }
        }

        // Base64 atob
        const b64Pattern = /atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g;
        let b64Match;
        while ((b64Match = b64Pattern.exec(cleanHtml)) !== null) {
            try {
                const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8').trim();
                const innerM3u8 = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
                if (innerM3u8) innerM3u8.forEach(u => found.add(u.replace(/['";\s]+$/, '')));
            } catch (e) {}
        }

        // Parámetro ?r=
        if (cleanTargetUrl.includes('?r=')) {
            const rParam = urlObj.searchParams.get('r');
            if (rParam) {
                try {
                    const decoded = Buffer.from(rParam, 'base64').toString('utf-8').trim();
                    if (decoded.includes('.m3u8')) {
                        found.add(decoded.replace(/['";\s]+$/, ''));
                    } else if (decoded.startsWith('http')) {
                        const subUrls = await deepExtractStreams(decoded, depth + 1);
                        subUrls.forEach(u => found.add(u));
                    }
                } catch(e) {}
            }
        }

        // Iframes internos (TVF90, GolazoHD, etc.)
        if (depth < 2) {
            const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
            let ifMatch;
            while ((ifMatch = iframeRegex.exec(cleanHtml)) !== null) {
                let ifSrc = ifMatch[1].trim();
                if (ifSrc.startsWith('//')) ifSrc = 'https:' + ifSrc;
                else if (ifSrc.startsWith('/')) ifSrc = urlObj.origin + ifSrc;

                if (cleanTargetUrl.includes('eventos.html') && cleanTargetUrl.includes('?r=')) continue;

                if (ifSrc.startsWith('http') && !ifSrc.includes('google') && !ifSrc.includes('facebook') && !ifSrc.includes('doubleclick')) {
                    const subUrls = await deepExtractStreams(ifSrc, depth + 1);
                    subUrls.forEach(u => found.add(u));
                }
            }
        }
    } catch (e) {
        console.error(`[DeepExtract Render] Error at depth ${depth}:`, e.message);
    }

    return [...found];
}

// ─── 3. Endpoint de Extracción de Tokens ───
app.all(['/api/extract-sports-token', '/api/extract-stream'], async (req, res) => {
    const sourceUrl = req.query.source_url;
    if (!sourceUrl) return res.status(400).json({ error: 'Missing source_url' });

    const cached = sportsTokenCache.get(sourceUrl);
    if (cached && cached.expiresAt > Date.now()) {
        if (req.query.json === 'true' || req.query.json === '1') {
            return res.status(200).json(cached.payload);
        } else {
            return res.redirect(302, cached.payload.proxied_url);
        }
    }

    try {
        const urls = await deepExtractStreams(sourceUrl, 0);
        if (urls.length > 0) {
            const bestUrl = urls.find(u => u.includes('token=') && !u.includes('block.html')) || 
                            urls.find(u => u.includes('mono.m3u8')) || 
                            urls.find(u => u.includes('index.m3u8')) || 
                            urls[0];

            const host = req.get('host');
            const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const serverOrigin = `${protocol}://${host}`;
            const proxiedUrl = `${serverOrigin}/api/proxy?url=${encodeURIComponent(bestUrl)}`;

            const payload = {
                success: true,
                method: 'render_dedicated_proxy',
                stream_url: bestUrl,
                playbackURL: bestUrl,
                proxied_url: proxiedUrl,
                b: serverOrigin,
                all_urls: urls,
                extracted_at: new Date().toISOString()
            };

            sportsTokenCache.set(sourceUrl, {
                payload,
                expiresAt: Date.now() + (90 * 1000)
            });

            if (req.query.json === 'true' || req.query.json === '1') {
                return res.status(200).json(payload);
            } else {
                return res.redirect(302, proxiedUrl);
            }
        } else {
            return res.status(404).json({ error: 'No m3u8 found', source_url: sourceUrl });
        }
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
});

// ─── 4. Motor Proxy de Video con IP Persistente (CERO 403) ───
app.all(['/api/proxy', '/proxy'], (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

    try {
        const parsedUrl = new URL(targetUrl);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        };

        // Headers anti-bloqueo según proveedor
        if (targetUrl.includes('futlivehd') || targetUrl.includes('streamxhd') || targetUrl.includes('khala') || targetUrl.includes('domhsd') || targetUrl.includes('.sbs') || targetUrl.includes('deportestvhd')) {
            options.headers['Referer'] = 'https://streamxhd.com/';
            options.headers['Origin'] = 'https://streamxhd.com';
        } else if (targetUrl.includes('fubo') || targetUrl.includes('ftlly') || targetUrl.includes('tvf90') || targetUrl.includes('golazohd') || targetUrl.includes('futbollibre') || targetUrl.includes('pelotalibre') || targetUrl.includes('la12hd') || targetUrl.includes('streamtp')) {
            options.headers['Referer'] = 'https://tvf90.com/';
            options.headers['Origin'] = 'https://tvf90.com';
        } else if (targetUrl.includes('edgestream')) {
            options.headers['Referer'] = 'https://streame.center/';
            options.headers['Origin'] = 'https://streame.center';
        } else if (targetUrl.includes('premilkyway') || targetUrl.includes('goldenridgeproductionlab') || targetUrl.includes('b-cdn.net')) {
            options.headers['Referer'] = 'https://vibuxer.com/';
        }

        const ipParamMatch = targetUrl.match(/[?&]ip=([^&]+)/);
        if (ipParamMatch && ipParamMatch[1]) {
            const streamIp = decodeURIComponent(ipParamMatch[1]);
            options.headers['X-Forwarded-For'] = streamIp;
            options.headers['X-Real-IP'] = streamIp;
            options.headers['CF-Connecting-IP'] = streamIp;
        }

        const proxyReq = transport.request(options, (proxyRes) => {
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
                let redirectUrl = proxyRes.headers['location'];
                if (redirectUrl) {
                    try {
                        const absRedirect = new URL(redirectUrl, targetUrl).href;
                        res.setHeader('Location', `/api/proxy?url=${encodeURIComponent(absRedirect)}`);
                    } catch(e) {
                        res.setHeader('Location', redirectUrl);
                    }
                }
                return res.status(proxyRes.statusCode).end();
            }

            if (proxyRes.statusCode >= 400) {
                return res.status(proxyRes.statusCode).send('Upstream Error: ' + proxyRes.statusCode);
            }

            const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
            const isM3u8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u');

            res.status(proxyRes.statusCode);

            if (isM3u8) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');

                let playlistBody = '';
                proxyRes.on('data', chunk => { playlistBody += chunk.toString('utf8'); });
                proxyRes.on('end', () => {
                    const host = req.get('host');
                    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
                    const serverOrigin = `${protocol}://${host}`;

                    const lines = playlistBody.split('\n');
                    const rewritten = lines.map(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return line;

                        if (trimmed.startsWith('#')) {
                            if (trimmed.includes('URI="')) {
                                return trimmed.replace(/URI="([^"]+)"/g, (m, p1) => {
                                    try {
                                        const abs = new URL(p1, targetUrl).href;
                                        return `URI="${serverOrigin}/api/proxy?url=${encodeURIComponent(abs)}"`;
                                    } catch(e) { return m; }
                                });
                            }
                            return line;
                        }

                        // URLs de sub-listas o segmentos
                        try {
                            const abs = new URL(trimmed, targetUrl).href;
                            return `${serverOrigin}/api/proxy?url=${encodeURIComponent(abs)}`;
                        } catch(e) { return line; }
                    });

                    res.send(rewritten.join('\n'));
                });
            } else {
                // Segmento binario de video (.ts)
                for (const h in proxyRes.headers) {
                    if (!['content-length', 'transfer-encoding', 'cache-control'].includes(h.toLowerCase())) {
                        res.setHeader(h, proxyRes.headers[h]);
                    }
                }
                res.setHeader('Cache-Control', 'public, max-age=120');
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) res.status(502).send('Proxy Connection Error: ' + err.message);
        });

        req.pipe(proxyReq);

    } catch(e) {
        if (!res.headersSent) res.status(500).send('Proxy Error: ' + e.message);
    }
});

// ─── 5. Handlers de Streaming VOD (LuluStream & StreamHG) ───
const playStreamHg = require('./play-streamhg');
app.all(['/api/play-streamhg', '/play-streamhg'], playStreamHg);

const playLuluStream = require('./play-lulustream');
app.all(['/api/play-lulustream', '/play-lulustream'], playLuluStream);

app.all(['/api/lulu-view', '/lulu-view'], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    try {
        await fetch(`https://luluvdo.com/e/${code}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://luluvdo.com/'
            }
        });
        return res.status(200).send('OK');
    } catch(e) {
        return res.status(200).send('OK');
    }
});

// Health checks
app.get(['/', '/health', '/ping'], (req, res) => {
    res.status(200).json({ status: 'online', service: 'BarnaFOS Sports & VOD Proxy (Render Dedicated)' });
});

app.listen(PORT, () => {
    console.log(`[Render Sports Proxy] Running on port ${PORT}`);

    // Auto Keep-Alive: Ping cada 10 minutos para evitar que Render entre en reposo (24/7 activo)
    const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || 'https://barnafos.onrender.com';
    setInterval(() => {
        fetch(`${KEEP_ALIVE_URL}/ping`)
            .then(r => r.json())
            .then(() => console.log(`[KeepAlive] Ping a ${KEEP_ALIVE_URL} exitoso`))
            .catch(err => console.error('[KeepAlive] Error:', err.message));
    }, 10 * 60 * 1000);
});
