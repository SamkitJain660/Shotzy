import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ScreenshotOCRController } from './ocr.js';
import { LensUploader } from './uploader.js';

export default class ShotzyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._uploader = new LensUploader(this.path);
        this._ocrController = new ScreenshotOCRController(this._settings, this);
        this._lensButtonClickedId = 0;
        this._ocrButtonClickedId = 0;
        this._uiOpenOriginal = null;
        this._areaSelectorUpdateOriginal = null;
        this._uiClosedId = 0;
        this._areaSelectorDragEndedId = 0;

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
            this._lensWrapper.destroy();
            this._lensWrapper = null;
            this._lensInnerVBox = null;
            this._lensSideBox = null;
        }

        if (this._lensButton) {
            if (this._lensButtonClickedId) {
                this._lensButton.disconnect(this._lensButtonClickedId);
                this._lensButtonClickedId = 0;
            }
            this._lensButton.destroy();
            this._lensButton = null;
        }

        if (this._ocrButton) {
            if (this._ocrButtonClickedId) {
                this._ocrButton.disconnect(this._ocrButtonClickedId);
                this._ocrButtonClickedId = 0;
            }
            this._ocrButton.destroy();
            this._ocrButton = null;
        }

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
        }

        // 2. Side-bar buttons (Scanner)
        if (!this._ocrButton) {
            this._ocrButton = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                child: new St.Icon({
                    icon_name: 'document-properties-symbolic',
                    icon_size: 24,
                }),
                can_focus: true,
            });
            this._ocrButtonClickedId = this._ocrButton.connect('clicked', () => {
                this._handleOCRClick().catch(e => {
                    log(`Shotzy OCR error: ${e.message}`);
                });
            });
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

        this._lensSideBox.add_child(this._ocrButton);

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

    async _handleOCRClick() {
        const ui = Main.screenshotUI;
        if (!ui?._selectionButton?.checked) {
            Main.notify('Shotzy OCR', 'Switch to selection mode to rerun OCR.');
            return;
        }

        const geometry = ui._getSelectedGeometry(false);
        if (!geometry || geometry[2] <= 0 || geometry[3] <= 0)
            return;

        Main.notify('Shotzy OCR', 'Rerunning OCR on the selected area...');
        await this._ocrController.rerunSelection(ui);
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

            ui.close();

            const filename = GLib.build_filenamev([GLib.get_tmp_dir(), `shotzy_${Date.now()}.png`]);
            
            if (pixbuf.savev(filename, 'png', [], [])) {
                Main.notify('Shotzy', 'Uploading screenshot...');
                this._uploader.upload(filename).catch(e => {
                    log(`Shotzy upload error: ${e.message}`);
                    Main.notify('Shotzy', `Upload failed: ${e.message}`);
                });
            }
        } catch (e) {
            log(`Shotzy capture error: ${e.message}`);
            ui.close();
        }
    }
}
