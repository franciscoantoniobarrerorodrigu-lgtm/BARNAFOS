// LuluStream HLS Streaming Proxy Handler
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
  const match = packed.match(/eval\((function\(p,a,c,k,e,d\)[\s\S]+?\.split\('\|'\)[^)]*\))\)/);
  if (!match) return null;
  try {
    return eval('(' + match[1] + ')');
  } catch (e) {
    return null;
  }
}

async function extractFromWebPlayer(code) {
  const domains = ['luluvdo.com', 'lulustream.com', 'lulust.com'];
  for (const domain of domains) {
    try {
      const embedUrl = `https://${domain}/e/${code}`;
      const res = await fetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
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
        // Detectar pistas de idioma embebidas en la URL del master LuluStream
        // Ejemplo: ,lang/spa/9xyggc7muayp_spa,lang/eng/9xyggc7muayp_eng,lang/por/9xyggc7muayp_por,
        const langTracks = [];
        const langMatches = [...m[0].matchAll(/lang\/([a-z]{2,3})\/([^,&?]+)/g)];
        const langMap = {
          spa: { name: 'Español', label: 'Español', lang: 'es' },
          eng: { name: 'English', label: 'Inglés', lang: 'en' },
          por: { name: 'Português', label: 'Portugués', lang: 'pt' }
        };
        for (const lm of langMatches) {
          const langCode = lm[1];
          const trackCode = lm[2];
          const info = langMap[langCode] || { name: langCode.toUpperCase(), label: langCode.toUpperCase(), lang: langCode };
          langTracks.push({ code: langCode, trackCode, name: info.name, label: info.label, lang: info.lang });
        }
        return {
          masterUrl: m[0],
          referer: embedUrl,
          domain: domain,
          langTracks  // pistas de idioma detectadas en la URL del master
        };
      }
    } catch (err) {
      console.warn(`[LuluStream] Error scraping ${domain}:`, err.message);
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
  if (req.query.proxy_seg) {
    const isFromCloudflare = req.headers['x-cf-worker'] || req.headers['cf-ray'] || req.query.cf_fetch === '1';
    if (!isFromCloudflare) {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect(302, `https://barnafos-stream.franciscoantoniobarrerorodrigu.workers.dev/api/play-lulustream?${qs}`);
    }

    const segUrl = decodeURIComponent(req.query.proxy_seg);
    const refCode = req.query.code || '';
    const domain = req.query.d || 'luluvdo.com';
    const referer = `https://${domain}/e/${refCode}`;

    try {
      const segRes = await fetch(segUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': referer,
          'Origin': `https://${domain}`
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!segRes.ok) {
        return res.status(segRes.status).send(`Segment error: ${segRes.status}`);
      }

      if (segUrl.includes('.vtt')) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      } else {
        res.setHeader('Content-Type', 'video/MP2T');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const arrayBuf = await segRes.arrayBuffer();
      return res.send(Buffer.from(arrayBuf));
    } catch (e) {
      return res.status(500).send(`Segment error: ${e.message}`);
    }
  }

  // 1. Sub-playlist proxy request (solo texto 3 KB: reescribe segmentos .ts hacia Cloudflare Worker)
  if (req.query.proxy_sub) {
    const subUrl = decodeURIComponent(req.query.proxy_sub);
    const refCode = req.query.code || '';
    const domain = req.query.d || 'luluvdo.com';
    const referer = `https://${domain}/e/${refCode}`;

    try {
      const subRes = await fetch(subUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': referer,
          'Origin': `https://${domain}`
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!subRes.ok) {
        return res.status(subRes.status).send(`Sub-playlist error: ${subRes.status}`);
      }

      const body = await subRes.text();
      const protocol = 'https';
      const deliveryHost = 'barnafos-stream.franciscoantoniobarrerorodrigu.workers.dev';

      // Rewrite segment URLs to go 100% through Cloudflare Worker
      const lines = body.split('\n');
      const baseUrl = subUrl.substring(0, subUrl.lastIndexOf('/') + 1);
      const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const fullSegUrl = trimmed.startsWith('http') ? trimmed : `${baseUrl}${trimmed}`;
          return `${protocol}://${deliveryHost}/api/play-lulustream?proxy_seg=${encodeURIComponent(fullSegUrl)}&code=${refCode}&d=${domain}`;
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

  // 1b. Lang audio sub-playlist proxy (sirve el index-v1-a1.m3u8 del idioma seleccionado)
  if (req.query.proxy_lang_sub) {
    const trackCode = decodeURIComponent(req.query.proxy_lang_sub); // ej: 9xyggc7muayp_spa
    const refCode = req.query.code || '';
    const domain = req.query.d || 'luluvdo.com';
    const langCode = req.query.lang || 'spa';
    const referer = `https://${domain}/e/${refCode}`;

    try {
      // Obtenemos primero el master para saber el base URL del CDN
      const apiReq = await fetch(`https://${req.get('host') || 'barnafos-tv-web-production.up.railway.app'}/api/play-lulustream?code=${refCode}&json=true`, {
        signal: AbortSignal.timeout(8000)
      });
      const apiData = await apiReq.json();
      if (!apiData.master_url) return res.status(404).send('Cannot resolve lang track');

      // El master URL tiene forma: .../hls2/03/04353/,code_h,lang/spa/code_spa,...,.urlset/master.m3u8?token
      // Construimos el sub playlist del idioma: .../hls2/03/04353/code_spa/index-v1-a1.m3u8?token
      const tokenMatch = apiData.master_url.match(/(\?.*)/);
      const tokenPart = tokenMatch ? tokenMatch[1] : '';
      const basePathMatch = apiData.master_url.match(/(https?:\/\/[^/]+\/hls2\/\d+\/\d+\/)/);
      if (!basePathMatch) return res.status(404).send('Cannot parse base URL');
      const basePath = basePathMatch[1];
      // Construimos las URLs de la sub-playlist de este rendition de audio
      const langSubUrl = `${basePath}${trackCode}/index-v1-a1.m3u8${tokenPart}`;

      const subRes = await fetch(langSubUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': referer,
          'Origin': `https://${domain}`
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!subRes.ok) {
        return res.status(subRes.status).send(`Lang sub-playlist error: ${subRes.status}`);
      }

      const body = await subRes.text();
      const host = req.get('host') || 'barnafos-tv-web-production.up.railway.app';
      const protocol = 'https';
      const deliveryHost = 'barnafos-stream.franciscoantoniobarrerorodrigu.workers.dev';
      const baseUrl = langSubUrl.substring(0, langSubUrl.lastIndexOf('/') + 1);

      // Rewrite segments to Cloudflare delivery
      const rewritten = body.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const fullSegUrl = trimmed.startsWith('http') ? trimmed : `${baseUrl}${trimmed}`;
          return `${protocol}://${deliveryHost}/api/play-lulustream?proxy_seg=${encodeURIComponent(fullSegUrl)}&code=${refCode}&d=${domain}`;
        }
        return line;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.send(rewritten.join('\n'));
    } catch (e) {
      return res.status(500).send(`Lang sub-playlist error: ${e.message}`);
    }
  }

  // 2. Main master.m3u8 extraction request
  let rawCode = req.query.code || req.query.url || req.query.c || '';
  if (!rawCode) {
    return res.status(400).json({ error: 'Missing code or url parameter' });
  }

  // Extract alphanumeric code from URL or string
  const codeMatch = rawCode.match(/(?:d|e)\/([a-zA-Z0-9]+)/) || rawCode.match(/([a-zA-Z0-9]{8,})/);
  const code = codeMatch ? codeMatch[1] : rawCode.trim();

  try {
    const extracted = await extractFromWebPlayer(code);
    if (!extracted) {
      return res.status(404).json({ error: 'Failed to extract LuluStream video', code: code });
    }

    // If json requested, return metadata
    if (req.query.json === 'true') {
      return res.json({
        success: true,
        master_url: extracted.masterUrl,
        referer: extracted.referer
      });
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': extracted.referer,
      'Origin': `https://${extracted.domain}`
    };

    let targetMasterUrl = extracted.masterUrl;
    let masterRes = await fetch(targetMasterUrl, { headers });

    // Fallback 1: If 404 and url contains missing language tracks in urlset (e.g. Fito Páez)
    if (!masterRes.ok && masterRes.status === 404 && targetMasterUrl.includes(',lang/')) {
      const cleaned = targetMasterUrl.replace(/,lang\/[a-z]{3}\/[^,]+/g, '');
      console.log(`[LuluStream] Retrying with cleaned urlset: ${cleaned}`);
      masterRes = await fetch(cleaned, { headers });
      if (masterRes.ok) targetMasterUrl = cleaned;
    }

    // Fallback 2: If still 404, try direct ${code}_h/master.m3u8
    if (!masterRes.ok && masterRes.status === 404 && targetMasterUrl.includes('.urlset/master.m3u8')) {
      const directMaster = targetMasterUrl.replace(/,[^,]+_h[\s\S]*?\.urlset\/master\.m3u8/, `${code}_h/master.m3u8`);
      console.log(`[LuluStream] Retrying with direct master: ${directMaster}`);
      masterRes = await fetch(directMaster, { headers });
      if (masterRes.ok) targetMasterUrl = directMaster;
    }

    if (!masterRes.ok) {
      return res.status(masterRes.status).send(`Upstream master.m3u8 error: ${masterRes.status}`);
    }

    const masterBody = await masterRes.text();
    const targetBridge = req.query.b || getBridge();

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

    const host = req.get('host') || 'barnafos-tv-web-production.up.railway.app';
    const protocol = 'https';
    const hasAnySubs = masterBody.includes('TYPE=SUBTITLES');
    let subGroupId = "subs0";
    const groupMatch = masterBody.match(/TYPE=SUBTITLES[^\n]*GROUP-ID="([^"]+)"/);
    if (groupMatch) {
      subGroupId = groupMatch[1];
    }

    // Rewrite master.m3u8:
    // ─ Eliminar TODAS las pistas de AUDIO externas (#EXT-X-MEDIA:TYPE=AUDIO)
    //   para que HLS.js use SOLO el audio muxeado dentro del segmento de video.
    //   Esto evita el bucle/eco de audio y la desincronización en seeks y reanudación.
    // ─ Quitar el atributo AUDIO="..." de EXT-X-STREAM-INF
    // ─ Reescribir la URI del video al rendition con audio español (index-v1-a1.m3u8, etc.)
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
          const proxySubUrl = `${protocol}://${host}/api/play-lulustream?proxy_sub=${encodeURIComponent(p1)}&code=${code}&d=${extracted.domain}`;
          return `URI="${proxySubUrl}"`;
        });
      }

      // In #EXT-X-STREAM-INF: strip AUDIO="..." attribute and ensure SUBTITLES attribute is preserved
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
        let lineOut = line.replace(/,AUDIO="[^"]*"/gi, '').replace(/AUDIO="[^"]*",?/gi, '');
        if (hasAnySubs && !lineOut.includes('SUBTITLES=')) {
          lineOut += `,SUBTITLES="${subGroupId}"`;
        }
        return lineOut;
      }

      // Rewrite video stream playlists to Spanish-muxed rendition (zero PTS gap)
      if (!trimmed.startsWith('#') && trimmed.includes('.m3u8')) {
        let videoUri = trimmed;
        if (spanishAudioTag && /-a\d+\.m3u8/i.test(videoUri)) {
          videoUri = videoUri.replace(/-a\d+\.m3u8/i, `-${spanishAudioTag}.m3u8`);
        }
        return `${protocol}://${host}/api/play-lulustream?proxy_sub=${encodeURIComponent(videoUri)}&code=${code}&d=${extracted.domain}`;
      }

      return line;
    }).filter(Boolean);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, s-maxage=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.send(rewrittenLines.join('\n'));

  } catch (err) {
    console.error('[LuluStream Handler Error]:', err);
    return res.status(500).json({ error: err.message });
  }
};
