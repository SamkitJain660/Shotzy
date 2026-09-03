import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TESSDATA_DIR,
    invalidateInstalledTesseractLanguages,
    listInstalledTesseractLanguages,
    normalizeLanguageSelection,
} from './util.js';

const COLOR_KEYS = {
    'highlight-fill-color': 'Fill color',
    'highlight-border-color': 'Border color',
};

const DEFAULTS = {
    'highlight-fill-color': '0.10,0.11,0.13,0.34',
    'highlight-border-color': '0.92,0.94,0.97,0.34',
};

export default class ShotzyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const dependencyState = this._getDependencyState();

        // Rescan on every window, so packs installed since the last one show up.
        invalidateInstalledTesseractLanguages();
        const tesseractLanguages = listInstalledTesseractLanguages();

        window.set_default_size(720, 640);

        const stylePage = new Adw.PreferencesPage({
            title: 'Highlighting',
            icon_name: 'preferences-desktop-theme-symbolic',
        });
        window.add(stylePage);

        const dependencyRow = this._createDependencyRow(dependencyState);
        if (dependencyRow) {
            const dependencyGroup = new Adw.PreferencesGroup();
            dependencyGroup.add(dependencyRow);
            stylePage.add(dependencyGroup);
        }

        const styleGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Controls for OCR highlight styling in the screenshot UI.',
        });
        stylePage.add(styleGroup);

        for (const [key, title] of Object.entries(COLOR_KEYS))
            styleGroup.add(this._createColorRow(settings, key, title));

        styleGroup.add(this._createSpinRow(settings, {
            key: 'highlight-padding',
            title: 'Box padding',
            subtitle: 'Extra room around each detected text box.',
            min: 0,
            max: 16,
            step: 1,
        }));
        styleGroup.add(this._createSpinRow(settings, {
            key: 'highlight-radius',
            title: 'Corner radius',
            subtitle: 'Roundedness of the highlight shape.',
            min: 0,
            max: 24,
            step: 1,
        }));
        styleGroup.add(this._createSpinRow(settings, {
            key: 'highlight-border-width',
            title: 'Border width',
            subtitle: 'Outline thickness of each highlight box.',
            min: 0.5,
            max: 4,
            step: 0.25,
            digits: 2,
            isDouble: true,
        }));
        styleGroup.add(this._createSpinRow(settings, {
            key: 'highlight-shadow-opacity',
            title: 'Shadow opacity',
            subtitle: 'Depth under the highlight boxes.',
            min: 0,
            max: 0.5,
            step: 0.01,
            digits: 2,
            isDouble: true,
        }));

        const ocrPage = new Adw.PreferencesPage({
            title: 'OCR',
            icon_name: 'accessories-text-editor-symbolic',
        });
        window.add(ocrPage);

        const ocrGroup = new Adw.PreferencesGroup({
            title: 'Recognition',
            description: 'Controls for the single selected-area OCR pass.',
        });
        ocrPage.add(ocrGroup);

        const enabledRow = new Adw.SwitchRow({
            title: 'Enable OCR highlighting',
            subtitle: 'Run OCR on the active screenshot selection and draw text highlights.',
        });
        settings.bind('ocr-enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        ocrGroup.add(enabledRow);

        ocrGroup.add(this._createSpinRow(settings, {
            key: 'selection-confidence',
            title: 'OCR confidence',
            subtitle: 'Lower values catch more text but increase false positives.',
            min: 0,
            max: 95,
            step: 1,
        }));
        ocrGroup.add(this._createSpinRow(settings, {
            key: 'selection-max-edge',
            title: 'OCR max edge',
            subtitle: 'Higher values improve selected-area accuracy but cost more CPU.',
            min: 1000,
            max: 4000,
            step: 100,
        }));
        ocrGroup.add(this._createLanguageRow(settings, tesseractLanguages));

        const closeAfterCopyRow = new Adw.SwitchRow({
            title: 'Close after copying',
            subtitle: 'Close the screenshot tool automatically once OCR text is copied.',
        });
        settings.bind('close-after-copy', closeAfterCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        ocrGroup.add(closeAfterCopyRow);

        const searchPage = new Adw.PreferencesPage({
            title: 'Search',
            icon_name: 'system-search-symbolic',
        });
        window.add(searchPage);

        const searchGroup = new Adw.PreferencesGroup({
            title: 'Search Settings',
            description: 'Configure how search results are handled.',
        });
        searchPage.add(searchGroup);

        const searchEngineRow = new Adw.ComboRow({
            title: 'Search Engine',
            subtitle: 'Preferred engine for looking up OCR text.',
            model: new Gtk.StringList({
                strings: ['Google', 'Bing', 'DuckDuckGo', 'Kagi'],
            }),
        });

        const engines = ['google', 'bing', 'duckduckgo', 'kagi'];
        const currentEngine = settings.get_string('search-engine');
        searchEngineRow.selected = Math.max(0, engines.indexOf(currentEngine));

        searchEngineRow.connect('notify::selected', () => {
            settings.set_string('search-engine', engines[searchEngineRow.selected]);
        });

        searchGroup.add(searchEngineRow);

        const actionsGroup = new Adw.PreferencesGroup({
            title: 'Screenshot Actions',
            description: 'Choose which extra buttons appear in the screenshot UI.',
        });
        searchPage.add(actionsGroup);

        const lensButtonRow = new Adw.SwitchRow({
            title: 'Show Google Lens button',
            subtitle: 'Display the Google Lens upload button beside the screenshot controls.',
        });
        settings.bind('show-google-lens-button', lensButtonRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        actionsGroup.add(lensButtonRow);

        const qrButtonRow = new Adw.SwitchRow({
            title: 'Show QR code button',
            subtitle: 'Display the QR scanning button in the screenshot controls.',
        });
        settings.bind('show-qr-button', qrButtonRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        actionsGroup.add(qrButtonRow);

        window._settings = settings;
    }

    _getDependencyState() {
        const dependencies = [
            {
                program: 'tesseract',
            },
            {
                program: 'zbarimg',
            },
        ].map(item => ({
            ...item,
            available: Boolean(GLib.find_program_in_path(item.program)),
        }));

        return {
            dependencies,
            missing: dependencies.filter(item => !item.available),
        };
    }

    _createDependencyRow({dependencies, missing}) {
        if (missing.length === 0)
            return null;

        const missingFeatures = [];
        if (missing.some(item => item.program === 'tesseract'))
            missingFeatures.push('OCR highlighting');
        if (missing.some(item => item.program === 'zbarimg'))
            missingFeatures.push('QR scanning');

        const tooltipLines = [
            'Runtime Dependencies',
            ...dependencies.map(item => `${item.program}: ${item.available ? 'Available' : 'Missing'}`),
        ];

        const row = new Adw.ActionRow({
            title: `Optional tool missing: ${missing.map(item => item.program).join(', ')}`,
            subtitle: `Install to enable ${missingFeatures.join(' and ')}.`,
            tooltip_text: tooltipLines.join('\n'),
        });
        row.add_prefix(new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        }));

        row.add_suffix(new Gtk.Image({
            icon_name: 'help-about-symbolic',
            tooltip_text: tooltipLines.join('\n'),
            valign: Gtk.Align.CENTER,
        }));

        return row;
    }

    _createLanguageRow(settings, installedLanguages) {
        if (installedLanguages.length === 0) {
            const row = new Adw.ActionRow({
                title: 'OCR languages',
                subtitle: `No Tesseract language data in ${TESSDATA_DIR}. ` +
                    'Install a language pack, or point TESSDATA_PREFIX at it.',
            });
            row.add_prefix(new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            return row;
        }

        const row = new Adw.ExpanderRow({
            title: 'OCR languages',
            subtitle: `Detected in ${TESSDATA_DIR}.`,
        });

        const switches = new Map();
        const updateRows = () => {
            const selected = new Set(normalizeLanguageSelection(settings.get_strv('ocr-languages'), installedLanguages));

            for (const [code, switchRow] of switches)
                switchRow.active = selected.has(code);
        };

        for (const language of installedLanguages) {
            const switchRow = new Adw.SwitchRow({
                title: language,
            });
            switchRow.active = normalizeLanguageSelection(
                settings.get_strv('ocr-languages'),
                installedLanguages
            ).includes(language);

            switchRow.connect('notify::active', () => {
                const selected = new Set(normalizeLanguageSelection(settings.get_strv('ocr-languages'), installedLanguages));
                if (switchRow.active)
                    selected.add(language);
                else
                    selected.delete(language);

                settings.set_strv('ocr-languages', normalizeLanguageSelection([...selected], installedLanguages));
            });

            switches.set(language, switchRow);
            row.add_row(switchRow);
        }

        settings.connect('changed::ocr-languages', updateRows);
        updateRows();
        return row;
    }

    _createColorRow(settings, key, title) {
        const row = new Adw.ActionRow({
            title,
            subtitle: 'Alpha is supported. Changes apply immediately.',
        });

        const button = new Gtk.ColorButton({
            use_alpha: true,
            rgba: _rgbaFromSetting(settings.get_string(key), DEFAULTS[key]),
            valign: Gtk.Align.CENTER,
        });
        button.connect('notify::rgba', () => {
            settings.set_string(key, _rgbaToSetting(button.get_rgba()));
        });

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to default',
            valign: Gtk.Align.CENTER,
        });
        reset.connect('clicked', () => {
            settings.reset(key);
            button.set_rgba(_rgbaFromSetting(settings.get_string(key), DEFAULTS[key]));
        });

        row.add_suffix(reset);
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _createSpinRow(settings, {
        key,
        title,
        subtitle,
        min,
        max,
        step,
        digits = 0,
        isDouble = false,
    }) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step,
            }),
            digits,
        });

        row.set_value(isDouble ? settings.get_double(key) : settings.get_int(key));
        row.connect('notify::value', () => {
            if (isDouble)
                settings.set_double(key, row.get_value());
            else
                settings.set_int(key, Math.round(row.get_value()));
        });

        return row;
    }
}

function _rgbaFromSetting(value, fallback) {
    const rgba = new Gdk.RGBA();
    const source = (value || fallback).split(',').map(Number.parseFloat);
    const [red, green, blue, alpha] = source.length === 4 && source.every(Number.isFinite)
        ? source
        : fallback.split(',').map(Number.parseFloat);

    rgba.red = red;
    rgba.green = green;
    rgba.blue = blue;
    rgba.alpha = alpha;
    return rgba;
}

function _rgbaToSetting(rgba) {
    return [
        rgba.red.toFixed(3),
        rgba.green.toFixed(3),
        rgba.blue.toFixed(3),
        rgba.alpha.toFixed(3),
    ].join(',');
}
