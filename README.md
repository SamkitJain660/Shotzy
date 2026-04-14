# Shotzy

Image search on Google Lens and OCR directly from the built-in GNOME Screenshot tool.

[![Watch demo](./thumbnail.png)](https://github.com/user-attachments/assets/90a6394f-106a-43af-aaf4-62a27cb8a25f)
## Features
* **Google Lens Integration**: One-click upload of any screenshot selection to Google Lens.
* **Smart OCR Overlay**: Automatically detects and highlights text in your screenshots.
* **Copy & Search**: Click on highlighted text to copy it to your clipboard or search for it using your favorite search engine (Google, Bing, or DuckDuckGo).
* **Fully Customizable**: Adjust highlight styles, colors, and OCR confidence in the settings.

## Installation
1. Install Tesseract OCR: `sudo apt install tesseract-ocr` (or equivalent for your distro).
2. Copy this folder to `~/.local/share/gnome-shell/extensions/shotzy@SamkitJain660.github.io`
3. Restart GNOME Shell (or log out and back in).
4. Enable the extension using Extensions app or:
   `gnome-extensions enable shotzy@SamkitJain660.github.io`

## Configuration
Access settings via the Extensions app or:
`gnome-extensions prefs shotzy@SamkitJain660.github.io`
