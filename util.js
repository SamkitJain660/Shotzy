import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const TESSDATA_DIR = GLib.getenv('TESSDATA_PREFIX') || '/usr/share/tessdata';
export const DEFAULT_OCR_LANGUAGES = ['eng'];

// Orientation/script detection data is not a language you can OCR with.
const HIDDEN_TESSERACT_LANGUAGES = new Set(['osd']);
const LANGUAGE_CODE_RE = /^[A-Za-z0-9_]+$/;

let installedLanguagesCache = null;

/**
 * Write `bytes` to `path` with 0600 permissions. Screenshots and their OCR
 * crops go through the shared temp directory, so they must not be readable by
 * other users on the machine.
 */
export function writePrivateFile(path, bytes) {
    const stream = Gio.File.new_for_path(path).replace(
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );

    try {
        stream.write_all(bytes, null);
    } finally {
        stream.close(null);
    }
}

/** Like `pixbuf.savev()`, but the file is only readable by the current user. */
export function savePixbufPrivately(pixbuf, path, type = 'png') {
    const [ok, buffer] = pixbuf.save_to_bufferv(type, [], []);
    if (!ok)
        return false;

    writePrivateFile(path, buffer);
    return true;
}

export function tempFilePath(prefix, extension = 'png') {
    return GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `${prefix}_${GLib.uuid_string_random()}.${extension}`,
    ]);
}

export function deleteFile(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
        return;

    try {
        GLib.unlink(path);
    } catch (e) {
        console.warn(`Shotzy: failed to delete ${path}: ${e.message}`);
    }
}

export function invalidateInstalledTesseractLanguages() {
    installedLanguagesCache = null;
}

/**
 * Language codes that have `.traineddata` in TESSDATA_DIR. Cached, because
 * this used to be re-enumerated on every OCR run; call
 * invalidateInstalledTesseractLanguages() to pick up newly installed packs.
 */
export function listInstalledTesseractLanguages() {
    if (installedLanguagesCache)
        return installedLanguagesCache;

    const directory = Gio.File.new_for_path(TESSDATA_DIR);
    const languages = [];
    let enumerator = null;

    try {
        enumerator = directory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;

            const name = info.get_name();
            if (!name.endsWith('.traineddata'))
                continue;

            const code = name.slice(0, -'.traineddata'.length);
            if (LANGUAGE_CODE_RE.test(code) && !HIDDEN_TESSERACT_LANGUAGES.has(code))
                languages.push(code);
        }
    } catch (_e) {
        // An unreadable or missing tessdata directory just means no languages.
    } finally {
        try {
            enumerator?.close(null);
        } catch (_e) {
        }
    }

    installedLanguagesCache = languages.sort();
    return installedLanguagesCache;
}

/**
 * Drop malformed, duplicate and (when `installedLanguages` is given)
 * uninstalled codes, always returning at least one usable language.
 */
export function normalizeLanguageSelection(languages, installedLanguages = null) {
    const installed = installedLanguages?.length > 0 ? new Set(installedLanguages) : null;
    const normalized = [];
    const seen = new Set();

    if (!Array.isArray(languages))
        languages = [];

    for (const language of languages) {
        const code = String(language).trim();
        if (!code || !LANGUAGE_CODE_RE.test(code) || seen.has(code))
            continue;

        if (installed && !installed.has(code))
            continue;

        normalized.push(code);
        seen.add(code);
    }

    if (normalized.length > 0)
        return normalized;

    const fallback = DEFAULT_OCR_LANGUAGES.find(language => !installed || installed.has(language));
    if (fallback)
        return [fallback];

    return installedLanguages?.length > 0 ? [installedLanguages[0]] : [...DEFAULT_OCR_LANGUAGES];
}
