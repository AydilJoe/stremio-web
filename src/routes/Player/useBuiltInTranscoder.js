// Copyright (C) 2017-2025 Smart code 203358507

const React = require('react');

// Looks for the optional transcoding layer served next to the web app (see transcoder.js).
// Resolves to undefined while checking, to null when unavailable, otherwise to the base URL to use.
const useBuiltInTranscoder = (enabled) => {
    const [url, setUrl] = React.useState(enabled ? undefined : null);

    React.useEffect(() => {
        if (!enabled) {
            setUrl(null);
            return;
        }

        let cancelled = false;
        fetch('/transcoder/status')
            .then((resp) => resp.ok ? resp.json() : null)
            .then((status) => !cancelled && setUrl(status && status.enabled ? window.location.origin : null))
            .catch(() => !cancelled && setUrl(null));

        return () => {
            cancelled = true;
        };
    }, [enabled]);

    return url;
};

module.exports = useBuiltInTranscoder;
