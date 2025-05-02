#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const pako = require('pako');
const { Buffer } = require('buffer');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const { put } = require('@vercel/blob');
const { createClient } = require('@supabase/supabase-js');

const OPENSUBS_API_URL = 'https://rest.opensubtitles.org';
const ADDON_PORT = process.env.PORT || 7000;

const requestQueue = [];
const MAX_REQUESTS_PER_MINUTE = 40;
let requestsThisMinute = 0;
let requestTimer = null;

const builder = new addonBuilder({
    id: 'com.serhat.strelingo',
    version: '0.1.1',
    name: 'Strelingo - Dual Language Subtitles',
    description: 'Provides dual subtitles (main + translation) from OpenSubtitles for language learning.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    logo: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_icon.jpg',
    background: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_back.jpg',
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    stremioAddonsConfig: {
        issuer: "https://stremio-addons.net",
        signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..lXnuMnJQRfJhhvSjtCRgEA.Pkd-2sawfsFx8_aNwVoXJyUP8nVoOQj2oU_UiHnv0u8vFcCZQiXbFfZoPCpiXSxOK6YCadj4xw_k034_Scj-pCrwtw96gAf2zmtXT0c2K4qqLuB42kCuokwvhBkoQDix.QOZAdelTEd338sxgF4OeBQ"
    },
    config: [
        {
            key: 'mainLang',
            type: 'select',
            title: 'Main Language (Audio Language)',
            options: ['abk','afr','alb','amh','ara','arg','arm','asm','ast','azb','aze','baq','bel','ben','bos','bre','bul','bur','cat','chi','cze','dan','dut','ell','eng','epo','est','ext','fin','fre','geo','ger','gla','gle','glg','heb','hin','hrv','hun','ibo','ice','ina','ind','ita','jpn','kan','kaz','khm','kir','kor','kur','lav','lit','ltz','mac','mal','mar','may','mne','mni','mon','nav','nep','nor','oci','ori','per','pob','pol','pom','por','prs','pus','rum','rus','sat','scc','sin','slo','slv','sme','snd','som','spa','spl','spn','swa','swe','syr','tam','tat','tel','tet','tgl','tha','tok','tuk','tur','ukr','urd','uzb','vie','wel','wen','zhc','zhe','zht'],
            required: true,
            default: 'eng'
        },
        {
            key: 'transLang',
            type: 'select',
            title: 'Translation Language (Your Language)',
            options: ['abk','afr','alb','amh','ara','arg','arm','asm','ast','azb','aze','baq','bel','ben','bos','bre','bul','bur','cat','chi','cze','dan','dut','ell','eng','epo','est','ext','fin','fre','geo','ger','gla','gle','glg','heb','hin','hrv','hun','ibo','ice','ina','ind','ita','jpn','kan','kaz','khm','kir','kor','kur','lav','lit','ltz','mac','mal','mar','may','mne','mni','mon','nav','nep','nor','oci','ori','per','pob','pol','pom','por','prs','pus','rum','rus','sat','scc','sin','slo','slv','sme','snd','som','spa','spl','spn','swa','swe','syr','tam','tat','tel','tet','tgl','tha','tok','tuk','tur','ukr','urd','uzb','vie','wel','wen','zhc','zhe','zht'],
            required: true,
            default: 'tur'
        }
    ]
});

function setupRateLimitReset() {
    requestTimer = setInterval(() => {
        requestsThisMinute = 0;
        while (requestsThisMinute < MAX_REQUESTS_PER_MINUTE && requestQueue.length > 0) {
            const { resolve, reject, fn } = requestQueue.shift();
            executeWithRateLimit(fn, resolve, reject);
        }
    }, 60 * 1000);
    requestTimer.unref();
}

function executeWithRateLimit(fn, resolve, reject) {
    if (requestsThisMinute < MAX_REQUESTS_PER_MINUTE) {
        requestsThisMinute++;
        Promise.resolve()
            .then(fn)
            .then(resolve)
            .catch(reject);
    } else {
        requestQueue.push({ resolve, reject, fn });
        console.log(`Rate limit reached. Queued request. Queue size: ${requestQueue.length}`);
    }
}

function withRateLimit(fn) {
    if (!requestTimer) setupRateLimitReset();
    return new Promise((resolve, reject) => {
        executeWithRateLimit(fn, resolve, reject);
    });
}

async function fetchAndSelectSubtitle(languageId, baseSearchParams) {
    const searchParams = { ...baseSearchParams, sublanguageid: languageId };
    const searchUrl = buildSearchUrl(searchParams);
    console.log(`Searching ${languageId} subtitles at: ${searchUrl}`);
    try {
        const response = await withRateLimit(() =>
            axios.get(searchUrl, {
                headers: { 'User-Agent': 'TemporaryUserAgent' },
                timeout: 10000
            })
        );
        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
            console.log(`No ${languageId} subtitles found or invalid API response.`);
            return null;
        }
        const validFormatSubs = response.data.filter(subtitle =>
            subtitle.SubDownloadLink &&
            subtitle.SubFormat &&
            ['srt', 'vtt', 'sub', 'ass'].includes(subtitle.SubFormat.toLowerCase())
        );
        if (validFormatSubs.length === 0) {
            console.log(`No suitable subtitle format found for ${languageId}.`);
            return null;
        }
        validFormatSubs.sort((a, b) => {
            const downloadsA = parseInt(a.SubDownloadsCnt, 10) || 0;
            const downloadsB = parseInt(b.SubDownloadsCnt, 10) || 0;
            return downloadsB - downloadsA;
        });
        const subtitleList = validFormatSubs.map(sub => {
            const directUrl = sub.SubDownloadLink;
            let subtitleUrl = directUrl;
            if (directUrl.endsWith('.gz')) {
                console.log(`Found gzipped subtitle for ${languageId} (ID: ${sub.IDSubtitleFile}). Fetch function will handle decompression.`);
            }
            return {
                id: sub.IDSubtitleFile,
                url: subtitleUrl,
                lang: sub.SubLanguageID,
                format: sub.SubFormat,
                langName: sub.LanguageName,
                releaseName: sub.MovieReleaseName || sub.MovieName || 'Unknown',
                rating: parseFloat(sub.SubRating) || 0,
                downloads: parseInt(sub.SubDownloadsCnt, 10) || 0
            };
        });
        console.log(`Found ${subtitleList.length} valid subtitles for ${languageId}, sorted by downloads.`);
        return subtitleList;
    } catch (error) {
        console.error(`Error fetching ${languageId} subtitles:`, error.message);
        if (error.response && error.response.status === 429) {
            console.log(`Rate limit exceeded from OpenSubtitles API while fetching ${languageId}`);
        }
        return null;
    }
}

async function fetchSubtitleContent(url) {
    console.log(`Fetching subtitle content from: ${url}`);
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000
        });
        let contentBuffer = Buffer.from(response.data);
        let subtitleText;
        if (url.endsWith('.gz') || (contentBuffer.length > 2 && contentBuffer[0] === 0x1f && contentBuffer[1] === 0x8b)) {
            console.log(`Decompressing gzipped subtitle: ${url}`);
            try {
                contentBuffer = Buffer.from(pako.ungzip(contentBuffer));
                console.log(`Decompressed size: ${contentBuffer.length}`);
            } catch (unzipError) {
                console.error(`Error decompressing subtitle ${url}: ${unzipError.message}`);
                return null;
            }
        }
        let detectedEncoding = 'utf8';
        let rawDetectedEncoding = null;
        try {
            rawDetectedEncoding = chardet.detect(contentBuffer);
            console.log(`chardet raw detection: encoding=${rawDetectedEncoding}`);
            if (rawDetectedEncoding) {
                const normalizedEncoding = rawDetectedEncoding.toLowerCase();
                switch (normalizedEncoding) {
                    case 'windows-1254': detectedEncoding = 'win1254'; break;
                    case 'iso-8859-9': detectedEncoding = 'iso88599'; break;
                    case 'windows-1252': detectedEncoding = 'win1252'; break;
                    case 'utf-16le': detectedEncoding = 'utf16le'; break;
                    case 'utf-16be': detectedEncoding = 'utf16be'; break;
                    case 'ascii':
                    case 'us-ascii': detectedEncoding = 'utf8'; break;
                    case 'utf-8': detectedEncoding = 'utf8'; break;
                    default:
                        if (iconv.encodingExists(normalizedEncoding)) {
                            detectedEncoding = normalizedEncoding;
                        } else {
                            console.warn(`Detected encoding '${rawDetectedEncoding}' not directly supported by iconv-lite or mapped. Falling back to UTF-8.`);
                            detectedEncoding = 'utf8';
                        }
                }
                console.log(`Detected encoding: ${rawDetectedEncoding}, using: ${detectedEncoding}`);
            } else {
                console.log(`Encoding detection failed for ${url}. Defaulting to UTF-8.`);
                if (contentBuffer.length > 3 && contentBuffer[0] === 0xEF && contentBuffer[1] === 0xBB && contentBuffer[2] === 0xBF) {
                    console.log("Found UTF-8 BOM, removing it before potential decode.");
                    contentBuffer = contentBuffer.subarray(3);
                }
            }
        } catch (detectionError) {
            console.warn(`Error during encoding detection for ${url}: ${detectionError.message}. Defaulting to UTF-8.`);
        }
        try {
            subtitleText = iconv.decode(contentBuffer, detectedEncoding);
            console.log(`Successfully decoded subtitle ${url} using ${detectedEncoding}.`);
            if (detectedEncoding === 'utf8' && subtitleText.charCodeAt(0) === 0xFEFF) {
                console.log("Found BOM character after UTF-8 decode, removing it.");
                subtitleText = subtitleText.substring(1);
            }
        } catch (decodeError) {
            console.error(`Error decoding subtitle ${url} with encoding ${detectedEncoding}: ${decodeError.message}`);
            console.warn(`Falling back to latin1 decoding for ${url}`);
            try {
                subtitleText = iconv.decode(contentBuffer, 'latin1');
            } catch (fallbackError) {
                console.error(`Fallback decoding as latin1 also failed for ${url}: ${fallbackError.message}`);
                return null;
            }
        }
        console.log(`Successfully fetched and processed subtitle: ${url}`);
        return subtitleText;
    } catch (error) {
        console.error(`Error fetching subtitle content from ${url}:`, error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Headers: ${JSON.stringify(error.response.headers)}`);
        }
        return null;
    }
}

function parseTimeToMs(timeString) {
    if (!timeString || !/\d{2}:\d{2}:\d{2},\d{3}/.test(timeString)) {
        console.error(`Invalid time format encountered: ${timeString}`);
        return 0;
    }
    const parts = timeString.split(':');
    const secondsParts = parts[2].split(',');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(secondsParts[0], 10);
    const milliseconds = parseInt(secondsParts[1], 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

// --- SOLO TRADUZIONE ---
// Qui viene mostrata SOLO la traduzione (flatTransText)
function mergeSubtitles(mainSubs, transSubs, mergeThresholdMs = 500) {
    console.log(`Merging ${mainSubs.length} main subs with ${transSubs.length} translation subs.`);
    const mergedSubs = [];
    let transIndex = 0;
    for (const mainSub of mainSubs) {
        let foundMatch = false;
        let bestMatchIndex = -1;
        let smallestTimeDiff = Infinity;
        if (!mainSub || !mainSub.startTime || !mainSub.endTime) {
            console.warn("Skipping invalid main subtitle entry:", mainSub);
            continue;
        }
        const mainStartTime = parseTimeToMs(mainSub.startTime);
        const mainEndTime = parseTimeToMs(mainSub.endTime);
        for (let i = transIndex; i < transSubs.length; i++) {
            const transSub = transSubs[i];
            if (!transSub || !transSub.startTime || !transSub.endTime) {
                console.warn("Skipping invalid translation subtitle entry:", transSub);
                continue;
            }
            const transStartTime = parseTimeToMs(transSub.startTime);
            const transEndTime = parseTimeToMs(transSub.endTime);
            const startsOverlap = (transStartTime >= mainStartTime && transStartTime < mainEndTime);
            const endsOverlap = (transEndTime > mainStartTime && transEndTime <= mainEndTime);
            const isWithin = (transStartTime >= mainStartTime && transEndTime <= mainEndTime);
            const contains = (transStartTime < mainStartTime && transEndTime > mainEndTime);
            const timeDiff = Math.abs(mainStartTime - transStartTime);
            if (startsOverlap || endsOverlap || isWithin || contains || timeDiff < mergeThresholdMs) {
                if (timeDiff < smallestTimeDiff) {
                    smallestTimeDiff = timeDiff;
                    bestMatchIndex = i;
                }
                foundMatch = true;
            } else if (foundMatch && transStartTime > mainEndTime + mergeThresholdMs) {
                break;
            } else if (!foundMatch && transStartTime > mainEndTime + mergeThresholdMs) {
                break;
            }
            if (transEndTime < mainStartTime - mergeThresholdMs * 2 && i === transIndex) {
                transIndex = i + 1;
            }
        }
        if (bestMatchIndex !== -1) {
            const bestTransSub = transSubs[bestMatchIndex];
            const flatTransText = bestTransSub.text.replace(/\r?\n|\r/g, ' ');
            mergedSubs.push({
                ...mainSub,
                text: flatTransText // SOLO LA TRADUZIONE
            });
        } else {
            mergedSubs.push({
                ...mainSub,
                text: '' // Nessuna traduzione trovata: sottotitolo vuoto
            });
        }
    }
    console.log(`Finished merging. Result has ${mergedSubs.length} entries.`);
    return mergedSubs;
}

// (Resto del codice: parsing SRT, costruzione URL, gestione Stremio, ecc. invariati)

// Helper function to build the OpenSubtitles search URL
function buildSearchUrl(params) {
    if (params.episode) {
        // ... (implementazione originale)
    }
    // ... (implementazione originale)
}

// (Aggiungi qui tutte le altre funzioni e la logica principale del tuo addon, invariati rispetto all’originale)

module.exports = builder.getInterface();
if (require.main === module) serveHTTP(builder, { port: ADDON_PORT });
