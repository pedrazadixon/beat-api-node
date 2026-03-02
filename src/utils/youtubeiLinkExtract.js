const { Innertube, UniversalCache, Platform } = require('youtubei.js');
const fs = require('fs');

// Requerido: evaluador de JS para descifrar las URLs de streaming
Platform.shim.eval = async (data, env) => {
    const properties = [];
    if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
    if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
    const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
    return new Function(code)();
};

async function getVideoLinks(videoId) {

    const yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        cookie: process.env.YT_COOKIE || ''
    });

    // console.info(`\nObteniendo enlaces para video: ${videoId}\n`);

    // Usar cliente IOS (el WEB usa SABR y no devuelve URLs tradicionales)
    const info = await yt.getBasicInfo(videoId, 'IOS');

    const title = info.basic_info?.title || 'Sin título';
    const duration = info.basic_info?.duration || 0;
    // console.info(`Título: ${title}`);
    // console.info(`Duración: ${duration}s\n`);

    const allFormats = [
        ...(info.streaming_data?.adaptive_formats || []),
        ...(info.streaming_data?.formats || [])
    ].filter(f => f.url || f.signature_cipher);

    if (allFormats.length === 0) {
        // console.info('No se encontraron formatos disponibles.');
        return [];
    }

    const results = [];

    // --- Formatos de Audio ---
    const audioFormats = allFormats.filter(f => f.has_audio && !f.has_video);
    if (audioFormats.length > 0) {
        // console.info('===== AUDIO =====');
        for (const fmt of audioFormats) {
            const url = await fmt.decipher(yt.session.player);
            const entry = {
                type: 'audio',
                mime_type: fmt.mime_type,
                bitrate: fmt.bitrate,
                quality: fmt.audio_quality || 'N/A',
                url
            };
            results.push(entry);
            // console.info(`[${fmt.mime_type}] ${fmt.bitrate}bps | Calidad: ${entry.quality}`);
            // console.info(`URL: ${url}\n`);
        }
    }

    // --- Formatos de Video ---
    const videoFormats = allFormats.filter(f => f.has_video);
    if (videoFormats.length > 0) {
        // console.info('===== VIDEO =====');
        for (const fmt of videoFormats) {
            const url = await fmt.decipher(yt.session.player);
            const entry = {
                type: fmt.has_audio ? 'video+audio' : 'video',
                mime_type: fmt.mime_type,
                bitrate: fmt.bitrate,
                quality: fmt.quality_label || `${fmt.width}x${fmt.height}`,
                fps: fmt.fps || 'N/A',
                url
            };
            results.push(entry);
            // console.info(`[${fmt.mime_type}] ${entry.quality} @ ${entry.fps}fps | ${fmt.bitrate}bps | ${entry.type}`);
            // console.info(`URL: ${url}\n`);
        }
    }

    // console.info(`===== TOTAL: ${results.length} enlaces =====`);
    return results;
}

module.exports = { getVideoLinks };