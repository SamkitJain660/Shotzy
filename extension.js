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
import { deleteFile, savePixbufPrivately, tempFilePath } from './util.js';

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
        // Preferred width, not `this.width`: the latter is 0 before the first allocation.
        const [, tooltipWidth] = this.get_preferred_width(-1);
        const extents = widget.get_transformed_extents();
        const x = Math.floor(extents.get_x() + (extents.get_width() - tooltipWidth) / 2);
        const y = extents.get_y() + extents.get_height() + 6;

        this.remove_all_transitions();
        this.set_position(x, y);
        this.opacity = 0;
        this.show();
        // Use transition delay, not a timeout source.
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
        this._ocrController = new ScreenshotOCRController(
            this._settings,
            text => this._showScreenshotMessage(text)
        );
        this._lensButtonClickedId = 0;
        this._qrButtonClickedId = 0;
        this._settingsChangedId = 0;
        this._uiOpenOriginal = null;
        this._areaSelectorUpdateOriginal = null;
        this._uiClosedId = 0;
        this._areaSelectorDragEndedId = 0;
        this._tooltips = [];
        this._overlayMessage = null;
        this._overlayMessageTimeoutId = 0;

        this._hookScreenshotUI();
        this._injectLensButton();
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'show-google-lens-button' || key === 'show-qr-button')
                this._syncActionButtons();
        });
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

        // Reuse the QR-toggle teardown so the panel is reassembled the same way.
        this._restoreDefaultLayout(ui);

        // Before the buttons: a tooltip also self-destructs with its button.
        this._tooltips.forEach(tooltip => tooltip.destroy());
        this._tooltips = [];

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

        this._destroyOverlayMessage();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        this._ocrController?.destroy();
        this._ocrController = null;
        this._uploader?.destroy();
        this._uploader = null;
        this._settings = null;
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
                        console.error(`Shotzy: OCR start failed: ${e.message}`);
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
                    console.error(`Shotzy: OCR selection refine failed: ${e.message}`);
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

        if (!this._lensButton) {
            this._lensButton = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                child: new St.Icon({
                    icon_name: 'system-search-symbolic',
                    icon_size: 24,
                }),
                can_focus: true,
                accessible_name: 'Search with Google Lens',
            });
            this._lensButton.set_style('margin-left: 10px;');
            this._lensButtonClickedId = this._lensButton.connect('clicked', () => {
                this._handleLensClick().catch(e => {
                    console.error(`Shotzy search error: ${e.message}`);
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
                accessible_name: 'Scan QR code',
            });
            this._qrButton.set_style('margin-top: 10px;');
            this._qrButtonClickedId = this._qrButton.connect('clicked', () => {
                this._handleQRClick().catch(e => {
                    console.error(`Shotzy QR error: ${e.message}`);
                });
            });

            const qrTooltip = new Tooltip(this._qrButton, 'Scan QR Code');
            ui.add_child(qrTooltip);
            this._tooltips.push(qrTooltip);
        }

        this._syncActionButtons();
    }

    _syncActionButtons() {
        const ui = Main.screenshotUI;
        if (!ui || !ui._panel || !ui._showPointerButtonContainer)
            return;

        this._ensureButtonsAttached(ui);

        const showLensButton = this._settings?.get_boolean('show-google-lens-button') ?? true;
        const showQrButton = this._settings?.get_boolean('show-qr-button') ?? true;

        if (this._lensButton) {
            this._lensButton.visible = showLensButton;
            this._lensButton.reactive = showLensButton;
            this._lensButton.can_focus = showLensButton;
        }

        if (this._qrButton) {
            this._qrButton.visible = showQrButton;
            this._qrButton.reactive = showQrButton;
            this._qrButton.can_focus = showQrButton;
        }

        if (showQrButton)
            this._ensureQrLayout(ui);
        else
            this._restoreDefaultLayout(ui);
    }

    _ensureButtonsAttached(ui) {
        if (this._lensButton && this._lensButton.get_parent() !== ui._showPointerButtonContainer)
            ui._showPointerButtonContainer.add_child(this._lensButton);

        if (this._qrButton && this._lensSideBox && this._qrButton.get_parent() !== this._lensSideBox)
            this._lensSideBox.add_child(this._qrButton);
    }

    _ensureQrLayout(ui) {
        if (this._lensWrapper)
            return;

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

    _restoreDefaultLayout(ui) {
        if (!this._lensWrapper)
            return;

        const panel = ui?._panel ?? null;
        if (panel) {
            if (this._lensWrapper.get_parent() === panel)
                panel.remove_child(this._lensWrapper);

            const typeContainer = ui._typeButtonContainer;
            const bottomContainer = ui._bottomRowContainer;

            if (typeContainer && bottomContainer) {
                if (this._lensInnerVBox) {
                    if (typeContainer.get_parent() === this._lensInnerVBox)
                        this._lensInnerVBox.remove_child(typeContainer);
                    if (bottomContainer.get_parent() === this._lensInnerVBox)
                        this._lensInnerVBox.remove_child(bottomContainer);
                }

                if (!typeContainer.get_parent())
                    panel.add_child(typeContainer);
                if (!bottomContainer.get_parent())
                    panel.add_child(bottomContainer);
            }
        }

        if (this._qrButton && this._lensSideBox && this._qrButton.get_parent() === this._lensSideBox)
            this._lensSideBox.remove_child(this._qrButton);

        this._lensInnerVBox?.destroy();
        this._lensInnerVBox = null;
        this._lensSideBox?.destroy();
        this._lensSideBox = null;
        this._lensWrapper.destroy();
        this._lensWrapper = null;
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

            const filename = tempFilePath('shotzy');

            if (savePixbufPrivately(pixbuf, filename)) {
                Main.notify('Shotzy', 'Uploading screenshot...');
                this._uploader.upload(filename).catch(e => {
                    console.error(`Shotzy upload error: ${e.message}`);
                    Main.notify('Shotzy', `Upload failed: ${e.message}`);
                });
            } else {
                deleteFile(filename);
                Main.notify('Shotzy', 'Failed to prepare screenshot for upload.');
            }
        } catch (e) {
            console.error(`Shotzy capture error: ${e.message}`);
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
            this._showScreenshotMessage('Install zbar-tools to scan QR codes.');
            return;
        }

        const geometry = ui._getSelectedGeometry(true);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0) {
            this._showScreenshotMessage('Select an area to scan.');
            return;
        }
        const [x, y, w, h] = geometry;

        const content = ui._stageScreenshot?.get_content();
        if (!content) return;
        const texture = content.get_texture();

        const stream = Gio.MemoryOutputStream.new_resizable();
        const filename = tempFilePath('shotzy_qr');

        try {
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture,
                x, y, w, h,
                ui._scale,
                null, 0, 0, 1,
                stream
            );

            stream.close(null);

            if (savePixbufPrivately(pixbuf, filename)) {
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

                deleteFile(filename);

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
                deleteFile(filename);
                this._showScreenshotMessage('Failed to prepare selection for scanning.');
            }
        } catch (e) {
            console.error(`Shotzy QR scan error: ${e.message}`);
            deleteFile(filename);
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
        // Centre on the monitor the screenshot HUD is on, not across the whole stage.
        const extents = ui._panel?.get_transformed_extents();
        const monitor = _monitorForExtents(extents);
        const x = monitor
            ? Math.max(monitor.x + 12, Math.round(monitor.x + (monitor.width - naturalWidth) / 2))
            : Math.max(12, Math.round((global.stage.width - naturalWidth) / 2));
        const y = extents
            ? Math.max(12, Math.round(extents.get_y() - naturalHeight - 16))
            : (monitor?.y ?? 0) + 24;

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

function _monitorForExtents(extents) {
    const monitors = Main.layoutManager?.monitors ?? [];

    if (extents) {
        const centerX = extents.get_x() + extents.get_width() / 2;
        const centerY = extents.get_y() + extents.get_height() / 2;
        const found = monitors.find(monitor =>
            centerX >= monitor.x && centerX < monitor.x + monitor.width &&
            centerY >= monitor.y && centerY < monitor.y + monitor.height);

        if (found)
            return found;
    }

    return Main.layoutManager?.primaryMonitor ?? null;
}
