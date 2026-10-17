/**
 * The browser side of uploading a document.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * The service layer was built for a three-step upload: issue a ticket, PUT the
 * bytes straight to storage, confirm. `confirmUpload` says so in its own
 * comment — "called by the client once the PUT succeeds. Only now is it a real
 * document."
 *
 * The web route did the first and third steps and skipped the second. Every
 * document in the product was therefore a row that said a file had been
 * uploaded, with nothing behind its key — the exact failure the route's own
 * comment warns about one layer up, where it refuses to register a document when
 * no storage is configured because "it looks filed". It looked filed.
 *
 * This is the missing step.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE BYTES DO NOT GO THROUGH THE APPLICATION
 *
 * A multipart POST to the server would need no JavaScript, which is genuinely
 * attractive. It would also mean writing a multipart parser with no
 * dependencies — a format where a parsing mistake is a security bug — and
 * streaming every customer's accounts through the web process.
 *
 * The presigned PUT already exists, is already tested, and already works
 * identically against the local driver and a bucket. So the browser does the
 * PUT. Against the local driver that PUT is same-origin and the existing
 * `connect-src 'self'` covers it; against a bucket it is not, which is why
 * `STORAGE_ORIGIN` exists and why forgetting to set it fails loudly rather than
 * mysteriously.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WITHOUT JAVASCRIPT
 *
 * The form still submits and the document is still registered — but a browser
 * cannot send bytes from a file input through a urlencoded form, so no file
 * arrives. The row then stays in `AWAITING_UPLOAD`, and the documents page
 * already says what that means: "This document is registered, but no file was
 * ever uploaded against it." That is the honest degradation. The alternative —
 * confirming anyway — is what was there before.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A STRING IN A MODULE
 *
 * Same reason as `stylesheet()` and `icon()`: the product ships as source with
 * no build step, and a separate static file is one more thing a deployment can
 * fail to copy. The content-security policy forbids inline script, so it is
 * served from `/assets/upload.js` and loaded with a tag — not inlined.
 */

export function uploadScript() {
  return `/* RaiseRoom — document upload. Served from /assets/upload.js. */
(function () {
  'use strict';

  function say(form, message, tone) {
    var line = form.querySelector('[data-upload-status]');
    if (!line) {
      line = document.createElement('p');
      line.setAttribute('data-upload-status', '');
      form.appendChild(line);
    }
    line.className = tone === 'bad' ? 'note note-bad' : 'note';
    line.textContent = message;
    return line;
  }

  function readable(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' kB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function send(url, fields) {
    var body = new URLSearchParams();
    Object.keys(fields).forEach(function (k) { body.set(k, fields[k]); });
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body,
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      throw new Error((data && data.error && data.error.message) || 'That was refused.');
    }
    return data;
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-upload')) return;

    var input = form.querySelector('input[type="file"]');
    var file = input && input.files && input.files[0];
    // No file chosen: let the form post as it would without this script, so the
    // server gets to give its own answer rather than this script inventing one.
    if (!file) return;

    event.preventDefault();

    var button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    var kindField = form.querySelector('[name="kind"]');
    var csrf = form.querySelector('[name="csrf"]');

    (async function () {
      try {
        say(form, 'Registering ' + file.name + ' (' + readable(file.size) + ')…');
        var ticket = await send(form.getAttribute('action'), {
          filename: file.name,
          size_bytes: String(file.size),
          // Recorded, never trusted. Objects are always served as attachments
          // with a type this application chose, so a lying content type buys
          // nothing — see serveObject.
          mime_type: file.type || 'application/octet-stream',
          kind: kindField ? kindField.value : 'OTHER',
          csrf: csrf ? csrf.value : '',
        });

        say(form, 'Uploading…');
        var put = await fetch(ticket.upload.url, {
          method: ticket.upload.method || 'PUT',
          headers: ticket.upload.headers || {},
          body: file,
        });
        if (!put.ok) {
          // Deliberately not confirmed. The row stays in AWAITING_UPLOAD and
          // the page says so, which is true; confirming here is the bug this
          // whole file exists to fix.
          throw new Error('The file could not be stored (' + put.status + '). The document is '
            + 'registered but has no file against it — try the upload again.');
        }

        say(form, 'Finishing…');
        await send(ticket.confirm_url, { csrf: csrf ? csrf.value : '' });
        window.location.reload();
      } catch (err) {
        say(form, err.message || 'The upload failed.', 'bad');
        if (button) button.disabled = false;
      }
    }());
  });
}());
`;
}
