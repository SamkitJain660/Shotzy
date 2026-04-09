import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { LensUploader } from './uploader.js';

export default class GoogleLensExtension extends Extension {
    enable() {
        this._uploader = new LensUploader(this.path);
        this._lensButtonClickedId = 0;
        this._injectLensButton();
    }

    disable() {
        if (this._lensButton) {
            if (this._lensButtonClickedId) {
                this._lensButton.disconnect(this._lensButtonClickedId);
                this._lensButtonClickedId = 0;
            }
            this._lensButton.destroy();
            this._lensButton = null;
        }
        this._uploader = null;
    }

    _injectLensButton() {
        const ui = Main.screenshotUI;
        if (!ui || !ui._showPointerButtonContainer) return;
        this._addLensButton(ui._showPointerButtonContainer);
    }

    _addLensButton(container) {
        if (this._lensButton) return;
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
                console.error(`Google Lens Search: Error: ${e.message}`);
            });
        });
        container.add_child(this._lensButton);
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


            const filename = GLib.build_filenamev([GLib.get_tmp_dir(), `lens_${Date.now()}.png`]);
            
            if (pixbuf.savev(filename, 'png', [], [])) {
                Main.notify('Google Lens', 'Uploading screenshot...');
                this._uploader.upload(filename).catch(e => {
                    console.error(`Google Lens: Upload error: ${e.message}`);
                    Main.notify('Google Lens', `Upload failed: ${e.message}`);
                });
            }
        } catch (e) {
            console.error(`Google Search: Capture error: ${e.message}`);
            ui.close();
        }
    }
}
