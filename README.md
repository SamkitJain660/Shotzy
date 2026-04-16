# Shotzy

Image search on Google Lens and OCR directly from the built-in GNOME Screenshot tool.

[![Watch demo]()](https://github.com/user-attachments/assets/90a6394f-106a-43af-aaf4-62a27cb8a25f)

## Installation

### Dependency
Install **Tesseract OCR** and **zbar-tools** before proceeding
(if you wish to use OCR / QR scanning):
```bash
# Arch
sudo pacman -S tesseract tesseract-data-eng
sudo pacman -S zbar

# Ubuntu/Debian
sudo apt install tesseract-ocr
sudo apt install zbar-tools
```

---

### Manual Install
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/shotzy@SamkitJain660.github.io && \
wget -qO- https://github.com/SamkitJain660/Shotzy/archive/refs/heads/main.tar.gz | \
tar -xz --strip-components=1 -C ~/.local/share/gnome-shell/extensions/shotzy@SamkitJain660.github.io
```
Compile schemas:
```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/shotzy@SamkitJain660.github.io/schemas/
```
Then restart GNOME Shell and enable the extension:
```bash
gnome-extensions enable shotzy@SamkitJain660.github.io
```

---

### GNOME Extensions Portal
> 🕐 Pending approval on [extensions.gnome.org](https://extensions.gnome.org)
