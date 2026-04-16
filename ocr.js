import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DEFAULT_STYLE = {
    fill: [0.10, 0.11, 0.13, 0.34],
    border: [0.92, 0.94, 0.97, 0.34],
    shadowOpacity: 0.18,
    glow: [1.00, 1.00, 1.00, 0.07],
    radius: 6,
    padding: 3,
    borderWidth: 1.25,
};

const DEFAULT_OCR = {
    enabled: true,
    confidence: 10,
    maxEdge: 2400,
    searchEngine: 'google',
};

const OCRHighlightOverlay = GObject.registerClass(
class OCRHighlightOverlay extends St.DrawingArea {
    _init() {
        super._init({
            reactive: false,
            visible: false,
        });

        this._boxes = [];
        this._style = DEFAULT_STYLE;
    }

    setBoxes(boxes) {
        this._boxes = boxes;
        this.visible = boxes.length > 0;
        this.queue_repaint();
    }

    setStyle(style) {
        this._style = style;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const shadow = [0, 0, 0, this._style.shadowOpacity];

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        for (const box of this._boxes) {
            const x = box.x - this._style.padding;
            const y = box.y - this._style.padding;
            const width = box.width + this._style.padding * 2;
            const height = box.height + this._style.padding * 2;
            const radius = Math.min(this._style.radius, width / 2, height / 2);

            cr.setSourceRGBA(...shadow);
            _roundedRect(cr, x, y + 2, width, height, radius + 1);
            cr.fill();

            cr.setSourceRGBA(...this._style.fill);
            _roundedRect(cr, x, y, width, height, radius);
            cr.fillPreserve();

            cr.setSourceRGBA(...this._style.border);
            cr.setLineWidth(this._style.borderWidth);
            cr.stroke();

            cr.setSourceRGBA(...this._style.glow);
            cr.setLineWidth(1);
            cr.moveTo(x + radius, y + 1.5);
            cr.lineTo(x + width - radius, y + 1.5);
            cr.stroke();
        }

        cr.$dispose();
    }
});

export class ScreenshotOCRController {
    constructor(settings = null) {
        this._settings = settings;
        this._overlay = null;
        this._hitboxLayer = null;
        this._copyMenu = null;
        this._copyButton = null;
        this._searchButton = null;
        this._activeBoxText = '';
        this._selectionBoxes = [];
        this._runId = 0;
        this._subprocess = null;
        this._selectionKey = null;
        this._settingsChangedId = 0;
        this._style = DEFAULT_STYLE;
        this._ocrConfig = DEFAULT_OCR;

        if (this._settings) {
            this._reloadSettings();
            this._settingsChangedId = this._settings.connect('changed', () => {
                this._reloadSettings();

                if (this._overlay)
                    this._overlay.setStyle(this._style);

                if (!this._ocrConfig.enabled)
                    this.reset();
                else
                    this.refreshSelection(Main.screenshotUI);
            });
        }
    }

    destroy() {
        this.reset();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

        if (this._hitboxLayer) {
            this._copyMenu?.destroy();
            this._copyMenu = null;
            this._copyButton?.destroy();
            this._copyButton = null;
            this._searchButton?.destroy();
            this._searchButton = null;
            this._hitboxLayer.destroy();
            this._hitboxLayer = null;
        }
    }

    reset() {
        this._runId++;
        this._cancelActiveSubprocess();
        this._selectionBoxes = [];
        this._selectionKey = null;

        if (this._overlay)
            this._overlay.setBoxes([]);

        this._rebuildHitboxes([], null);
        this._hideCopyMenu();
    }

    ensureAttached(ui) {
        if (this._overlay && this._hitboxLayer)
            return;

        if (!this._overlay) {
            this._overlay = new OCRHighlightOverlay();
            this._overlay.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));
            this._overlay.set_size(global.stage.width, global.stage.height);
            this._overlay.setStyle(this._style);

            ui._stageScreenshotContainer.insert_child_above(this._overlay, ui._stageScreenshot);
        }

        if (!this._hitboxLayer) {
            this._hitboxLayer = new St.Widget({
                reactive: false,
                x_expand: true,
                y_expand: true,
            });
            this._hitboxLayer.add_constraint(new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            }));

            this._copyMenu = new St.BoxLayout({
                vertical: false,
                visible: false,
                reactive: true,
                style: `
                    background-color: rgba(34, 36, 40, 0.96);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    border-radius: 12px;
                    padding: 8px 12px;
                    spacing: 12px;
                    color: #f3f4f6;
                `,
            });
            this._copyButton = new St.Button({
                label: 'Copy',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `
                    background-color: rgba(255,255,255,0.1);
                    border-radius: 8px;
                    padding: 6px 12px;
                    font-weight: bold;
                    color: white;
                `,
            });
            this._copyButton.connect('clicked', () => {
                this._copyActiveBoxText();
            });

            this._searchButton = new St.Button({
                label: 'Search',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `
                    background-color: rgba(255,255,255,0.1);
                    border-radius: 8px;
                    padding: 6px 12px;
                    font-weight: bold;
                    color: white;
                `,
            });
            this._searchButton.connect('clicked', () => {
                this._searchActiveBoxText();
            });

            this._copyMenu.add_child(this._copyButton);
            this._copyMenu.add_child(this._searchButton);
            this._hitboxLayer.add_child(this._copyMenu);

            ui.insert_child_above(this._hitboxLayer, ui._areaSelector);
        }
    }

    async start(ui) {
        this.ensureAttached(ui);
        await this._runSelectionPass(ui);
    }

    async refineSelection(ui) {
        await this._runSelectionPass(ui);
    }

    refreshSelection(ui) {
        if (!this._overlay || !ui || !this._ocrConfig.enabled || !ui._selectionButton?.checked) {
            if (this._overlay)
                this._overlay.setBoxes([]);
            this._rebuildHitboxes([], null);
            return;
        }

        const selection = this._getSelectionGeometry(ui);
        const selectionKey = this._makeSelectionKey(selection);
        if (!selectionKey || selectionKey !== this._selectionKey) {
            this._overlay.setBoxes([]);
            this._rebuildHitboxes([], null);
            return;
        }

        this._overlay.set_size(global.stage.width, global.stage.height);
        this._overlay.setBoxes(this._selectionBoxes);
        this._rebuildHitboxes(this._selectionBoxes, selection);
    }

    async _runSelectionPass(ui) {
        if (!this._ocrConfig.enabled)
            return;

        if (!GLib.find_program_in_path('tesseract'))
            return;

        if (!ui?._selectionButton?.checked)
            return;

        const selection = this._getSelectionGeometry(ui);
        const selectionKey = this._makeSelectionKey(selection);
        if (!selectionKey)
            return;

        if (selectionKey === this._selectionKey && this._selectionBoxes.length > 0) {
            this.refreshSelection(ui);
            return;
        }

        this.reset();
        const runId = this._runId;

        let capture = null;

        try {
            capture = await this._captureSelectionScreenshot(ui);
            if (!capture || runId !== this._runId)
                return;

            const tsv = await this._runTesseract(capture.path);
            if (runId !== this._runId)
                return;

            this._selectionBoxes = this._parseTsv(
                tsv,
                capture.coordinateScale,
                capture.offsetX,
                capture.offsetY,
                this._ocrConfig.confidence
            );
            this._selectionKey = selectionKey;
            this.refreshSelection(ui);
        } catch (e) {
            if (runId === this._runId)
                log('Shotzy OCR failed: ' + e.message);
        } finally {
            if (capture?.path)
                this._deleteFile(capture.path);
        }
    }

    _getSelectionGeometry(ui) {
        if (!ui?._selectionButton?.checked)
            return null;

        const geometry = ui._getSelectedGeometry(false);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0)
            return null;

        const [x, y, width, height] = geometry;
        return {x, y, width, height};
    }

    async _captureSelectionScreenshot(ui) {
        const scaledGeometry = ui._getSelectedGeometry(true);
        const unscaledGeometry = ui._getSelectedGeometry(false);

        if (!scaledGeometry || !unscaledGeometry || scaledGeometry[2] <= 0 || scaledGeometry[3] <= 0)
            return null;

        return this._captureTextureRegion(ui, {
            scaledGeometry,
            unscaledOrigin: {x: unscaledGeometry[0], y: unscaledGeometry[1]},
            maxLongEdge: this._ocrConfig.maxEdge,
        });
    }

    async _captureTextureRegion(ui, {scaledGeometry, unscaledOrigin, maxLongEdge}) {
        const content = ui._stageScreenshot?.get_content();

        if (!content)
            throw new Error('Missing screenshot content');

        const texture = content.get_texture();
        if (!texture)
            throw new Error('Missing screenshot texture');

        const stream = Gio.MemoryOutputStream.new_resizable();
        const [x, y, width, height] = scaledGeometry;

        const pixbuf = await Shell.Screenshot.composite_to_stream(
            texture,
            x, y, width, height,
            ui._scale,
            null, 0, 0, 1,
            stream
        );
        stream.close(null);

        const path = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `shotzy_ocr_${Date.now()}_${GLib.uuid_string_random()}.png`,
        ]);

        const sourceWidth = pixbuf.get_width();
        const sourceHeight = pixbuf.get_height();
        const longEdge = Math.max(sourceWidth, sourceHeight);
        const resizeScale = longEdge > maxLongEdge
            ? maxLongEdge / longEdge
            : 1;

        let savedPixbuf = pixbuf;
        if (resizeScale < 1) {
            const scaledWidth = Math.max(1, Math.round(sourceWidth * resizeScale));
            const scaledHeight = Math.max(1, Math.round(sourceHeight * resizeScale));
            savedPixbuf = pixbuf.scale_simple(
                scaledWidth,
                scaledHeight,
                GdkPixbuf.InterpType.BILINEAR
            );
        }

        if (!savedPixbuf || !savedPixbuf.savev(path, 'png', [], []))
            throw new Error('Failed to save OCR screenshot');

        return {
            path,
            coordinateScale: ui._scale * resizeScale,
            offsetX: unscaledOrigin.x,
            offsetY: unscaledOrigin.y,
            sourceWidth,
            sourceHeight,
            ocrWidth: savedPixbuf.get_width(),
            ocrHeight: savedPixbuf.get_height(),
            resizeScale,
        };
    }

    async _runTesseract(imagePath) {
        this._cancelActiveSubprocess();

        const subprocess = Gio.Subprocess.new(
            ['tesseract', imagePath, 'stdout', '--psm', '11', 'tsv'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        this._subprocess = subprocess;

        let stdout;
        let stderr;
        try {
            [, stdout, stderr] = await new Promise((resolve, reject) => {
                subprocess.communicate_utf8_async(null, null, (_proc, res) => {
                    try {
                        resolve(subprocess.communicate_utf8_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } finally {
            if (this._subprocess === subprocess)
                this._subprocess = null;
        }

        if (!subprocess.get_successful()) {
            const message = stderr?.trim() || `tesseract exited with ${subprocess.get_exit_status()}`;
            throw new Error(message);
        }

        return stdout ?? '';
    }

    _parseTsv(tsv, scale, offsetX = 0, offsetY = 0, minConfidence = this._ocrConfig.confidence) {
        const boxes = [];
        const lines = tsv.split('\n');

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trimEnd();
            if (!line)
                continue;

            const columns = line.split('\t');
            if (columns.length < 12)
                continue;

            const level = Number.parseInt(columns[0], 10);
            const left = Number.parseInt(columns[6], 10);
            const top = Number.parseInt(columns[7], 10);
            const width = Number.parseInt(columns[8], 10);
            const height = Number.parseInt(columns[9], 10);
            const confidence = Number.parseFloat(columns[10]);
            const text = columns.slice(11).join('\t').trim();

            if (level !== 5 || !text || confidence < minConfidence)
                continue;

            boxes.push({
                x: offsetX + left / scale,
                y: offsetY + top / scale,
                width: width / scale,
                height: height / scale,
                text,
            });
        }

        return boxes;
    }

    _makeSelectionKey(selection) {
        if (!selection)
            return null;

        return [
            Math.round(selection.x),
            Math.round(selection.y),
            Math.round(selection.width),
            Math.round(selection.height),
        ].join(':');
    }

    _deleteFile(path) {
        try {
            GLib.unlink(path);
        } catch (e) {
            log(`Failed to delete OCR temp file ${path}: ${e.message}`);
        }
    }

    _rebuildHitboxes(boxes, selection = null) {
        if (!this._hitboxLayer)
            return;

        this._hideCopyMenu();

        if (boxes.length === 0 || !selection)
            return;

        let fullText = '';
        let lastBox = null;
        for (const box of boxes) {
            if (lastBox) {
                if (box.y - lastBox.y > lastBox.height * 0.5) {
                    fullText += '\n';
                } else {
                    fullText += ' ';
                }
            }
            fullText += box.text;
            lastBox = box;
        }
        this._activeBoxText = fullText;

        const [, naturalWidth] = this._copyMenu.get_preferred_width(-1);
        const [, naturalHeight] = this._copyMenu.get_preferred_height(naturalWidth);

        const menuWidth = naturalWidth || 200;
        const menuHeight = naturalHeight || 44;

        const centerX = selection.x + selection.width / 2;
        const x = Math.max(
            12,
            Math.min(global.stage.width - menuWidth - 12, Math.round(centerX - menuWidth / 2))
        );
        const y = Math.max(
            12,
            Math.round(selection.y - menuHeight - 12)
        );

        this._copyMenu.set_position(x, y);
        this._copyMenu.visible = true;
        this._hitboxLayer.set_child_above_sibling(this._copyMenu, null);
    }

    _hideCopyMenu() {
        if (this._copyMenu)
            this._copyMenu.visible = false;
        this._activeBoxText = '';
    }

    _copyActiveBoxText() {
        if (!this._activeBoxText)
            return;

        // Copy OCR text for immediate paste.
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, this._activeBoxText);
        clipboard.set_text(St.ClipboardType.PRIMARY, this._activeBoxText);
        this._hideCopyMenu();
        Main.notify('Shotzy OCR', 'Copied OCR text');
    }

    _searchActiveBoxText() {
        if (!this._activeBoxText)
            return;

        const query = encodeURIComponent(this._activeBoxText);
        let url;
        
        switch (this._ocrConfig.searchEngine) {
        case 'bing':
            url = `https://www.bing.com/search?q=${query}`;
            break;
        case 'duckduckgo':
            url = `https://duckduckgo.com/?q=${query}`;
            break;
        case 'google':
        default:
            url = `https://www.google.com/search?q=${query}`;
            break;
        }
        
        try {
            Gio.app_info_launch_default_for_uri(url, null);
            this._hideCopyMenu();
            Main.screenshotUI?.close();
        } catch (e) {
            log(`[Shotzy OCR] Failed to open search URL: ${e.message}`);
        }
    }

    _cancelActiveSubprocess() {
        if (!this._subprocess)
            return;

        try {
            this._subprocess.force_exit();
        } catch (_e) {
        }

        this._subprocess = null;
    }

    _reloadSettings() {
        if (!this._settings) {
            this._style = DEFAULT_STYLE;
            this._ocrConfig = DEFAULT_OCR;
            return;
        }

        this._style = {
            fill: _parseColorSetting(this._settings.get_string('highlight-fill-color'), DEFAULT_STYLE.fill),
            border: _parseColorSetting(this._settings.get_string('highlight-border-color'), DEFAULT_STYLE.border),
            shadowOpacity: _clamp(this._settings.get_double('highlight-shadow-opacity'), 0, 0.75),
            glow: DEFAULT_STYLE.glow,
            radius: _clamp(this._settings.get_int('highlight-radius'), 0, 24),
            padding: _clamp(this._settings.get_int('highlight-padding'), 0, 24),
            borderWidth: _clamp(this._settings.get_double('highlight-border-width'), 0.5, 8),
        };

        this._ocrConfig = {
            enabled: this._settings.get_boolean('ocr-enabled'),
            confidence: _clamp(this._settings.get_int('selection-confidence'), 0, 99),
            maxEdge: _clamp(this._settings.get_int('selection-max-edge'), 800, 4096),
            searchEngine: this._settings.get_string('search-engine') || 'google',
        };
    }
}

function _roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 3 / 2);
    cr.closePath();
}

function _parseColorSetting(value, fallback) {
    const parts = value.split(',').map(Number.parseFloat);
    if (parts.length !== 4 || !parts.every(Number.isFinite))
        return fallback;

    return [
        _clamp(parts[0], 0, 1),
        _clamp(parts[1], 0, 1),
        _clamp(parts[2], 0, 1),
        _clamp(parts[3], 0, 1),
    ];
}

function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
