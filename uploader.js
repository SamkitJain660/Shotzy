import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class LensUploader {
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

            launcherPath = GLib.build_filenamev([
                GLib.get_tmp_dir(),
                `shotzy_upload_${GLib.uuid_string_random()}.html`,
            ]);

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

            GLib.file_set_contents(launcherPath, launcherHtml);

            const launcherFile = Gio.File.new_for_path(launcherPath);
            Gio.AppInfo.launch_default_for_uri(launcherFile.get_uri(), null);

            this._scheduleDelete(launcherPath, 60);
        } catch (e) {
            if (launcherPath)
                this._deleteFile(launcherPath);

            log(`Shotzy upload failed: ${e.message}`);
            throw e;
        } finally {
            this._deleteFile(filePath);
        }
    }

    _scheduleDelete(path, delaySeconds) {
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySeconds, () => {
            this._deleteFile(path);
            return GLib.SOURCE_REMOVE;
        });
    }

    _deleteFile(path) {
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return;

        try {
            GLib.unlink(path);
        } catch (e) {
            log(`Shotzy cleanup failed for ${path}: ${e.message}`);
        }
    }
}
