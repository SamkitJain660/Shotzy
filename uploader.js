import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { deleteFile, tempFilePath, writePrivateFile } from './util.js';

const LAUNCHER_LIFETIME_SECONDS = 60;

export class LensUploader {
    constructor() {
        // path -> GLib source id, so pending cleanups can be flushed on disable.
        this._pendingCleanups = new Map();
    }

    destroy() {
        for (const [path, sourceId] of this._pendingCleanups) {
            GLib.source_remove(sourceId);
            deleteFile(path);
        }
        this._pendingCleanups.clear();
    }

    async upload(filePath) {
        const file = Gio.File.new_for_path(filePath);
        let launcherPath = null;

        try {
            const contents = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (_obj, res) => {
                    try {
                        const [success, bytes] = file.load_contents_finish(res);
                        if (!success) {
                            reject(new Error('Read failed'));
                            return;
                        }

                        resolve(bytes);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            const guessedType = Gio.content_type_guess(filePath, contents)[0];
            const mimeType = Gio.content_type_get_mime_type(guessedType) ?? 'application/octet-stream';
            const imageDataUrl = `data:${mimeType};base64,${GLib.base64_encode(contents)}`;

            launcherPath = tempFilePath('shotzy_upload', 'html');

            const launcherHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shotzy Upload</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:sans-serif;background:#f6f7fb;color:#202124;">
  <div id="status">Uploading to Google Lens...</div>
  <script>
    (async () => {
      try {
        const imageDataUrl = ${JSON.stringify(imageDataUrl)};

        const container = document.createElement("div");
        container.style.display = "none";
        document.body.appendChild(container);

        const form = document.createElement("form");
        form.action = \`https://lens.google.com/v3/upload?ep=ccm&s=&st=\${Date.now()}\`;
        form.method = "POST";
        form.enctype = "multipart/form-data";
        container.appendChild(form);

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.name = "encoded_image";
        form.appendChild(fileInput);

        const dimensionsInput = document.createElement("input");
        dimensionsInput.type = "text";
        dimensionsInput.name = "processed_image_dimensions";
        dimensionsInput.value = "1000,1000";
        form.appendChild(dimensionsInput);

        const result = await fetch(imageDataUrl);
        const blob = await result.blob();
        const dataTransfer = new DataTransfer();
        const fileObject = new File([blob], "image", { type: blob.type || "application/octet-stream" });
        dataTransfer.items.add(fileObject);
        fileInput.files = dataTransfer.files;

        form.submit();
        container.remove();
      } catch (error) {
        document.getElementById("status").textContent = error.message;
      }
    })();
  </script>
</body>
</html>`;

            // The launcher embeds the screenshot, so keep it out of other users' reach.
            writePrivateFile(launcherPath, new TextEncoder().encode(launcherHtml));

            const launcherFile = Gio.File.new_for_path(launcherPath);
            Gio.AppInfo.launch_default_for_uri(launcherFile.get_uri(), null);

            this._scheduleDelete(launcherPath, LAUNCHER_LIFETIME_SECONDS);
        } catch (e) {
            if (launcherPath)
                deleteFile(launcherPath);

            console.error(`Shotzy upload failed: ${e.message}`);
            throw e;
        } finally {
            deleteFile(filePath);
        }
    }

    _scheduleDelete(path, delaySeconds) {
        const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySeconds, () => {
            this._pendingCleanups.delete(path);
            deleteFile(path);
            return GLib.SOURCE_REMOVE;
        });

        this._pendingCleanups.set(path, sourceId);
    }
}
