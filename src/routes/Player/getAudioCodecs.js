// Copyright (C) 2017-2025 Smart code 203358507

// The Tesla in-car browser is Chromium based and reports codecs such as AC3/EAC3 as playable,
// but has no usable decoder for them. AAC is the one codec it plays reliably, so we only
// advertise AAC and let the streaming server transcode any other audio track to it.
const TESLA_AUDIO_CODECS = ['aac'];

const isTesla = () => {
    return typeof navigator === 'object' && /\bTesla\//i.test(navigator.userAgent);
};

// Returns the list of audio codecs the player may use without transcoding,
// or null to keep the default detection done by stremio-video.
// The `audioCodecs` query param (e.g. `?audioCodecs=aac`) overrides it for testing on other devices.
const getAudioCodecs = (queryParams) => {
    const override = queryParams.get('audioCodecs');
    if (override) {
        return override.split(',').map((codec) => codec.trim().toLowerCase()).filter(Boolean);
    }

    return isTesla() ? TESLA_AUDIO_CODECS : null;
};

module.exports = getAudioCodecs;
