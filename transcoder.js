// Copyright (C) 2017-2025 Smart code 203358507

// Minimal audio transcoding layer that speaks the part of the streaming server API
// which stremio-video uses (`/hlsv2/probe` and `/hlsv2/:id/master.m3u8`).
// Video is copied untouched, the first audio track is re-encoded to AAC.
// It only handles http(s) media URLs; torrents still need a real streaming server.

const { spawn, execFile } = require('child_process');
const dns = require('dns').promises;
const express = require('express');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SEGMENT_PATTERN = /^seg\d{5}\.ts$/;
const PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto';
const IO_TIMEOUT = 30 * 1000 * 1000; // ffmpeg rw_timeout, in microseconds
const PLAYLIST_WAIT = 45 * 1000;
const SEGMENT_DURATION = 6;
const CLEANUP_INTERVAL = 30 * 1000;

const isPrivateAddress = (address) => {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127);
    }

    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
        return isPrivateAddress(normalized.slice(7));
    }

    return normalized === '::' || normalized === '::1' || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
};

// Rejects anything but http(s) URLs, and hosts on private networks unless explicitly allowed,
// so the service can't be used to reach into the server's own network.
const validateMediaURL = async (mediaURL, allowPrivate) => {
    let url;
    try {
        url = new URL(mediaURL);
    } catch (_) {
        throw new Error('Invalid mediaURL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Unsupported mediaURL protocol');
    }

    if (!allowPrivate) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
        if (addresses.some(({ address }) => isPrivateAddress(address))) {
            throw new Error('mediaURL points to a private address');
        }
    }

    return url.toString();
};

const mapProbe = (probe) => {
    const streams = (probe.streams || [])
        .filter((stream) => !(stream.disposition && stream.disposition.attached_pic))
        .map((stream) => ({
            id: stream.index,
            track: stream.codec_type === 'video' || stream.codec_type === 'audio' ? stream.codec_type : null,
            codec: stream.codec_name,
            channels: stream.channels,
            language: stream.tags && stream.tags.language,
            title: stream.tags && stream.tags.title
        }))
        // Embedded subtitles are not served by this layer, so they are not reported;
        // otherwise the player would wait for subtitle sources that never come.
        .filter((stream) => stream.track !== null);

    return {
        format: {
            name: probe.format && probe.format.format_name,
            duration: probe.format && Number(probe.format.duration)
        },
        streams
    };
};

const createTranscoder = (options = {}) => {
    const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    const maxSessions = options.maxSessions || Number(process.env.TRANSCODER_MAX_SESSIONS) || 2;
    const sessionTTL = options.sessionTTL || Number(process.env.TRANSCODER_SESSION_TTL) || 10 * 60 * 1000;
    const allowPrivate = options.allowPrivate !== undefined ? options.allowPrivate : process.env.TRANSCODER_ALLOW_PRIVATE === '1';
    const corsOrigin = options.corsOrigin || process.env.TRANSCODER_CORS_ORIGIN || null;
    const tmpRoot = options.tmpRoot || os.tmpdir();

    const sessions = new Map();

    const destroySession = (id) => {
        const session = sessions.get(id);
        if (!session) {
            return;
        }

        sessions.delete(id);
        session.process.kill('SIGKILL');
        fs.rm(session.dir, { recursive: true, force: true }, () => { });
    };

    const startSession = async (id, mediaURL, maxAudioChannels) => {
        const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'stremio-transcode-'));
        const args = [
            '-nostdin', '-loglevel', 'error',
            '-protocol_whitelist', PROTOCOL_WHITELIST,
            '-rw_timeout', String(IO_TIMEOUT),
            '-i', mediaURL,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            ...(maxAudioChannels <= 2 ? ['-ac', '2'] : []),
            '-sn', '-dn',
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_playlist_type', 'event',
            '-hls_flags', 'independent_segments',
            '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
            path.join(dir, 'index.m3u8')
        ];
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const session = { dir, process: child, lastAccess: Date.now(), error: null, exited: false };
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-2000);
        });
        child.on('error', (error) => {
            session.error = error.message;
            session.exited = true;
        });
        child.on('exit', (code) => {
            session.exited = true;
            if (code !== 0 && code !== null) {
                session.error = stderr.trim() || `ffmpeg exited with code ${code}`;
            }
        });
        sessions.set(id, session);
        return session;
    };

    const waitForPlaylist = async (session) => {
        const playlistPath = path.join(session.dir, 'index.m3u8');
        const deadline = Date.now() + PLAYLIST_WAIT;
        while (Date.now() < deadline) {
            try {
                const playlist = await fs.promises.readFile(playlistPath, 'utf8');
                if (playlist.includes('.ts')) {
                    return;
                }
            } catch (_) { /* not written yet */ }

            if (session.exited) {
                throw new Error(session.error || 'Transcoding failed');
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        throw new Error('Timed out waiting for the transcoder');
    };

    const router = express.Router();

    router.use((_req, res, next) => {
        if (corsOrigin) {
            res.set('access-control-allow-origin', corsOrigin);
        }

        next();
    });

    router.get('/transcoder/status', (_req, res) => {
        res.json({ enabled: true });
    });

    router.get('/hlsv2/probe', async (req, res) => {
        try {
            const mediaURL = await validateMediaURL(String(req.query.mediaURL || ''), allowPrivate);
            const stdout = await new Promise((resolve, reject) => {
                execFile(ffprobePath, [
                    '-v', 'error',
                    '-protocol_whitelist', PROTOCOL_WHITELIST,
                    '-rw_timeout', String(IO_TIMEOUT),
                    '-print_format', 'json', '-show_format', '-show_streams',
                    mediaURL
                ], { timeout: 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (error, out) => error ? reject(error) : resolve(out));
            });
            res.json(mapProbe(JSON.parse(stdout)));
        } catch (error) {
            res.status(502).json({ error: error.message });
        }
    });

    router.get('/hlsv2/:id/master.m3u8', async (req, res) => {
        const { id } = req.params;
        if (!SESSION_ID_PATTERN.test(id)) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        try {
            let session = sessions.get(id);
            if (!session) {
                if (sessions.size >= maxSessions) {
                    return res.status(503).json({ error: 'Too many active transcoding sessions' });
                }

                const mediaURL = await validateMediaURL(String(req.query.mediaURL || ''), allowPrivate);
                const maxAudioChannels = Number(req.query.maxAudioChannels) || 2;
                session = await startSession(id, mediaURL, maxAudioChannels);
            }

            session.lastAccess = Date.now();
            await waitForPlaylist(session);
            res.set('cache-control', 'no-store').type('application/vnd.apple.mpegurl')
                .send('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nstream.m3u8\n');
        } catch (error) {
            destroySession(id);
            res.status(502).json({ error: error.message });
        }
    });

    router.get('/hlsv2/:id/stream.m3u8', (req, res) => {
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.sendStatus(404);
        }

        session.lastAccess = Date.now();
        res.set('cache-control', 'no-store').type('application/vnd.apple.mpegurl')
            .sendFile('index.m3u8', { root: session.dir }, (error) => error && !res.headersSent && res.sendStatus(404));
    });

    router.get('/hlsv2/:id/:segment', (req, res) => {
        const session = sessions.get(req.params.id);
        if (!session || !SEGMENT_PATTERN.test(req.params.segment)) {
            return res.sendStatus(404);
        }

        session.lastAccess = Date.now();
        res.type('video/mp2t')
            .sendFile(req.params.segment, { root: session.dir }, (error) => error && !res.headersSent && res.sendStatus(404));
    });

    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        sessions.forEach((session, id) => {
            if (now - session.lastAccess > sessionTTL) {
                destroySession(id);
            }
        });
    }, CLEANUP_INTERVAL);
    cleanupTimer.unref();

    router.close = () => {
        clearInterval(cleanupTimer);
        Array.from(sessions.keys()).forEach(destroySession);
    };

    return router;
};

module.exports = { createTranscoder, validateMediaURL, isPrivateAddress, mapProbe };
