/*
 * Daybook voice recorder. Runs entirely on the phone.
 *
 * Records the microphone with MediaRecorder into memory, then hands back one
 * audio Blob that the app stores in IndexedDB. Nothing is streamed or sent
 * anywhere. The level meter uses Web Audio on the phone, only to draw the bars.
 */
(function (global) {
  'use strict';

  // iPhone Safari records AAC in an MP4 container; other browsers mostly Opus in WebM.
  var TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

  function VoiceError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function supported() {
    return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder);
  }

  function pickType() {
    if (!global.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < TYPES.length; i++) {
      try { if (MediaRecorder.isTypeSupported(TYPES[i])) return TYPES[i]; } catch (e) { /* try the next */ }
    }
    return '';
  }

  function baseType(t) { return String(t || '').split(';')[0].trim(); }

  // m:ss, or h:mm:ss for an hour or more.
  function formatDuration(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var mm = h ? (m < 10 ? '0' : '') + m : String(m);
    return (h ? h + ':' : '') + mm + ':' + (r < 10 ? '0' : '') + r;
  }

  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already stopped */ } });
  }

  /*
   * Starts recording. Resolves with a handle:
   *   elapsed()  seconds recorded so far
   *   level()    0..1 loudness right now, for the meter
   *   stop()     resolves with { blob, type, duration }
   *   cancel()   throws the recording away
   *   onend      set this to hear about a recording the system stopped by itself
   * Rejects with code 'unsupported', 'denied', 'no-mic' or 'failed'.
   */
  function start() {
    if (!supported()) return Promise.reject(VoiceError('unsupported', 'Recording is not available here'));
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).catch(function (err) {
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw VoiceError('denied', 'Microphone not allowed');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw VoiceError('no-mic', 'No microphone');
      throw VoiceError('failed', 'Could not start the microphone');
    }).then(function (stream) {
      var type = pickType();
      var rec;
      try {
        rec = type ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64000 }) : new MediaRecorder(stream);
      } catch (e) {
        try { rec = new MediaRecorder(stream); } catch (e2) {
          stopTracks(stream);
          throw VoiceError('failed', 'Could not start recording');
        }
      }

      var chunks = [];
      var startedAt = 0;
      var stoppedAt = 0;
      var finished = false;
      var cancelled = false;
      var resolveStop = null;
      var stopPromise = new Promise(function (resolve) { resolveStop = resolve; });

      // Loudness meter (optional: recording works without it).
      var ctx = null;
      var analyser = null;
      var samples = null;
      try {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (AC) {
          ctx = new AC();
          var source = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          samples = new Uint8Array(analyser.fftSize);
          source.connect(analyser);
          if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(function () {});
        }
      } catch (e) { ctx = null; analyser = null; }

      function cleanUp() {
        stopTracks(stream);
        if (ctx && ctx.close) ctx.close().catch(function () {});
        ctx = null;
        analyser = null;
      }

      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        stoppedAt = stoppedAt || performance.now();
        var wasFinished = finished;
        finished = true;
        cleanUp();
        var t = baseType(rec.mimeType || type || (chunks[0] && chunks[0].type) || 'audio/mp4');
        var result = cancelled ? null : {
          blob: new Blob(chunks, { type: t }),
          type: t,
          duration: Math.max(0, (stoppedAt - startedAt) / 1000)
        };
        chunks = [];
        resolveStop(result);
        // The system ended it (a phone call, the app going to the background, ...).
        if (!wasFinished && handle.onend) handle.onend(result);
      };
      rec.onerror = function () {
        if (rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* onstop follows */ } }
      };
      // If the microphone goes away mid-recording, keep what was recorded.
      stream.getTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* ignore */ } }
        });
      });

      var handle = {
        type: baseType(type),
        onend: null,
        elapsed: function () {
          if (!startedAt) return 0;
          return ((stoppedAt || performance.now()) - startedAt) / 1000;
        },
        level: function () {
          if (!analyser) return 0;
          analyser.getByteTimeDomainData(samples);
          var sum = 0;
          for (var i = 0; i < samples.length; i++) {
            var v = (samples[i] - 128) / 128;
            sum += v * v;
          }
          // Speech RMS sits around 0.02-0.3; spread it out so the bars move.
          return Math.min(1, Math.sqrt(sum / samples.length) * 4);
        },
        stop: function () {
          if (!finished) {
            finished = true;
            stoppedAt = performance.now();
            try {
              if (rec.state !== 'inactive') {
                if (rec.requestData) { try { rec.requestData(); } catch (e) { /* not needed */ } }
                rec.stop();
              } else {
                rec.onstop();
              }
            } catch (e) { rec.onstop(); }
          }
          return stopPromise;
        },
        cancel: function () {
          cancelled = true;
          return handle.stop().then(function () { return null; });
        }
      };

      try {
        // A timeslice keeps the audio coming in pieces, so an interruption loses little.
        rec.start(1000);
      } catch (e) {
        cleanUp();
        throw VoiceError('failed', 'Could not start recording');
      }
      startedAt = performance.now();
      return handle;
    });
  }

  global.DaybookVoice = {
    supported: supported,
    pickType: pickType,
    formatDuration: formatDuration,
    start: start
  };
})(typeof window !== 'undefined' ? window : globalThis);
