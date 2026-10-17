/*
 * Daybook photo processing. Runs entirely on the phone.
 *
 * Each photo is redrawn onto a canvas and saved as a new JPEG, which:
 *  - shrinks it (long edge at most 2048 px) so the notebook stays small,
 *  - makes a separate small thumbnail for the day page,
 *  - drops all hidden metadata (EXIF), including the location the camera
 *    may have recorded, because a canvas only carries pixels.
 */
(function (global) {
  'use strict';

  var FULL_EDGE = 2048;
  var FULL_QUALITY = 0.82;
  var THUMB_EDGE = 600;
  var THUMB_QUALITY = 0.72;

  function PhotoError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(PhotoError('unreadable', 'Could not read this image'));
      };
      img.src = url;
    });
  }

  function fit(w, h, edge) {
    var s = Math.min(1, edge / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Frees canvas memory straight away (iOS limits total canvas memory).
  function release(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  // Draws source (w x h) at (tw x th), halving in steps for big reductions so it stays sharp.
  function scale(source, w, h, tw, th) {
    var cur = source;
    var cw = w;
    var ch = h;
    var temp = null;
    while (cw / 2 >= tw && ch / 2 >= th) {
      var nw = Math.round(cw / 2);
      var nh = Math.round(ch / 2);
      var step = makeCanvas(nw, nh);
      var sctx = step.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, nw, nh);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(cur, 0, 0, nw, nh);
      if (temp) release(temp);
      temp = step;
      cur = step;
      cw = nw;
      ch = nh;
    }
    var out = makeCanvas(tw, th);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; // transparent areas (e.g. PNG) become white, not black
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, tw, th);
    if (temp) release(temp);
    return out;
  }

  function toJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(PhotoError('encode', 'Could not save this image'));
      }, 'image/jpeg', quality);
    });
  }

  /*
   * Turns a picked file into { blob, thumb, width, height }.
   * Rejects with code 'not-image' or 'unreadable' when it can't be used.
   */
  function processFile(file) {
    if (!file || (file.type && file.type.indexOf('image/') !== 0)) {
      return Promise.reject(PhotoError('not-image', 'Not an image'));
    }
    return loadImage(file).then(function (loaded) {
      var img = loaded.img;
      // Browsers apply the camera's rotation (EXIF orientation) to natural sizes and drawing.
      var sw = img.naturalWidth;
      var sh = img.naturalHeight;
      if (!sw || !sh) {
        URL.revokeObjectURL(loaded.url);
        throw PhotoError('unreadable', 'Could not read this image');
      }
      var full = fit(sw, sh, FULL_EDGE);
      var fullCanvas;
      try {
        fullCanvas = scale(img, sw, sh, full.w, full.h);
      } finally {
        URL.revokeObjectURL(loaded.url);
        img.src = '';
      }
      var t = fit(full.w, full.h, THUMB_EDGE);
      var thumbCanvas = scale(fullCanvas, full.w, full.h, t.w, t.h);
      return Promise.all([toJpeg(fullCanvas, FULL_QUALITY), toJpeg(thumbCanvas, THUMB_QUALITY)]).then(function (blobs) {
        release(fullCanvas);
        release(thumbCanvas);
        return { blob: blobs[0], thumb: blobs[1], width: full.w, height: full.h };
      }, function (err) {
        release(fullCanvas);
        release(thumbCanvas);
        throw err;
      });
    });
  }

  global.DaybookPhotos = {
    FULL_EDGE: FULL_EDGE,
    THUMB_EDGE: THUMB_EDGE,
    processFile: processFile
  };
})(typeof window !== 'undefined' ? window : globalThis);
