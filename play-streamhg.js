// StreamHG HLS Streaming Proxy Handler (LuluStream Architecture)
// Extracts clean master.m3u8 and routes sub-playlists and segments through secondary bridge pool

const BRIDGES = [
  'https://bridge-sports-1-production.up.railway.app',
  'https://bridge-sports-2-production.up.railway.app',
  'https://bridge-sports-3-production.up.railway.app',
  'https://accurate-respect-production-a6fe.up.railway.app',
  'https://bridge-2-production.up.railway.app',
  'https://eloquent-eagerness-production.up.railway.app'
];

const bridgeHealth = new Map();
BRIDGES.forEach(b => bridgeHealth.set(b, { ok: true, lastCheck: 0 }));

async function checkBridgeHealth() {
  for (const b of BRIDGES) {
    try {
      const res = await fetch(b + '/', { signal: AbortSignal.timeout(3000) });
      bridgeHealth.set(b, { ok: res.status < 500, lastCheck: Date.now() });
    } catch(e) {
      bridgeHealth.set(b, { ok: false, lastCheck: Date.now() });
    }
  }
}
setInterval(checkBridgeHealth, 30000);
checkBridgeHealth();

function getBridge() {
  const healthy = BRIDGES.filter(b => {
    const h = bridgeHealth.get(b);
    return !h || h.ok || (Date.now() - h.lastCheck > 120000);
  });
  const pool = healthy.length > 0 ? healthy : BRIDGES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function unpack(packed) {
  const evalRegex = /<script\s+type=['"]text\/javascript['"]>eval\(function\(p,a,c,k,e,d\)\{while\(c--\)[\s\S]+?return p\}\('([\s\S]+?)',(\d+),(\d+),'([^']+)'\.split\('\|'\)/;
  const m = packed.match(evalRegex);
  if (!m) {
    const generic = packed.match(/eval\((function\(p,a,c,k,e,d\)[\s\S]+?\.split\('\|'\)[^)]*\))\)/);
    if (!generic) return null;
    try {
      return eval('(' + generic[1] + ')');
    } catch (e) {
      return null;
    }
  }
  let p = m[1];
  const a = parseInt(m[2], 10);
  let c = parseInt(m[3], 10);
  const k = m[4].split('|');
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp('\\b' + c.toString(a) + '\\b', 'g'), k[c]);
    }
  }
  return p;
}

async function extractFromWebPlayer(code) {
  const domains = ['vibuxer.com', 'audinifer.com', 'streamhg.com', 'hgcloud.to'];
  for (const domain of domains) {
    for (const prefix of ['/e/', '/']) {
      try {
        const embedUrl = `https://${domain}${prefix}${code}`;
        const res = await fetch(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Referer': `https://${domain}/`
          },
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) continue;
        const html = await res.text();
        const unpacked = unpack(html);
        if (!unpacked) continue;

        const m = unpacked.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
        if (m) {
          // Subtítulos VTT
          const vttMatches = [...unpacked.matchAll(/\{file:"(https?:\/\/[^"]+\.vtt)",label:"([^"]+)"/g)];
          const subTracks = vttMatches.map(x => {
            const rawLabel = x[2] || '';
            const low = rawLabel.toLowerCase();
            const isSpa = low.includes('argent') || low.includes('espa') || low.includes('spa') || low.includes('latino');
            const isPor = low.includes('por') || low.includes('pt') || low.includes('brasil');
            const isEng = low.includes('eng') || low.includes('en');
            let cleanLabel = rawLabel;
            let lang = 'es';
            if (isSpa) { cleanLabel = 'Español'; lang = 'es'; }
            else if (isPor) { cleanLabel = 'Portugués'; lang = 'pt'; }
            else if (isEng) { cleanLabel = 'Inglés'; lang = 'en'; }
            return { url: x[1], label: cleanLabel, language: lang };
          });

          return {
            masterUrl: m[0],
            referer: embedUrl,
            domain: domain,
            subtitles: subTracks
          };
        }
      } catch (err) {
        console.warn(`[StreamHG] Error scraping ${domain}${prefix}:`, err.message);
      }
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 0. Segment proxy request (Cloudflare Edge Cache Delivery)
  if (req.query.proxy_seg || req.query.proxy_ts) {
    const isFromCloudflare = req.headers['x-cf-worker'] || req.headers['cf-ray'] || req.query.cf_fetch === '1';
    if (!isFromCloudflare) {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect(302, `https://barnafos-stream.franciscoantoniobarrerorodrigu.workers.dev/api/play-streamhg?${qs}`);
    }

    const segUrl = decodeURIComponent(req.query.proxy_seg || req.query.proxy_ts);
    const refCode = req.query.code || '';
    const domain = req.query.d || 'vibuxer.com';
    const referer = `https://${domain}/e/${refCode}`;

    try {
      const segRes = await fetch(segUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Referer': referer,
          'Origin': `https://${domain}`
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!segRes.ok) {
        return res.status(segRes.status).send(`Segment error: ${segRes.status}`);
      }

      res.setHeader('Content-Type', 'video/MP2T');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const arrayBuf = await segRes.arrayBuffer();
      return res.send(Buffer.from(arrayBuf));
    } catch (e) {
      return res.status(500).send(`Segment error: ${e.message}`);
    }
  }

  // 1. Sub-playlist proxy request (solo texto 3 KB: reescribe segmentos .ts hacia Cloudflare Worker)
  if (req.query.proxy_sub || req.query.proxy_m3u8) {
    const subUrl = decodeURIComponent(req.query.proxy_sub || req.query.proxy_m3u8);
    const refCode = req.query.code || '';
    const domain = req.query.d || 'vibuxer.com';
    const referer = `https://${domain}/e/${refCode}`;

    try {
      const subRes = await fetch(subUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Referer': referer,
          'Origin': `https://${domain}`
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!subRes.ok) {
        return res.status(subRes.status).send(`Sub-playlist error: ${subRes.status}`);
      }

      const body = await subRes.text();
      const deliveryHost = 'barnafos-stream.franciscoantoniobarrerorodrigu.workers.dev';
      const baseUrl = subUrl.substring(0, subUrl.lastIndexOf('/') + 1);

      // Rewrite segment URLs to go 100% through Cloudflare Worker
      const lines = body.split('\n');
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const fullSegUrl = trimmed.startsWith('http') ? trimmed : `${baseUrl}${trimmed}`;
          return `https://${deliveryHost}/api/play-streamhg?proxy_seg=${encodeURIComponent(fullSegUrl)}&code=${refCode}&d=${domain}`;
        }
        return line;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.send(rewritten.join('\n'));
    } catch (e) {
      return res.status(500).send(`Sub-playlist error: ${e.message}`);
    }
  }

  // 1a. Subtitle playlist proxy request (returns standard HLS VOD playlist wrapping the .vtt)
  if (req.query.sub_m3u8) {
    const rawVttUrl = decodeURIComponent(req.query.sub_m3u8);
    const host = req.get('host') || 'barnafos-tv-web-production.up.railway.app';
    const protocol = 'https';
    const domain = req.query.d || 'vibuxer.com';
    const code = req.query.code || '';
    const vttDelivery = `${protocol}://${host}/api/play-streamhg?sub_vtt=${encodeURIComponent(rawVttUrl)}&code=${code}&d=${domain}&ext=.vtt`;

    const m3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:7200',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXTINF:7200.0,',
      vttDelivery,
      '#EXT-X-ENDLIST'
    ].join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.send(m3u8);
  }

  // 1b. Direct WebVTT delivery (always text/vtt, CORS *, zero Cloudflare redirect)
  if (req.query.sub_vtt || req.query.proxy_vtt) {
    const vttUrl = decodeURIComponent(req.query.sub_vtt || req.query.proxy_vtt);
    const domain = req.query.d || 'vibuxer.com';
    try {
      const vttRes = await fetch(vttUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Referer': `https://${domain}/`
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!vttRes.ok) {
        return res.status(vttRes.status).send(`VTT upstream error: ${vttRes.status}`);
      }
      let vttText = await vttRes.text();
      if (!vttText.trim().startsWith('WEBVTT')) {
        vttText = 'WEBVTT\n\n' + vttText;
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(vttText);
    } catch(e) {
      return res.status(500).send('Subtitle error: ' + e.message);
    }
  }

  // 2. Main master.m3u8 extraction request
  let rawCode = req.query.code || req.query.url || req.query.c || req.query.id || '';
  if (!rawCode) {
    return res.status(400).json({ error: 'Missing code or url parameter' });
  }

  // Extract alphanumeric code from URL or string
  const codeMatch = rawCode.match(/(?:vibuxer\.com|audinifer\.com|hgcloud\.to|streamhg\.com|streamhg\.to|streamwish\.to|streamwish\.top|hanerix\.com)\/(?:e\/)?([a-zA-Z0-9]+)/i) || rawCode.match(/(?:d|e)\/([a-zA-Z0-9]+)/) || rawCode.match(/([a-zA-Z0-9]{8,})/);
  const code = (codeMatch ? codeMatch[1] : rawCode.trim()).replace(/\.m3u8$/i, '');

  try {
    const extracted = await extractFromWebPlayer(code);
    if (!extracted) {
      return res.status(404).json({ error: 'Failed to extract StreamHG video', code: code });
    }

    if (req.query.json === 'true' || req.query.format === 'json') {
      return res.json({
        success: true,
        master_url: extracted.masterUrl,
        referer: extracted.referer,
        subtitles: extracted.subtitles
      });
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Referer': extracted.referer,
      'Origin': `https://${extracted.domain}`
    };

    let targetMasterUrl = extracted.masterUrl;
    let masterRes = await fetch(targetMasterUrl, { headers });

    if (!masterRes.ok) {
      return res.status(masterRes.status).send(`Upstream master.m3u8 error: ${masterRes.status}`);
    }

    const masterBody = await masterRes.text();
    const targetBridge = req.query.b || getBridge();
    const baseUrl = targetMasterUrl.substring(0, targetMasterUrl.lastIndexOf('/') + 1);

    const lines = masterBody.split('\n');

    // Find Spanish audio tag (e.g. "a1", "a2", "a3")
    let spanishAudioTag = null;
    for (const line of lines) {
      if (line.includes('TYPE=AUDIO') && /LANGUAGE=["']es["']|Español|Spanish|Latino/i.test(line)) {
        const match = line.match(/(a\d+)\.m3u8/);
        if (match) {
          spanishAudioTag = match[1];
          break;
        }
      }
    }

    // Rewrite master.m3u8:
    // ─ Eliminar TODAS las pistas de AUDIO externas (#EXT-X-MEDIA:TYPE=AUDIO)
    //   para que HLS.js use SOLO el audio muxeado dentro del segmento de video.
    //   Esto evita el bloqueo en 00:00 causado por desincronización de PTS entre
    //   el audio externo y el video.
    // ─ Reescribir la URI del video al rendition de audio español (index-v1-a2.m3u8, etc.)
    // ─ Quitar el atributo AUDIO="..." de EXT-X-STREAM-INF (ya no hay grupo de audio)
    const host = req.get('host') || 'barnafos-tv-web-production.up.railway.app';
    const protocol = 'https';
    const hasExternalSubs = extracted.subtitles && extracted.subtitles.length > 0;
    const hasAnySubs = hasExternalSubs || masterBody.includes('TYPE=SUBTITLES');
    let subGroupId = "subs";
    const groupMatch = masterBody.match(/TYPE=SUBTITLES[^\n]*GROUP-ID="([^"]+)"/);
    if (groupMatch) {
      subGroupId = groupMatch[1];
    }

    const rewrittenLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Drop I-Frame streams so they don't confuse players
      if (trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) return null;

      // Drop ALL external audio groups (prevents PTS timeline misalignment and double-audio collision)
      if (trimmed.startsWith('#EXT-X-MEDIA:') && trimmed.includes('TYPE=AUDIO')) {
        return null;
      }

      // Handle #EXT-X-MEDIA:TYPE=SUBTITLES — keep them, force non-default
      if (trimmed.startsWith('#EXT-X-MEDIA:') && trimmed.includes('TYPE=SUBTITLES')) {
        let lineOut = trimmed.replace(/DEFAULT=YES/gi, 'DEFAULT=NO').replace(/AUTOSELECT=YES/gi, 'AUTOSELECT=NO');
        return lineOut.replace(/URI="([^"]+)"/g, (match, p1) => {
          const fullUri = p1.startsWith('http') ? p1 : `${baseUrl}${p1}`;
          const proxySubUrl = `${protocol}://${host}/api/play-streamhg?proxy_sub=${encodeURIComponent(fullUri)}&code=${code}&d=${extracted.domain}&ext=.m3u8`;
          return `URI="${proxySubUrl}"`;
        });
      }

      // In #EXT-X-STREAM-INF: strip AUDIO="..." attribute and ensure SUBTITLES attribute is attached
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
        let lineOut = line.replace(/,AUDIO="[^"]*"/gi, '').replace(/AUDIO="[^"]*",?/gi, '');
        if (hasAnySubs && !lineOut.includes('SUBTITLES=')) {
          lineOut += `,SUBTITLES="${subGroupId}"`;
        }
        return lineOut;
      }

      // Rewrite video stream sub-playlists to Spanish-muxed rendition (zero PTS gap)
      if (!trimmed.startsWith('#') && trimmed.includes('.m3u8')) {
        let videoUri = trimmed;
        if (spanishAudioTag && /-a\d+\.m3u8/i.test(videoUri)) {
          videoUri = videoUri.replace(/-a\d+\.m3u8/i, `-${spanishAudioTag}.m3u8`);
        }
        const fullUri = videoUri.startsWith('http') ? videoUri : `${baseUrl}${videoUri}`;
        return `${protocol}://${host}/api/play-streamhg?proxy_sub=${encodeURIComponent(fullUri)}&code=${code}&d=${extracted.domain}&ext=.m3u8`;
      }

      return line;
    }).filter(Boolean);

    // Inject external subtitles if present and not already in manifest
    if (hasExternalSubs && !masterBody.includes('TYPE=SUBTITLES')) {
      const subLines = extracted.subtitles.map(st => {
        const subUri = `${protocol}://${host}/api/play-streamhg?sub_m3u8=${encodeURIComponent(st.url)}&code=${code}&d=${extracted.domain}&ext=.m3u8`;
        return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${subGroupId}",NAME="${st.label}",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="${st.language}",URI="${subUri}"`;
      });
      rewrittenLines.splice(1, 0, ...subLines);
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.send(rewrittenLines.join('\n'));

  } catch (err) {
    console.error('[StreamHG Handler Error]:', err);
    return res.status(500).json({ error: err.message });
  }
};
