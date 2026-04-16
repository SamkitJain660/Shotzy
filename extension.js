import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ScreenshotOCRController } from './ocr.js';
import { LensUploader } from './uploader.js';

const Tooltip = GObject.registerClass(
class Tooltip extends St.Label {
    _init(widget, text) {
        super._init({
            text,
            style_class: 'screenshot-ui-tooltip',
            visible: false,
        });

        this._widget = widget;

        // Auto-disconnect tooltip signals with connectObject.
        widget.connectObject('notify::hover', () => {
            if (widget.hover)
                this._show(widget);
            else
                this._hide();
        }, this);

        // Destroy tooltip when its owner disappears.
        widget.connectObject('destroy', () => this.destroy(), this);
    }

    _show(widget) {
        // Use transition delay, not timeout source.
        const extents = widget.get_transformed_extents();
        const x = Math.floor(extents.get_x() + (extents.get_width() - this.width) / 2);
        const y = extents.get_y() + extents.get_height() + 6;

        this.remove_all_transitions();
        this.set_position(x, y);
        this.opacity = 0;
        this.show();
        this.ease({
            opacity: 255,
            delay: 500,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide() {
        this.remove_all_transitions();
        this.hide();
    }

    vfunc_destroy() {
        this._hide();
        this._widget = null;

        super.vfunc_destroy();
    }
});

export default class ShotzyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._uploader = new LensUploader();
        this._ocrController = new ScreenshotOCRController(this._settings);
        this._lensButtonClickedId = 0;
        this._qrButtonClickedId = 0;
        this._uiOpenOriginal = null;
        this._areaSelectorUpdateOriginal = null;
        this._uiClosedId = 0;
        this._areaSelectorDragEndedId = 0;
        this._tooltips = [];
        this._overlayMessage = null;
        this._overlayMessageTimeoutId = 0;

        this._hookScreenshotUI();
        this._injectLensButton();
    }

    disable() {
        const ui = Main.screenshotUI;
        
        if (ui) {
            if (this._uiClosedId) {
                ui.disconnect(this._uiClosedId);
                this._uiClosedId = 0;
            }
            if (ui._areaSelector && this._areaSelectorDragEndedId) {
                ui._areaSelector.disconnect(this._areaSelectorDragEndedId);
                this._areaSelectorDragEndedId = 0;
            }
            this._unhookScreenshotUI(ui);
        }

        if (this._lensWrapper) {
            if (ui && ui._panel) {
                ui._panel.remove_child(this._lensWrapper);
                
                if (ui._typeButtonContainer && ui._bottomRowContainer) {
                    if (this._lensInnerVBox) {
                        this._lensInnerVBox.remove_child(ui._typeButtonContainer);
                        this._lensInnerVBox.remove_child(ui._bottomRowContainer);
                    }
                    ui._panel.add_child(ui._typeButtonContainer);
                    ui._panel.add_child(ui._bottomRowContainer);
                }
            }
            this._lensInnerVBox?.destroy();
            this._lensInnerVBox = null;
            this._lensSideBox?.destroy();
            this._lensSideBox = null;
            this._lensWrapper.destroy();
            this._lensWrapper = null;
        }

        if (this._lensButton) {
            if (this._lensButtonClickedId) {
                this._lensButton.disconnect(this._lensButtonClickedId);
                this._lensButtonClickedId = 0;
            }
            this._lensButton.destroy();
            this._lensButton = null;
        }

        if (this._qrButton) {
            if (this._qrButtonClickedId) {
                this._qrButton.disconnect(this._qrButtonClickedId);
                this._qrButtonClickedId = 0;
            }
            this._qrButton.destroy();
            this._qrButton = null;
        }

        if (this._tooltips) {
            this._tooltips.forEach(t => t.destroy());
            this._tooltips = [];
        }

        this._destroyOverlayMessage();

        this._ocrController?.destroy();
        this._ocrController = null;
        this._settings = null;
        this._uploader = null;
    }

    _hookScreenshotUI() {
        const ui = Main.screenshotUI;
        if (!ui)
            return;

        this._ocrController.ensureAttached(ui);

        if (!this._uiOpenOriginal) {
            this._uiOpenOriginal = ui.open;
            ui.open = async (...args) => {
                const result = await this._uiOpenOriginal.apply(ui, args);

                if (ui._shotButton?.checked) {
                    this._ocrController.start(ui).catch(e => {
                        log(`Shotzy: OCR start failed: ${e.message}`);
                    });
                } else {
                    this._ocrController.reset();
                }

                return result;
            };
        }

        if (ui._areaSelector && !this._areaSelectorUpdateOriginal) {
            this._areaSelectorUpdateOriginal = ui._areaSelector._updateSelectionRect;
            ui._areaSelector._updateSelectionRect = (...args) => {
                const result = this._areaSelectorUpdateOriginal.apply(ui._areaSelector, args);
                this._ocrController.refreshSelection(ui);
                return result;
            };
        }

        if (!this._uiClosedId) {
            this._uiClosedId = ui.connect('closed', () => {
                this._ocrController.reset();
            });
        }

        if (ui._areaSelector && !this._areaSelectorDragEndedId) {
            this._areaSelectorDragEndedId = ui._areaSelector.connect('drag-ended', () => {
                this._ocrController.refineSelection(ui).catch(e => {
                    log(`Shotzy: OCR selection refine failed: ${e.message}`);
                });
            });
        }
    }

    _unhookScreenshotUI(ui) {
        if (this._uiOpenOriginal) {
            ui.open = this._uiOpenOriginal;
            this._uiOpenOriginal = null;
        }
        if (ui._areaSelector && this._areaSelectorUpdateOriginal) {
            ui._areaSelector._updateSelectionRect = this._areaSelectorUpdateOriginal;
            this._areaSelectorUpdateOriginal = null;
        }
    }

    _injectLensButton() {
        const ui = Main.screenshotUI;
        if (!ui || !ui._panel || !ui._showPointerButtonContainer) return;

        // 1. Lens button next to show pointer button (bottom row)
        if (!this._lensButton) {
            this._lensButton = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                child: new St.Icon({
                    icon_name: 'system-search-symbolic',
                    icon_size: 24,
                }),
                can_focus: true,
            });
            this._lensButton.set_style('margin-left: 10px;');
            this._lensButtonClickedId = this._lensButton.connect('clicked', () => {
                this._handleLensClick().catch(e => {
                    log(`Shotzy Search error: ${e.message}`);
                });
            });
            ui._showPointerButtonContainer.add_child(this._lensButton);

            const lensTooltip = new Tooltip(this._lensButton, 'Search with Google Lens');
            ui.add_child(lensTooltip);
            this._tooltips.push(lensTooltip);
        }

        if (!this._qrButton) {
            this._qrButton = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                child: new St.Icon({
                    icon_name: 'view-grid-symbolic',
                    icon_size: 24,
                }),
                can_focus: true,
            });
            this._qrButton.set_style('margin-top: 10px;');
            this._qrButtonClickedId = this._qrButton.connect('clicked', () => {
                this._handleQRClick().catch(e => {
                    log(`Shotzy QR error: ${e.message}`);
                });
            });

            const qrTooltip = new Tooltip(this._qrButton, 'Scan QR Code');
            ui.add_child(qrTooltip);
            this._tooltips.push(qrTooltip);
        }

        if (this._lensWrapper) return;

        this._lensWrapper = new Clutter.Actor({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
            }),
        });

        this._lensInnerVBox = new Clutter.Actor({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
            }),
        });

        this._lensSideBox = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lensSideBox.set_style('margin-left: 16px; padding-left: 16px; border-left: 1px solid rgba(255,255,255,0.2);');

        this._lensSideBox.add_child(this._qrButton);

        const typeContainer = ui._typeButtonContainer;
        const bottomContainer = ui._bottomRowContainer;
        
        if (typeContainer && bottomContainer) {
            ui._panel.remove_child(typeContainer);
            ui._panel.remove_child(bottomContainer);

            this._lensInnerVBox.add_child(typeContainer);
            this._lensInnerVBox.add_child(bottomContainer);

            this._lensWrapper.add_child(this._lensInnerVBox);
            this._lensWrapper.add_child(this._lensSideBox);

            ui._panel.add_child(this._lensWrapper);
        }
    }

    async _handleLensClick() {
        const ui = Main.screenshotUI;

        const geometry = ui._getSelectedGeometry(true);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0) {
            return;
        }
        const [x, y, w, h] = geometry;

        const content = ui._stageScreenshot?.get_content();
        if (!content) return;
        const texture = content.get_texture();

        const stream = Gio.MemoryOutputStream.new_resizable();
        
        try {
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture,
                x, y, w, h,
                ui._scale,
                null, 0, 0, 1,
                stream
            );
            stream.close(null);

            ui.close();

            const filename = GLib.build_filenamev([GLib.get_tmp_dir(), `shotzy_${Date.now()}.png`]);
            
            if (pixbuf.savev(filename, 'png', [], [])) {
                Main.notify('Shotzy', 'Uploading screenshot...');
                this._uploader.upload(filename).catch(e => {
                    log(`Shotzy upload error: ${e.message}`);
                    Main.notify('Shotzy', `Upload failed: ${e.message}`);
                });
            } else {
                if (GLib.file_test(filename, GLib.FileTest.EXISTS))
                    GLib.unlink(filename);
                Main.notify('Shotzy', 'Failed to prepare screenshot for upload.');
            }
        } catch (e) {
            log(`Shotzy capture error: ${e.message}`);
            ui.close();
        }
    }

    async _handleQRClick() {
        const ui = Main.screenshotUI;
        if (!ui?._selectionButton?.checked) {
            Main.notify('Shotzy QR', 'Switch to selection mode to scan QR.');
            return;
        }

        if (!GLib.find_program_in_path('zbarimg')) {
            return;
        }

        const geometry = ui._getSelectedGeometry(true);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0) {
            return;
        }
        const [x, y, w, h] = geometry;

        const content = ui._stageScreenshot?.get_content();
        if (!content) return;
        const texture = content.get_texture();

        const stream = Gio.MemoryOutputStream.new_resizable();
        const filename = GLib.build_filenamev([GLib.get_tmp_dir(), `shotzy_qr_${Date.now()}.png`]);

        try {
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture,
                x, y, w, h,
                ui._scale,
                null, 0, 0, 1,
                stream
            );

            stream.close(null);

            if (pixbuf.savev(filename, 'png', [], [])) {
                const subprocess = Gio.Subprocess.new(
                    ['zbarimg', '--quiet', '--raw', filename],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                const [stdout, stderr] = await new Promise((resolve, reject) => {
                    subprocess.communicate_utf8_async(null, null, (proc, res) => {
                        try {
                            const [, out, err] = proc.communicate_utf8_finish(res);
                            resolve([out, err]);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

                GLib.unlink(filename);

                const result = stdout ? stdout.trim() : null;
                if (result) {
                    // Copy decoded QR content for reuse.
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, result);
                    Main.notify('Shotzy QR', 'Content copied to clipboard.');
                    ui.close();
                } else {
                    this._showScreenshotMessage('No QR code found in selection.');
                }
            } else {
                if (GLib.file_test(filename, GLib.FileTest.EXISTS))
                    GLib.unlink(filename);
                this._showScreenshotMessage('Failed to prepare selection for scanning.');
            }
        } catch (e) {
            log(`Shotzy QR scan error: ${e.message}`);
            if (GLib.file_test(filename, GLib.FileTest.EXISTS))
                GLib.unlink(filename);
            this._showScreenshotMessage(`QR scan failed: ${e.message}`);
        }
    }

    _showScreenshotMessage(text) {
        const ui = Main.screenshotUI;
        if (!ui)
            return;

        if (!this._overlayMessage) {
            this._overlayMessage = new St.Label({
                visible: false,
                opacity: 0,
                reactive: false,
                style: `
                    background-color: rgba(28, 30, 34, 0.96);
                    color: white;
                    padding: 10px 14px;
                    border-radius: 999px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    font-weight: 600;
                `,
            });
        }

        if (this._overlayMessage.get_parent() !== ui) {
            this._overlayMessage.get_parent()?.remove_child(this._overlayMessage);
            ui.add_child(this._overlayMessage);
        }

        if (this._overlayMessageTimeoutId) {
            GLib.source_remove(this._overlayMessageTimeoutId);
            this._overlayMessageTimeoutId = 0;
        }

        this._overlayMessage.remove_all_transitions();
        this._overlayMessage.set_text(text);
        this._overlayMessage.opacity = 0;
        this._overlayMessage.show();

        const [, naturalWidth] = this._overlayMessage.get_preferred_width(-1);
        const [, naturalHeight] = this._overlayMessage.get_preferred_height(naturalWidth);
        const extents = ui._panel?.get_transformed_extents();
        const x = Math.max(12, Math.round((global.stage.width - naturalWidth) / 2));
        const y = extents
            ? Math.max(12, Math.round(extents.get_y() - naturalHeight - 16))
            : 24;

        this._overlayMessage.set_position(x, y);
        this._overlayMessage.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._overlayMessageTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._overlayMessageTimeoutId = 0;

            if (!this._overlayMessage)
                return GLib.SOURCE_REMOVE;

            this._overlayMessage.ease({
                opacity: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._overlayMessage?.hide(),
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyOverlayMessage() {
        if (this._overlayMessageTimeoutId) {
            GLib.source_remove(this._overlayMessageTimeoutId);
            this._overlayMessageTimeoutId = 0;
        }

        if (this._overlayMessage) {
            this._overlayMessage.destroy();
            this._overlayMessage = null;
        }
    }
}
